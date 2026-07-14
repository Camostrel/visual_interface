/**
 * Client for our visual_interface Home Assistant integration storage commands.
 */
class ArvidFloorplanStorage {
  constructor(ha) {
    this.ha = ha;
    this.logArea = "storage";
  }

  async ping() {
    ARVID_LOG.info(this.logArea, "Pinging visual_interface integration");
    return this.ha.send({ type: "visual_interface/ping" });
  }

  async getLayout() {
    ARVID_LOG.info(this.logArea, "Loading layout from HA storage");
    const result = await this.ha.send({ type: "visual_interface/layout/get" });
    ARVID_LOG.info(this.logArea, "Layout loaded", {
      rooms: Object.keys(result.layout?.rooms || {}).length,
      devices: Object.keys(result.layout?.devices || {}).length,
    });
    return result.layout;
  }

  /**
   * Полная запись документа. Используется редко: у неё есть право затереть чужую работу,
   * поэтому шлём base_rev — ревизию, на которой строили свою копию (A4).
   * Backend отвечает ошибкой `layout_conflict`, если документ уже изменили.
   */
  async saveLayout(layout) {
    const baseRev = layout?.meta?.rev ?? null;
    ARVID_LOG.info(this.logArea, "Saving full layout", { baseRev });

    const result = await this.ha.send({
      type: "visual_interface/layout/save",
      layout,
      base_rev: baseRev,
    });
    ARVID_LOG.info(this.logArea, "Full layout saved", { rev: result.layout?.meta?.rev });
    return result.layout;
  }

  /**
   * Точечная запись расстановки (A4): пишем ТОЛЬКО изменённые устройства.
   * Правка с другого планшета при этом не теряется — в отличие от saveLayout,
   * который отправлял весь документ снимком из своей вкладки.
   */
  async updateDevices(devices, remove = []) {
    ARVID_LOG.info(this.logArea, "Updating device layout", {
      updated: Object.keys(devices || {}).length,
      removed: remove.length,
    });

    const result = await this.ha.send({
      type: "visual_interface/layout/devices/update",
      devices: devices || {},
      remove,
    });
    return result.layout;
  }

  /** Точечная запись UI-настроек (тема). Координаты устройств не трогает (A4). */
  async updateUi(ui) {
    ARVID_LOG.info(this.logArea, "Updating UI settings", ui);
    const result = await this.ha.send({
      type: "visual_interface/layout/ui/update",
      ui,
    });
    return result.layout;
  }

  async updateRoom(areaId, room) {
    ARVID_LOG.info(this.logArea, "Updating room layout", { areaId, room });
    const result = await this.ha.send({
      type: "visual_interface/layout/room/update",
      area_id: areaId,
      room,
    });
    return result.layout;
  }
}

window.ArvidFloorplanStorage = ArvidFloorplanStorage;
