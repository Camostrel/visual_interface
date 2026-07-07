/**
 * Редактор ARVID.
 * v0.8.17: редактор работает как SPA-view и содержит только размещение динамических устройств.
 */
class ArvidEditorPage {
  constructor() {
    this.logArea = "editor-page";
    this.svg = null;
    this.panZoom = null;
    this.selectedAreaId = null;
    this.selectedEntityId = null;
    this.requestedAreaId = null;
    this.requestedFloorId = null;
    this.isDirty = false;
    this.deviceDrag = null;
    this.initialized = false;
  }

  async init(params = {}) {
    if (this.initialized) return this.show(params);

    ARVID_LOG.info(this.logArea, "Initializing editor view v0.8.17");

    await this.initData();
    ArvidShellUi.initTheme(ARVID_APP.layout);
    ArvidShellUi.initViewportHeight();
    ArvidShellUi.renderBrand(ARVID_APP.layout);
    ArvidShellUi.initPanelToggles();
    ArvidShellUi.startClock();

    this.bindUi();
    ARVID_RUNTIME.addStateHandler(() => this.handleStateChanged());

    this.initialized = true;
    await this.show(params);

    ARVID_LOG.info(this.logArea, "Editor view initialized");
  }

  async initData() {
    await ARVID_RUNTIME.ensureData(this.logArea);
  }

  async show(params = {}) {
    this.requestedAreaId = params.area_id || null;
    this.requestedFloorId = params.floor_id || null;

    ArvidShellUi.initPanelToggles();
    this.renderSummary();
    this.renderFloorSelect();

    const firstFloorId = this.getInitialFloorId();
    await this.selectFloor(firstFloorId);

    ARVID_LOG.info(this.logArea, "Editor view shown", {
      floorId: ARVID_APP.currentFloorId,
      areaId: this.selectedAreaId,
    });
  }

  handleStateChanged() {
    if (!this.initialized || !this.svg) return;
    this.renderDeviceSelect();
    this.renderDeviceMarkers();
  }

  bindUi() {
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      if (button.dataset.themeToggleReady === "1") return;
      button.dataset.themeToggleReady = "1";
      button.addEventListener("click", () => ArvidShellUi.toggleTheme());
    });

    document.querySelector("[data-editor-floor-select]")?.addEventListener("change", (event) => {
      this.requestedAreaId = null;
      this.selectFloor(event.target.value).catch((error) => {
        ARVID_LOG.error(this.logArea, "Failed to select editor floor", error);
      });
    });

    document.querySelector("[data-editor-room-select]")?.addEventListener("change", (event) => {
      this.selectRoom(event.target.value).catch((error) => {
        ARVID_LOG.error(this.logArea, "Failed to select editor room", error);
      });
    });

    document.querySelector("[data-editor-device-select]")?.addEventListener("change", (event) => {
      this.selectDevice(event.target.value);
    });

    document.querySelector("[data-editor-device-visible]")?.addEventListener("change", () => this.applyDeviceControls());
    document.querySelector("[data-editor-device-marker]")?.addEventListener("change", () => this.applyDeviceControls());
    document.querySelector("[data-editor-device-icon]")?.addEventListener("change", () => this.applyDeviceControls());

    document.querySelector("[data-editor-save]")?.addEventListener("click", () => this.saveLayout());
    document.querySelector("[data-editor-center-device]")?.addEventListener("click", () => this.placeSelectedDeviceToCenter());
  }

  isMobilePlacementMode() {
    // На телефоне оставляем старую механику: выбрал устройство и тапнул по месту.
    // На desktop отключаем перемещение кликом, чтобы клик после pan не переносил объект случайно.
    return window.matchMedia("(max-width: 760px), (hover: none) and (pointer: coarse)").matches;
  }

  getInitialFloorId() {
    if (this.requestedFloorId) return this.requestedFloorId;
    const layoutDefault = ARVID_APP.layout?.building?.default_floor_id;
    if (layoutDefault) return layoutDefault;
    return ARVID_APP.registry.floors[0]?.floor_id || null;
  }

  renderSummary() {
    const el = document.querySelector("[data-editor-summary]");
    if (!el) return;

    el.innerHTML = `
      <div class="control-card">
        <header><h3>Диагностика</h3></header>
        <div class="entity-line"><strong>Этажи HA</strong><span>${ARVID_APP.registry.floors.length}</span></div>
        <div class="entity-line"><strong>Помещения HA</strong><span>${ARVID_APP.registry.areas.length}</span></div>
        <div class="entity-line"><strong>Устройств HA</strong><span>${ARVID_APP.registry.states.length}</span></div>
        <div class="entity-line"><strong>Комнат в layout</strong><span>${Object.keys(ARVID_APP.layout.rooms || {}).length}</span></div>
        <div class="entity-line"><strong>Устройств в layout</strong><span>${Object.keys(ARVID_APP.layout.devices || {}).length}</span></div>
      </div>
    `;
  }

  renderFloorSelect() {
    const select = document.querySelector("[data-editor-floor-select]");
    if (!select) return;

    select.innerHTML = "";
    ARVID_APP.registry.floors.forEach((floor) => {
      const option = document.createElement("option");
      option.value = floor.floor_id;
      option.textContent = `${floor.name} (${floor.floor_id})`;
      select.appendChild(option);
    });
  }

  async selectFloor(floorId) {
    if (!floorId) {
      this.setStatus("В HA не найдено этажей");
      ARVID_LOG.warn(this.logArea, "No floor selected in editor");
      return;
    }

    ARVID_APP.currentFloorId = floorId;
    const floorSelect = document.querySelector("[data-editor-floor-select]");
    if (floorSelect) floorSelect.value = floorId;

    ARVID_LOG.info(this.logArea, "Selecting editor floor", floorId);
    this.setStatus(`Выбран этаж: ${floorId}`);

    this.renderRoomSelect();
    const areas = this.getAreasForCurrentFloor();
    const requestedArea = areas.find((area) => area.area_id === this.requestedAreaId);
    const firstArea = requestedArea || areas[0];
    this.selectedAreaId = firstArea?.area_id || null;

    await this.loadRoomSvg(this.selectedAreaId);
    await this.selectRoom(this.selectedAreaId, { skipSvgReload: true });
  }

  getRoomSvg(areaId) {
    const room = this.getRoomLayout(areaId);
    const configuredSvg = room?.svg;
    return ARVID_CONFIG.resolveAssetUrl(configuredSvg, `assets/rooms/${areaId}.svg`);
  }

  async loadRoomSvg(areaId) {
    const container = document.querySelector("[data-editor-svg]");
    if (!container) return;

    if (!areaId) {
      this.svg = null;
      container.innerHTML = "<div class='muted-box'>На выбранном этаже нет помещений</div>";
      return;
    }

    this.svg = await ArvidSvgUtils.loadSvgInto(container, this.getRoomSvg(areaId), {
      fallbackUrl: ARVID_CONFIG.DEFAULT_ROOM_SVG,
    });

    this.panZoom = ArvidSvgUtils.setupPanZoom(container, this.svg, {
      logArea: this.logArea,
    });

    this.svg.addEventListener("click", (event) => this.handlePlanClick(event));
    ARVID_LOG.info(this.logArea, "Editor room SVG loaded", { areaId });
  }

  renderRoomSelect() {
    const select = document.querySelector("[data-editor-room-select]");
    if (!select) return;

    select.innerHTML = "";
    this.getAreasForCurrentFloor().forEach((area) => {
      const option = document.createElement("option");
      option.value = area.area_id;
      option.textContent = `${area.name} (${area.area_id})`;
      select.appendChild(option);
    });

    ARVID_LOG.debug(this.logArea, "Editor room list rendered", {
      floorId: ARVID_APP.currentFloorId,
      areas: this.getAreasForCurrentFloor().length,
    });
  }

  getAreasForCurrentFloor() {
    return ARVID_APP.registry.areas.filter((area) => area.floor_id === ARVID_APP.currentFloorId);
  }

  getArea(areaId) {
    return ARVID_APP.registry.areas.find((area) => area.area_id === areaId) || null;
  }

  getRoomEntities() {
    if (!this.selectedAreaId) return [];
    return ARVID_APP.registry.getEntitiesForArea(this.selectedAreaId)
      .filter((state) => this.isSupportedDeviceForEditor(state));
  }

  isSupportedDeviceForEditor(state) {
    // Скоуп visual_interface: свет, датчики движения/освещённости и панели (event.*).
    const entityId = state?.entity_id || "";
    return entityId.startsWith("light.")
      || entityId.startsWith("sensor.")
      || entityId.startsWith("event.");
  }

  getRoomLayout(areaId) {
    if (!areaId) return null;
    ARVID_APP.layout.rooms = ARVID_APP.layout.rooms || {};
    const current = ARVID_APP.layout.rooms[areaId] || {};

    ARVID_APP.layout.rooms[areaId] = {
      floor_id: current.floor_id || ARVID_APP.currentFloorId,
      visible: current.visible ?? true,
      ...current,
    };

    return ARVID_APP.layout.rooms[areaId];
  }

  getDeviceLayout(entityId) {
    if (!entityId) return null;
    ARVID_APP.layout.devices = ARVID_APP.layout.devices || {};
    const current = ARVID_APP.layout.devices[entityId] || {};

    ARVID_APP.layout.devices[entityId] = {
      area_id: current.area_id || this.selectedAreaId || ARVID_APP.registry.getAreaForEntity(entityId),
      visible: current.visible ?? true,
      marker: current.marker || "icon",
      icon: current.icon || "auto",
      ...current,
    };

    return ARVID_APP.layout.devices[entityId];
  }

  async selectRoom(areaId, options = {}) {
    this.selectedAreaId = areaId;
    ARVID_APP.currentAreaId = areaId;

    const select = document.querySelector("[data-editor-room-select]");
    if (select && areaId) select.value = areaId;

    const area = this.getArea(areaId);
    const room = this.getRoomLayout(areaId);
    const info = document.querySelector("[data-editor-room-info]");

    if (!area || !room) {
      if (info) info.textContent = "На выбранном этаже нет помещений.";
      this.updateDeviceControlState(false);
      this.selectedEntityId = null;
      this.renderDeviceSelect();
      this.renderDeviceMarkers();
      return;
    }

    if (info) {
      info.textContent = `${area.name} / ${area.area_id}`;
    }

    if (!options.skipSvgReload) await this.loadRoomSvg(areaId);
    this.renderDeviceSelect();
    this.selectDevice(this.getRoomEntities()[0]?.entity_id || null);
    this.renderDeviceMarkers();

    ARVID_LOG.info(this.logArea, "Editor room selected", { areaId });
  }

  updateDeviceControlState(enabled) {
    [
      "[data-editor-device-select]",
      "[data-editor-device-visible]",
      "[data-editor-device-marker]",
      "[data-editor-device-icon]",
      "[data-editor-center-device]",
    ].forEach((selector) => {
      const el = document.querySelector(selector);
      if (el) el.disabled = !enabled;
    });
  }

  renderDeviceSelect() {
    const select = document.querySelector("[data-editor-device-select]");
    if (!select) return;

    const currentValue = this.selectedEntityId;
    const entities = this.getRoomEntities();
    select.innerHTML = "";

    entities.forEach((state) => {
      const option = document.createElement("option");
      option.value = state.entity_id;
      option.textContent = `${ArvidDeviceUi.friendlyName(state)} (${state.entity_id})`;
      select.appendChild(option);
    });

    if (currentValue && entities.some((state) => state.entity_id === currentValue)) {
      select.value = currentValue;
    }

    ARVID_LOG.debug(this.logArea, "Editor device list rendered", {
      areaId: this.selectedAreaId,
      devices: entities.length,
    });
  }

  selectDevice(entityId) {
    this.selectedEntityId = entityId || null;
    const select = document.querySelector("[data-editor-device-select]");
    if (select && entityId) select.value = entityId;

    const state = ARVID_APP.registry.getState(entityId);
    const layout = this.getDeviceLayout(entityId);
    const info = document.querySelector("[data-editor-device-info]");

    if (!state || !layout) {
      if (info) info.textContent = "В выбранном помещении нет поддерживаемых устройств.";
      this.updateDeviceControlState(false);
      return;
    }

    this.updateDeviceControlState(true);
    this.syncControlsFromDevice(layout);

    const position = layout.x !== undefined && layout.y !== undefined
      ? `x=${Math.round(layout.x)}, y=${Math.round(layout.y)}`
      : "маркер ещё не размещён";
    if (info) info.textContent = `${ArvidDeviceUi.friendlyName(state)} / ${state.entity_id} / ${position}`;

    this.renderDeviceMarkers();
    ARVID_LOG.info(this.logArea, "Editor device selected", { entityId });
  }

  syncControlsFromDevice(layout) {
    document.querySelector("[data-editor-device-visible]").checked = layout.visible !== false;
    document.querySelector("[data-editor-device-marker]").value = layout.marker || "icon";
    document.querySelector("[data-editor-device-icon]").value = layout.icon || "auto";
  }

  applyDeviceControls() {
    const layout = this.getDeviceLayout(this.selectedEntityId);
    if (!layout) return;

    layout.area_id = this.selectedAreaId;
    layout.visible = document.querySelector("[data-editor-device-visible]")?.checked ?? true;
    layout.marker = document.querySelector("[data-editor-device-marker]")?.value || "icon";
    layout.icon = document.querySelector("[data-editor-device-icon]")?.value || "auto";

    this.markDirty("Device marker settings changed");
    this.renderDeviceMarkers();
  }

  handlePlanClick(event) {
    if (!this.svg) return;
    if (event.target.closest?.(".editor-device-marker")) return;

    if (!this.isMobilePlacementMode()) {
      this.setStatus("На компьютере перемещай устройства перетаскиванием. Тап по плану работает только на телефоне.");
      ARVID_LOG.debug(this.logArea, "Plan click ignored on desktop editor");
      return;
    }

    this.handleDevicePlanClick(event);
  }

  handleDevicePlanClick(event) {
    if (!this.selectedEntityId) return;

    const point = ArvidSvgUtils.clientPointToSvg(this.svg, event.clientX, event.clientY);
    if (!point) return;

    const layout = this.getDeviceLayout(this.selectedEntityId);
    layout.area_id = this.selectedAreaId;
    layout.x = Math.round(point.x * 10) / 10;
    layout.y = Math.round(point.y * 10) / 10;
    layout.visible = true;

    this.syncControlsFromDevice(layout);
    this.markDirty("Device marker moved by plan click");
    this.selectDevice(this.selectedEntityId);

    ARVID_LOG.info(this.logArea, "Device marker moved", {
      entityId: this.selectedEntityId,
      x: layout.x,
      y: layout.y,
    });
  }

  placeSelectedDeviceToCenter() {
    if (!this.selectedEntityId || !this.svg) return;

    const center = this.getCurrentSvgCenter();
    const layout = this.getDeviceLayout(this.selectedEntityId);
    layout.area_id = this.selectedAreaId;
    layout.x = center.x;
    layout.y = center.y;
    layout.visible = true;

    this.markDirty("Device marker moved to center");
    this.selectDevice(this.selectedEntityId);
  }

  getCurrentSvgCenter() {
    const rawViewBox = this.svg.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
    const [x, y, width, height] = rawViewBox;
    return {
      x: Math.round((x + width / 2) * 10) / 10,
      y: Math.round((y + height / 2) * 10) / 10,
    };
  }

  startDeviceDrag(event, state, group) {
    if (!this.svg) return;
    if (event.button !== undefined && event.button !== 0) return;

    // Важно: если пользователь потянул устройство, план не должен начинать pan.
    event.preventDefault();
    event.stopPropagation();

    // Не вызываем selectDevice(), потому что она перерисовывает слой и удаляет текущий DOM-маркер.
    this.selectedEntityId = state.entity_id;
    const select = document.querySelector("[data-editor-device-select]");
    if (select) select.value = state.entity_id;
    const layout = this.getDeviceLayout(state.entity_id);
    this.updateDeviceControlState(Boolean(layout));
    if (layout) this.syncControlsFromDevice(layout);

    group.setPointerCapture?.(event.pointerId);
    group.classList.add("is-dragging");

    this.deviceDrag = {
      entityId: state.entity_id,
      group,
      pointerId: event.pointerId,
      moved: false,
    };

    const onMove = (moveEvent) => this.handleDeviceDragMove(moveEvent);
    const onUp = (upEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      this.finishDeviceDrag(upEvent);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    ARVID_LOG.info(this.logArea, "Device drag started", {
      entityId: state.entity_id,
    });
  }

  handleDeviceDragMove(event) {
    if (!this.deviceDrag || !this.svg) return;
    if (event.pointerId !== this.deviceDrag.pointerId) return;

    event.preventDefault();
    event.stopPropagation();

    const point = ArvidSvgUtils.clientPointToSvg(this.svg, event.clientX, event.clientY);
    if (!point) return;

    const layout = this.getDeviceLayout(this.deviceDrag.entityId);
    if (!layout) return;

    layout.area_id = this.selectedAreaId;
    layout.x = Math.round(point.x * 10) / 10;
    layout.y = Math.round(point.y * 10) / 10;
    layout.visible = true;

    this.deviceDrag.group.setAttribute("transform", `translate(${layout.x}, ${layout.y})`);
    this.deviceDrag.moved = true;

    const info = document.querySelector("[data-editor-device-info]");
    const state = ARVID_APP.registry.getState(this.deviceDrag.entityId);
    if (info && state) {
      info.textContent = `${ArvidDeviceUi.friendlyName(state)} / ${state.entity_id} / x=${Math.round(layout.x)}, y=${Math.round(layout.y)}`;
    }
  }

  finishDeviceDrag(event) {
    if (!this.deviceDrag) return;

    event?.preventDefault?.();
    event?.stopPropagation?.();

    const { entityId, group, moved } = this.deviceDrag;
    group.classList.remove("is-dragging");
    this.deviceDrag = null;

    if (moved) {
      this.markDirty("Device marker moved by drag");
      this.renderDeviceMarkers();

      const layout = this.getDeviceLayout(entityId);
      ARVID_LOG.info(this.logArea, "Device drag finished", {
        entityId,
        x: layout?.x,
        y: layout?.y,
      });
    } else {
      ARVID_LOG.debug(this.logArea, "Device drag finished without movement", { entityId });
    }
  }

  renderDeviceMarkers() {
    if (!this.svg) return;

    const layer = ArvidSvgUtils.ensureOverlayLayer(this.svg, "arvid-editor-device-markers");
    ArvidSvgUtils.clearLayer(layer);

    let rendered = 0;
    this.getRoomEntities().forEach((state) => {
      const layout = this.getDeviceLayout(state.entity_id);
      if (!layout || layout.x === undefined || layout.y === undefined) return;

      const isSelected = state.entity_id === this.selectedEntityId;
      const isHidden = layout.visible === false;
      const marker = layout.marker || "icon";
      const icon = layout.icon === "auto" ? ArvidDeviceUi.markerKind(state) : layout.icon;

      const group = ArvidSvgUtils.createSvgElement("g", {
        class: `editor-device-marker ${isSelected ? "is-selected" : ""} ${isHidden ? "is-hidden" : ""} marker-${marker} device-kind-${icon} ${ArvidDeviceUi.isActive(state) ? "is-on is-active" : ""}`,
        transform: `translate(${layout.x}, ${layout.y})`,
        tabindex: "0",
      });

      this.appendDeviceMarkerShape(group, marker, icon, state);

      group.addEventListener("pointerdown", (event) => this.startDeviceDrag(event, state, group));

      group.addEventListener("click", (event) => {
        event.stopPropagation();
        this.selectDevice(state.entity_id);
      });

      layer.appendChild(group);
      rendered += 1;
    });

    ARVID_LOG.debug(this.logArea, "Editor device markers rendered", {
      rendered,
      areaId: this.selectedAreaId,
    });
  }

  appendDeviceMarkerShape(group, marker, icon, state) {
    const iconUrl = marker === "icon" ? ArvidDeviceUi.iconAssetUrl(icon) : null;

    if (iconUrl) {
      // SVG-иконка уже содержит квадратную панель, поэтому внешний круг/квадрат не добавляем.
      group.appendChild(ArvidSvgUtils.createSvgElement("rect", {
        x: -24,
        y: -24,
        width: 48,
        height: 48,
        rx: 12,
        class: "editor-device-marker-hit",
      }));
      group.appendChild(ArvidSvgUtils.createSvgElement("rect", {
        x: -24,
        y: -24,
        width: 48,
        height: 48,
        rx: 12,
        class: "editor-device-marker-selection",
      }));
      group.appendChild(ArvidSvgUtils.createSvgElement("image", {
        href: iconUrl,
        x: -22,
        y: -22,
        width: 44,
        height: 44,
        class: "editor-device-marker-image",
        "preserveAspectRatio": "xMidYMid meet",
      }));
    } else {
      // Текстовые fallback-маркеры оставляем в старой форме, чтобы редактор поддерживал неизвестные типы.
      if (marker === "square") {
        group.appendChild(ArvidSvgUtils.createSvgElement("rect", {
          x: -20,
          y: -20,
          width: 40,
          height: 40,
          rx: 8,
        }));
      } else {
        group.appendChild(ArvidSvgUtils.createSvgElement("circle", {
          cx: 0,
          cy: 0,
          r: marker === "circle" ? 18 : 22,
        }));
      }
      const text = ArvidSvgUtils.createSvgElement("text", {
        x: 0,
        y: 6,
        "text-anchor": "middle",
        class: "editor-device-marker-icon",
      });
      text.textContent = marker === "icon" ? ArvidDeviceUi.iconText(icon) : this.getShortDomainLabel(state);
      group.appendChild(text);
    }
  }

  getShortDomainLabel(state) {
    const kind = ArvidDeviceUi.markerKind(state);
    const labels = {
      light: "L",
      motion: "M",
      illuminance: "LX",
      panel: "P",
      sensor: "S",
    };
    return labels[kind] || ArvidDeviceUi.domain(state.entity_id).slice(0, 2).toUpperCase();
  }

  markDirty(reason) {
    this.isDirty = true;
    this.setStatus(`Есть несохранённые изменения: ${reason}`);
    ARVID_LOG.debug(this.logArea, "Editor layout marked dirty", { reason });
  }

  async saveLayout() {
    try {
      this.setStatus("Сохраняю layout...");
      ARVID_APP.layout = await ARVID_APP.storage.saveLayout(ARVID_APP.layout);
      this.isDirty = false;
      this.renderSummary();
      this.setStatus("Layout сохранён");
      ARVID_LOG.info(this.logArea, "Editor layout saved");
    } catch (error) {
      this.setStatus("Ошибка сохранения layout");
      ARVID_LOG.error(this.logArea, "Failed to save editor layout", error);
    }
  }

  setStatus(text) {
    const status = document.querySelector("[data-editor-status]");
    if (status) status.textContent = text;
  }
}

window.ArvidEditorPage = ArvidEditorPage;
