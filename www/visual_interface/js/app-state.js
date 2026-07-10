/**
 * Общие runtime-данные SPA.
 * Данные Home Assistant загружаем один раз и переиспользуем между views.
 */
window.ARVID_APP = {
  ha: null,
  storage: null,
  registry: null,
  layout: null,
  currentFloorId: null,
  currentAreaId: null,

  /**
   * Устройства, относящиеся к комнате.
   * Объединяем два источника привязки, чтобы работало и с назначенными в HA area,
   * и на частных объектах, где area устройствам не заданы (v0.4.0):
   *   1) сущности HA с этим area_id (стандартная привязка HA);
   *   2) устройства, размещённые нами на плане этой комнаты (layout.devices[*].area_id).
   * Так свет «в комнате» определяется даже без HA-area — по нашей расстановке.
   */
  entitiesForRoom(areaId) {
    if (!this.registry || !areaId) return [];

    const result = new Map();
    this.registry.getEntitiesForArea(areaId).forEach((state) => {
      result.set(state.entity_id, state);
    });

    const devices = this.layout?.devices || {};
    Object.keys(devices).forEach((entityId) => {
      if (devices[entityId]?.area_id !== areaId) return;
      const state = this.registry.getState(entityId);
      if (state) result.set(entityId, state);
    });

    return [...result.values()];
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
