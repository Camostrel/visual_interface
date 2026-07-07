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
