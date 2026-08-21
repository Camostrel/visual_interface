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

  /**
   * ОБЩАЯ группа света помещения (v0.14.0):
   *   light.<room_slug>_obshchii   (512_koridor → light.512_koridor_obshchii)
   *
   * `room_slug` — это `area_id`, он же имя помещения из паркета: берём как есть.
   * Суффикс отделяет общую группу помещения от ЗОННЫХ групп, которые именуются
   * по другому правилу — `<номер помещения>_<индекс зоны>` (512_0, 512_1, …).
   * Зонные группы интерфейс пока не использует; правило записано здесь, чтобы
   * при их появлении не пришлось гадать, почему имена разные.
   *
   * Этаж и объект целиком остаются без суффикса: light.<floor_id>, light.all.
   */
  roomLightGroupId(areaId) {
    return areaId ? `light.${areaId}_obshchii` : null;
  },

  roomLightGroupState(areaId) {
    if (!this.registry || !areaId) return null;
    return this.registry.getState(this.roomLightGroupId(areaId));
  },

  /**
   * Сущность — ГРУППА света, а не физический светильник (v0.9.0).
   * Группы не должны попадать ни в счётчик «N/N включено», ни в состав комнаты,
   * ни на план: иначе одна и та же лампа считается дважды (сама и через группу).
   *
   * Два вида групп:
   *  1. DALI-группа ядра (`DaliGroupLight`) — у её УСТРОЙСТВА в реестре HA
   *     `model = "DALI Group"` (см. light.py ядра). Это надёжный признак: имя группы
   *     произвольное («r2»), по entity_id её не отличить от лампы.
   *  2. Группа/хелпер самого HA (light group) — состояния групп несут в атрибутах
   *     список членов `entity_id: [...]`. Так ловятся light.<area_id>/<floor_id>/all,
   *     заведённые в HA вручную.
   */
  isLightGroupState(state) {
    const entityId = state?.entity_id || "";
    if (!entityId.startsWith("light.")) return false;

    if (this.registry?.getDeviceModel(entityId) === "DALI Group") return true;

    // HA-группа света перечисляет своих членов в атрибуте entity_id.
    return Array.isArray(state?.attributes?.entity_id);
  },
};

window.ARVID_RUNTIME = {
  dataPromise: null,
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
    ARVID_APP.registry = await new ArvidHaRegistry(ARVID_APP.ha).loadRegistries();
    // Состав (сущности/устройства/области) меняется в HA и без нашего участия: задали area,
    // переименовали лампу, добавили датчик. Слушаем реестры, чтобы не застывать до F5 (D5).
    await ARVID_APP.registry.subscribeRegistryUpdates();
    ARVID_APP.layout = await ARVID_APP.storage.getLayout();
    // Здоровье устройств берём у ядра DALI. Объект создаём сразу, снимок запрашивает страница
    // (ядра может не быть — тогда модуль сам себя отключит, остальной интерфейс не страдает).
    ARVID_APP.health = new ArvidHealth(ARVID_APP.ha, ARVID_APP.registry);

    // Реконнект: пока связи не было, свет могли включить, датчики — сработать. Наши состояния
    // устарели, а событий за время обрыва нам никто не перешлёт. Поэтому после восстановления
    // связи перечитываем снимок целиком (v0.11.0, A3).
    ARVID_APP.ha.addStatusHandler((status) => this.handleConnectionStatus(status));

    ARVID_LOG.info(logArea, "Shared ARVID data loaded", {
      floors: ARVID_APP.registry.floors.length,
      areas: ARVID_APP.registry.areas.length,
      states: ARVID_APP.registry.states.length,
    });

    return ARVID_APP;
  },

  handleConnectionStatus(status) {
    const wasOffline = this._connectionLost === true;

    if (status === "offline") {
      this._connectionLost = true;
      return;
    }

    if (status !== "online" || !wasOffline) return;

    this._connectionLost = false;
    ARVID_LOG.info("runtime", "Связь восстановлена — перечитываем реестры и переподписываем сегмент");

    ARVID_APP.registry.loadRegistries()
      .then(() => {
        // Подписка на сегмент после реконнекта мертва (id старый) — оформляем заново; свежий
        // снимок вернёт актуальные состояния (за время обрыва события нам не пересылались).
        const ids = this._segmentIds;
        this._segmentSubId = null;
        this._segmentKey = null;   // сбрасываем guard, чтобы переподписка прошла
        return ids ? this.subscribeSegment(ids) : null;
      })
      .then(() => {
        ARVID_APP.registry.notifyComposition("связь восстановлена");
      })
      .catch((error) => {
        ARVID_LOG.error("runtime", "Не удалось перечитать после реконнекта", error);
      });
  },

  addStateHandler(handler) {
    // Обработчики ЗНАЧЕНИЙ (страницы). Подписку заводит subscribeSegment, а не addStateHandler:
    // теперь слушаем только сегмент текущего экрана, а не весь HA (D1).
    if (typeof handler === "function") this.stateHandlers.add(handler);
  },

  // --- Подписка на СЕГМЕНТ текущего экрана (D1) ---
  _segmentSubId: null,
  _segmentIds: null,
  _segmentKey: null,
  _segmentFirst: false,
  _segmentResolveFirst: null,

  /**
   * Подписаться на набор сущностей текущего экрана (этаж/комната). При навигации меняет подписку:
   * отписывает прежнюю, подписывает новую. Возвращает промис, разрешаемый по ПЕРВОМУ снимку
   * (страница ждёт его перед первой отрисовкой). Тот же набор повторно не переподписываем (guard).
   */
  async subscribeSegment(entityIds) {
    const ids = [...new Set((entityIds || []).filter(Boolean))].sort();
    const key = ids.join(",");

    if (key === this._segmentKey && this._segmentSubId != null) return undefined; // тот же сегмент

    if (this._segmentSubId != null) {
      ARVID_APP.ha.unsubscribeEntities(this._segmentSubId);
      this._segmentSubId = null;
    }

    this._segmentKey = key;
    this._segmentIds = ids;
    this._segmentFirst = false;

    const first = new Promise((resolve) => {
      this._segmentResolveFirst = resolve;
      // Страховка для экрана 24/7: не держим отрисовку дольше 4с, даже если снимок задержался.
      // Реальный снимок всё равно придёт и перерисует состав через notifyComposition.
      window.setTimeout(() => { this._segmentResolveFirst?.(); this._segmentResolveFirst = null; }, 4000);
    });

    try {
      const sub = await ARVID_APP.ha.subscribeEntities(ids, (decoded) => this._onSegmentEvent(decoded));
      this._segmentSubId = sub.id;
      ARVID_LOG.info("runtime", "Подписка на сегмент оформлена", { count: ids.length });
    } catch (error) {
      ARVID_LOG.error("runtime", "Не удалось подписаться на сегмент", error);
      this._segmentResolveFirst?.();   // не держим страницу, если подписка не удалась
      this._segmentResolveFirst = null;
    }

    return first;
  },

  _onSegmentEvent(decoded) {
    const reg = ARVID_APP.registry;

    // Первое событие подписки — снимок `a`: полный набор сегмента, заменяем состояния.
    if (!this._segmentFirst) {
      this._segmentFirst = true;
      reg.replaceStates(decoded.add);
      if (decoded.change.length || decoded.remove.length) {
        reg.applyEntitiesUpdate({ add: [], change: decoded.change, remove: decoded.remove });
      }
      reg.notifyComposition("сегмент подписан");     // страницы рисуют состав
      this._segmentResolveFirst?.();
      this._segmentResolveFirst = null;
      return;
    }

    const { valueChanges, composition } = reg.applyEntitiesUpdate(decoded);

    // Значения → существующим обработчикам страниц. Форма события ТА ЖЕ, что у state_changed,
    // поэтому floor-page/room-page.handleStateChanged менять не нужно (D1).
    valueChanges.forEach((ch) => {
      const event = { data: { entity_id: ch.entity_id, new_state: ch.new_state, old_state: ch.old_state } };
      this.stateHandlers.forEach((handler) => {
        try {
          handler(event);
        } catch (error) {
          ARVID_LOG.error("runtime", "State handler failed", error);
        }
      });
    });

    if (composition) reg.notifyComposition("состав сегмента изменился");
  },
};
