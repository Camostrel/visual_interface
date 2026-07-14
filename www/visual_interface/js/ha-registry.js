/**
 * Чтение сырых данных Home Assistant через WebSocket.
 * Сложной нормализации здесь нет: frontend использует entity_id, friendly_name и attributes.
 * v0.8.2: экспериментальный sessionStorage-кэш удалён, чтобы данные всегда были предсказуемо свежими.
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
    return this.states.filter((state) => this.entityById.get(state.entity_id)?.device_id === deviceId);
  }

  getAreaForEntity(entityId) {
    const entity = this.entityById.get(entityId);
    if (!entity) return null;

    if (entity.area_id) return entity.area_id;

    if (entity.device_id) {
      const device = this.deviceById.get(entity.device_id);
      if (device?.area_id) return device.area_id;
    }

    return null;
  }

  getEntitiesForArea(areaId) {
    return this.states.filter((state) => this.getAreaForEntity(state.entity_id) === areaId);
  }

  updateStateFromEvent(event) {
    const entityId = event?.data?.entity_id;
    const newState = event?.data?.new_state;
    if (!entityId || !newState) return;

    this.stateById.set(entityId, newState);
    const index = this.states.findIndex((state) => state.entity_id === entityId);
    if (index >= 0) this.states[index] = newState;
    else this.states.push(newState);

    ARVID_LOG.debug(this.logArea, "State updated from event", {
      entityId,
      state: newState.state,
    });
  }
}

window.ArvidHaRegistry = ArvidHaRegistry;
