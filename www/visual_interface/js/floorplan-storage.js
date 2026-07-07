/**
 * Client for our web_interface Home Assistant integration storage commands.
 */
class ArvidFloorplanStorage {
  constructor(ha) {
    this.ha = ha;
    this.logArea = "storage";
  }

  async ping() {
    ARVID_LOG.info(this.logArea, "Pinging web_interface integration");
    return this.ha.send({ type: "web_interface/ping" });
  }

  async getLayout() {
    ARVID_LOG.info(this.logArea, "Loading layout from HA storage");
    const result = await this.ha.send({ type: "web_interface/layout/get" });
    ARVID_LOG.info(this.logArea, "Layout loaded", {
      rooms: Object.keys(result.layout?.rooms || {}).length,
      devices: Object.keys(result.layout?.devices || {}).length,
    });
    return result.layout;
  }

  async saveLayout(layout) {
    ARVID_LOG.info(this.logArea, "Saving full layout");
    const result = await this.ha.send({
      type: "web_interface/layout/save",
      layout,
    });
    ARVID_LOG.info(this.logArea, "Full layout saved");
    return result.layout;
  }

  async updateRoom(areaId, room) {
    ARVID_LOG.info(this.logArea, "Updating room layout", { areaId, room });
    const result = await this.ha.send({
      type: "web_interface/layout/room/update",
      area_id: areaId,
      room,
    });
    return result.layout;
  }

  async updateDevice(entityId, device) {
    ARVID_LOG.info(this.logArea, "Updating device layout", { entityId, device });
    const result = await this.ha.send({
      type: "web_interface/layout/device/update",
      entity_id: entityId,
      device,
    });
    return result.layout;
  }
}

window.ArvidFloorplanStorage = ArvidFloorplanStorage;
