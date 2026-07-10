/**
 * Общие runtime-данные SPA.
 * Данные Home Assistant загружаем один раз и переиспользуем между views.
 */
window.ARVID_APP = {
  ha: null,
  storage: null,
  registry: null,
  layout: null,
  health: null,
  currentFloorId: null,
  currentAreaId: null,

  /**
   * СОСТАВ комнаты — истина из Home Assistant (v0.7.0).
   * Только сущности с этим area_id (напрямую или через устройство).
   * По этому списку считаются карточки, счётчики «N/N включено» и статистика комнаты.
   */
  entitiesForArea(areaId) {
    if (!this.registry || !areaId) return [];
    return this.registry.getEntitiesForArea(areaId);
  },

  /**
   * РАЗМЕЩЁННЫЕ на плане этой комнаты (наш layout: координаты + area_id).
   * По этому списку рисуются маркеры. Устройство может быть размещено здесь,
   * но НЕ иметь HA-area — тогда оно помечается как непривязанное (см. room-page).
   */
  placedEntitiesForRoom(areaId) {
    if (!this.registry || !areaId) return [];

    const devices = this.layout?.devices || {};
    const result = [];
    Object.keys(devices).forEach((entityId) => {
      if (devices[entityId]?.area_id !== areaId) return;
      const state = this.registry.getState(entityId);
      if (state) result.push(state);
    });
    return result;
  },

  /**
   * Объединение состава и размещённых — нужно только для подписки на изменения
   * (какие события считать «своими»), но НЕ для состава комнаты.
   */
  entitiesForRoom(areaId) {
    const result = new Map();
    this.entitiesForArea(areaId).forEach((state) => result.set(state.entity_id, state));
    this.placedEntitiesForRoom(areaId).forEach((state) => result.set(state.entity_id, state));
    return [...result.values()];
  },

  // Устройство размещено в комнате, но в HA привязано не к ней (или ни к чему).
  isUnassignedInRoom(entityId, areaId) {
    return this.registry?.getAreaForEntity(entityId) !== areaId;
  },

  /**
   * HA-группа света по формуле имени (v0.6.0):
   *   комната → light.<area_id>   (например area «Офис» = ofis → light.ofis)
   *   этаж    → light.<floor_id>  (например «3 этаж» = 3_etazh → light.3_etazh)
   * Группы создаются в HA заранее (логические группы из DALI-групп) — это детерминированный
   * путь управления. Если группы нет, вызывающий код падает в фолбэк-сборку ламп.
   */
  lightGroupState(objectId) {
    if (!this.registry || !objectId) return null;
    return this.registry.getState(`light.${objectId}`);
  },
};

window.ARVID_RUNTIME = {
  dataPromise: null,
  stateSubscriptionPromise: null,
  stateHandlers: new Set(),

  async ensureData(logArea = "runtime") {
    if (ARVID_APP.ha && ARVID_APP.storage && ARVID_APP.registry && ARVID_APP.layout) {
      return ARVID_APP;
    }

    if (this.dataPromise) return this.dataPromise;

    this.dataPromise = this.loadData(logArea).catch((error) => {
      this.dataPromise = null;
      throw error;
    });

    return this.dataPromise;
  },

  async loadData(logArea) {
    const config = window.ARVID_CONFIG;

    if (!config.HA_TOKEN || config.HA_TOKEN.includes("PASTE_")) {
      ARVID_LOG.error(logArea, "HA token is not configured in js/config.js");
      throw new Error("HA_TOKEN не задан в js/config.js");
    }

    ARVID_LOG.info(logArea, "Loading shared ARVID data for SPA");
    ARVID_APP.ha = await new ArvidHaWebSocket(config).connect();
    ARVID_APP.storage = new ArvidFloorplanStorage(ARVID_APP.ha);
    await ARVID_APP.storage.ping();
    ARVID_APP.registry = await new ArvidHaRegistry(ARVID_APP.ha).loadAll();
    ARVID_APP.layout = await ARVID_APP.storage.getLayout();
    // Здоровье устройств берём у ядра DALI. Объект создаём сразу, снимок запрашивает страница
    // (ядра может не быть — тогда модуль сам себя отключит, остальной интерфейс не страдает).
    ARVID_APP.health = new ArvidHealth(ARVID_APP.ha, ARVID_APP.registry);

    ARVID_LOG.info(logArea, "Shared ARVID data loaded", {
      floors: ARVID_APP.registry.floors.length,
      areas: ARVID_APP.registry.areas.length,
      states: ARVID_APP.registry.states.length,
    });

    return ARVID_APP;
  },

  addStateHandler(handler) {
    if (typeof handler !== "function") return;
    this.stateHandlers.add(handler);
    this.ensureStateSubscription().catch((error) => {
      ARVID_LOG.error("runtime", "Failed to initialize shared state subscription", error);
    });
  },

  async ensureStateSubscription() {
    if (this.stateSubscriptionPromise) return this.stateSubscriptionPromise;

    this.stateSubscriptionPromise = this.ensureData("runtime").then(() => ARVID_APP.ha.subscribeStateChanged((event) => {
      ARVID_APP.registry.updateStateFromEvent(event);
      this.stateHandlers.forEach((handler) => {
        try {
          handler(event);
        } catch (error) {
          ARVID_LOG.error("runtime", "State handler failed", error);
        }
      });
    }));

    return this.stateSubscriptionPromise;
  },
};
