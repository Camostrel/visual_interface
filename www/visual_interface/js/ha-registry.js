/**
 * Чтение сырых данных Home Assistant через WebSocket.
 * Сложной нормализации здесь нет: frontend использует entity_id, friendly_name и attributes.
 * v0.8.2: экспериментальный sessionStorage-кэш удалён, чтобы данные всегда были предсказуемо свежими.
 *
 * v0.11.0 — ИНДЕКСЫ (долг D20). Раньше резолв был линейным:
 *   getEntitiesForArea()   = states.filter(...)   O(N) по всему реестру
 *   getEntitiesForDevice() = states.filter(...)   O(N) — и звался В ЦИКЛЕ по датчикам → O(N²)
 *   updateStateFromEvent() = states.findIndex()   O(N) на КАЖДОЕ событие HA
 * На объекте (~4400 сущностей) это пересчитывалось на каждое показание люкс-датчика.
 * Теперь area_id → сущности и device_id → сущности лежат в Map, резолв — O(1).
 *
 * ⚠ Индексы строятся по РЕЕСТРУ (entity/device registry), а не по states: принадлежность
 * области — свойство реестра. Сущность без записи в реестре area не имеет (так было и раньше).
 */
class ArvidHaRegistry {
  constructor(ha) {
    this.ha = ha;
    this.logArea = "ha-registry";
    this.floors = [];
    this.areas = [];
    this.entities = [];
    this.devices = [];
    this.states = [];
    this.entityById = new Map();
    this.stateById = new Map();
    this.deviceById = new Map();

    // Индексы (v0.11.0): строятся в applyData, живут до перезагрузки реестров.
    this.entityIdsByArea = new Map();     // area_id  → Set(entity_id)
    this.entityIdsByDevice = new Map();   // device_id → Set(entity_id)

    // Подписчики на изменение СОСТАВА (сущность появилась/исчезла, реестр перечитан) — D5.
    // Состав меняется редко, поэтому здесь допустима полная перерисовка страниц.
    this._compositionHandlers = new Set();
  }

  async loadAll() {
    ARVID_LOG.info(this.logArea, "Loading HA floors, areas, registries and states");

    const [floors, areas, entities, devices, states] = await Promise.all([
      this.ha.send({ type: "config/floor_registry/list" }),
      this.ha.send({ type: "config/area_registry/list" }),
      this.ha.send({ type: "config/entity_registry/list" }),
      this.ha.send({ type: "config/device_registry/list" }),
      this.ha.send({ type: "get_states" }),
    ]);

    this.applyData({ floors, areas, entities, devices, states });

    ARVID_LOG.info(this.logArea, "HA data loaded", {
      floors: this.floors.length,
      areas: this.areas.length,
      entities: this.entities.length,
      devices: this.devices.length,
      states: this.states.length,
    });

    return this;
  }

  applyData(data) {
    this.floors = data.floors || [];
    this.areas = data.areas || [];
    this.entities = data.entities || [];
    this.devices = data.devices || [];
    this.states = data.states || [];

    this.entityById = new Map(this.entities.map((entity) => [entity.entity_id, entity]));
    this.stateById = new Map(this.states.map((state) => [state.entity_id, state]));
    this.deviceById = new Map(this.devices.map((device) => [device.id, device]));

    this.buildIndexes();
  }

  /**
   * Индексы area/device. Пересобираются только при перезагрузке реестров —
   * поток state_changed их не трогает (состояние не меняет принадлежность области).
   */
  buildIndexes() {
    this.entityIdsByArea = new Map();
    this.entityIdsByDevice = new Map();

    this.entities.forEach((entity) => {
      const entityId = entity.entity_id;

      if (entity.device_id) {
        ArvidHaRegistry.addTo(this.entityIdsByDevice, entity.device_id, entityId);
      }

      const areaId = this.resolveAreaId(entity);
      if (areaId) ArvidHaRegistry.addTo(this.entityIdsByArea, areaId, entityId);
    });

    ARVID_LOG.debug(this.logArea, "Индексы реестра построены", {
      areas: this.entityIdsByArea.size,
      devices: this.entityIdsByDevice.size,
    });
  }

  static addTo(map, key, value) {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  }

  // Область сущности: своя, иначе — область её устройства (правило HA).
  resolveAreaId(entity) {
    if (!entity) return null;
    if (entity.area_id) return entity.area_id;
    if (entity.device_id) return this.deviceById.get(entity.device_id)?.area_id || null;
    return null;
  }

  getState(entityId) {
    return this.stateById.get(entityId) || null;
  }

  getFriendlyName(entityId) {
    const state = this.getState(entityId);
    const registry = this.entityById.get(entityId);
    return state?.attributes?.friendly_name || registry?.name || entityId;
  }

  getDeviceId(entityId) {
    return this.entityById.get(entityId)?.device_id || null;
  }

  getDevice(entityId) {
    const deviceId = this.getDeviceId(entityId);
    return deviceId ? this.deviceById.get(deviceId) || null : null;
  }

  // Модель устройства из реестра HA. У DALI-групп ядро ставит model = "DALI Group".
  getDeviceModel(entityId) {
    return this.getDevice(entityId)?.model || null;
  }

  // Все сущности одного физического устройства (нужно для пары ms_/il_ одного датчика).
  getEntitiesForDevice(deviceId) {
    if (!deviceId) return [];
    return this.statesOf(this.entityIdsByDevice.get(deviceId));
  }

  getAreaForEntity(entityId) {
    return this.resolveAreaId(this.entityById.get(entityId));
  }

  getEntitiesForArea(areaId) {
    if (!areaId) return [];
    return this.statesOf(this.entityIdsByArea.get(areaId));
  }

  /** Set(entity_id) → массив состояний (сущности без состояния молча пропускаем). */
  statesOf(entityIds) {
    if (!entityIds) return [];
    const result = [];
    entityIds.forEach((entityId) => {
      const state = this.stateById.get(entityId);
      if (state) result.push(state);
    });
    return result;
  }

  /**
   * Состав изменился: сущность появилась/исчезла или реестр перечитан (D5).
   * Отдельно от state_changed: обычное изменение значения состав не меняет и
   * перерисовки DOM не требует (инвариант v0.6.0).
   */
  addCompositionHandler(handler) {
    if (typeof handler === "function") this._compositionHandlers.add(handler);
  }

  notifyComposition(reason) {
    ARVID_LOG.info(this.logArea, "Состав сущностей изменился", { reason });
    this._compositionHandlers.forEach((handler) => {
      try {
        handler(reason);
      } catch (error) {
        ARVID_LOG.error(this.logArea, "Обработчик изменения состава упал", error);
      }
    });
  }

  /**
   * Обновление состояния из события. O(1): правим Map и элемент массива по индексу.
   *
   * Два особых случая, которых раньше не было:
   *  - new_state = null — сущность УДАЛЕНА. Раньше выходили по `if (!newState) return`,
   *    и мёртвая запись жила в реестре вечно.
   *  - сущность появилась впервые — её нет в entity registry, значит нет и в индексах:
   *    area не резолвится. Поэтому просим перечитать реестры (D5).
   */
  updateStateFromEvent(event) {
    const entityId = event?.data?.entity_id;
    if (!entityId) return;

    const newState = event?.data?.new_state;

    if (!newState) {
      this.removeEntityState(entityId);
      return;
    }

    const isNew = !this.stateById.has(entityId);
    this.stateById.set(entityId, newState);

    if (isNew) {
      this.states.push(newState);
      // Новой сущности нет в реестре → её area/device неизвестны. Перечитываем реестры.
      this.scheduleRegistryReload("появилась сущность");
      return;
    }

    const index = this.states.findIndex((state) => state.entity_id === entityId);
    if (index >= 0) this.states[index] = newState;

    ARVID_LOG.debug(this.logArea, "State updated from event", {
      entityId,
      state: newState.state,
    });
  }

  removeEntityState(entityId) {
    if (!this.stateById.delete(entityId)) return;

    const index = this.states.findIndex((state) => state.entity_id === entityId);
    if (index >= 0) this.states.splice(index, 1);

    // Из индексов сущность убираем сразу: иначе она осталась бы «фантомом» в составе комнаты.
    this.entityIdsByArea.forEach((set) => set.delete(entityId));
    this.entityIdsByDevice.forEach((set) => set.delete(entityId));

    ARVID_LOG.info(this.logArea, "Сущность удалена из реестра", { entityId });
    this.notifyComposition("сущность удалена");
  }

  /**
   * Перечитать реестры (сущности/устройства/области/этажи) и пересобрать индексы.
   * Дебаунс: HA при перенастройке шлёт пачку событий, а перечитывание — 4 запроса.
   */
  scheduleRegistryReload(reason) {
    if (this._reloadTimer) return;

    this._reloadTimer = window.setTimeout(() => {
      this._reloadTimer = null;
      this.reloadRegistries(reason).catch((error) => {
        ARVID_LOG.error(this.logArea, "Не удалось перечитать реестры HA", error);
      });
    }, ArvidHaRegistry.REGISTRY_RELOAD_DEBOUNCE_MS);
  }

  static get REGISTRY_RELOAD_DEBOUNCE_MS() {
    return 1500;
  }

  async reloadRegistries(reason) {
    ARVID_LOG.info(this.logArea, "Перечитываем реестры HA", { reason });

    const [floors, areas, entities, devices] = await Promise.all([
      this.ha.send({ type: "config/floor_registry/list" }),
      this.ha.send({ type: "config/area_registry/list" }),
      this.ha.send({ type: "config/entity_registry/list" }),
      this.ha.send({ type: "config/device_registry/list" }),
    ]);

    // states не трогаем: они живут потоком state_changed и свежее любого снимка.
    this.floors = floors || [];
    this.areas = areas || [];
    this.entities = entities || [];
    this.devices = devices || [];

    this.entityById = new Map(this.entities.map((entity) => [entity.entity_id, entity]));
    this.deviceById = new Map(this.devices.map((device) => [device.id, device]));

    this.buildIndexes();
    this.notifyComposition(reason);
  }

  /**
   * Подписка на изменения реестров HA (v0.11.0, D5).
   * Устройство переименовали, задали ему area, добавили новое — интерфейс должен это увидеть
   * без перезагрузки страницы. Раньше состав комнаты застывал до смены комнаты.
   */
  async subscribeRegistryUpdates() {
    const events = [
      "entity_registry_updated",
      "device_registry_updated",
      "area_registry_updated",
      "floor_registry_updated",
    ];

    await Promise.all(events.map((eventType) => this.ha
      .subscribeCommand(
        { type: "subscribe_events", event_type: eventType },
        () => this.scheduleRegistryReload(eventType),
      )
      .catch((error) => {
        ARVID_LOG.warn(this.logArea, `Подписка на ${eventType} не удалась`, error);
      })));

    ARVID_LOG.info(this.logArea, "Подписка на изменения реестров HA включена");
  }
}

window.ArvidHaRegistry = ArvidHaRegistry;
