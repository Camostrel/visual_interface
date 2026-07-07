/**
 * Страница помещения: план, маркеры устройств и компактные панели управления.
 * v0.8.0: переработан UX комнаты под концепт ARVID.
 */
class ArvidRoomPage {
  constructor() {
    this.logArea = "room-page";
    this.svg = null;
    this.panZoom = null;
    this.areaId = null;
    this.floorId = null;
    this.devicePopup = null;
    this.markerPress = null;
    this.initialized = false;
  }

  async init(params = {}) {
    if (this.initialized) return this.show(params);

    ARVID_LOG.info(this.logArea, "Initializing room view");

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

    ARVID_LOG.info(this.logArea, "Room view initialized");
  }

  async initData() {
    await ARVID_RUNTIME.ensureData(this.logArea);
  }

  setRouteParams(params = {}) {
    this.areaId = params.area_id || new URLSearchParams(window.location.search).get("area_id");
    this.floorId = params.floor_id || new URLSearchParams(window.location.search).get("floor_id");
  }

  async show(params = {}) {
    this.setRouteParams(params);

    ARVID_LOG.info(this.logArea, "Showing room view", {
      areaId: this.areaId,
      floorId: this.floorId,
    });

    if (!this.areaId) throw new Error("area_id is required for room view");

    ARVID_APP.currentAreaId = this.areaId;
    ARVID_APP.currentFloorId = this.floorId;
    ArvidShellUi.initPanelToggles();

    this.closeDevicePopup();
    await this.loadRoomSvg();
    this.renderDeviceMarkers();
    this.renderControls();
  }

  handleStateChanged() {
    if (!this.initialized || !this.areaId) return;
    this.renderDeviceMarkers();
    this.renderControls();
  }

  bindUi() {
    // Обрабатываем все кнопки темы.
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      if (button.dataset.themeToggleReady === "1") return;
      button.dataset.themeToggleReady = "1";
      button.addEventListener("click", () => ArvidShellUi.toggleTheme());
    });

    document.querySelector("[data-back]")?.addEventListener("click", () => {
      window.ARVID_SPA?.navigate("floor", this.floorId ? { floor_id: this.floorId } : {});
    });

    document.querySelector("[data-edit-room]")?.addEventListener("click", () => {
      const params = new URLSearchParams();
      params.set("area_id", this.areaId);
      if (this.floorId) params.set("floor_id", this.floorId);

      ARVID_LOG.info(this.logArea, "Opening room device editor", {
        areaId: this.areaId,
        floorId: this.floorId,
      });
      window.ARVID_SPA?.navigate("editor", Object.fromEntries(params.entries()));
    });
  }

  getArea() {
    return ARVID_APP.registry.areas.find((area) => area.area_id === this.areaId) || null;
  }

  getRoomLayout() {
    return ARVID_APP.layout?.rooms?.[this.areaId] || {};
  }

  getRoomSvg() {
    const room = this.getRoomLayout();
    const configuredSvg = room.svg;
    const svgUrl = ARVID_CONFIG.resolveAssetUrl(configuredSvg, `assets/rooms/${this.areaId}.svg`);
    ARVID_LOG.debug(this.logArea, "Resolved room SVG", {
      areaId: this.areaId,
      configuredSvg,
      svgUrl,
      fallbackUrl: ARVID_CONFIG.DEFAULT_ROOM_SVG,
    });
    return svgUrl;
  }

  async loadRoomSvg() {
    const area = this.getArea();
    document.querySelector("[data-room-title]").textContent = area?.name || this.areaId;
    document.querySelector("[data-room-subtitle]").textContent = `${this.floorId || "этаж не выбран"} / ${this.areaId}`;

    const container = document.querySelector("[data-room-svg]");
    this.svg = await ArvidSvgUtils.loadSvgInto(container, this.getRoomSvg(), {
      fallbackUrl: ARVID_CONFIG.DEFAULT_ROOM_SVG,
    });

    // Управление планом комнаты: колесо, drag плана, pinch и кнопки +/-.
    this.panZoom = ArvidSvgUtils.setupPanZoom(container, this.svg, {
      logArea: this.logArea,
    });

    this.updateMobilePlanLayout();
    this.bindResponsiveResize();
  }

  bindResponsiveResize() {
    if (this._responsiveResizeBound) return;
    this._responsiveResizeBound = true;

    const refresh = () => this.updateMobilePlanLayout();
    window.addEventListener("resize", refresh);
    window.visualViewport?.addEventListener("resize", refresh);
  }

  updateMobilePlanLayout() {
    const planArea = document.querySelector(".room-plan-area");
    if (!planArea || !this.svg) return;

    if (!window.matchMedia("(max-width: 760px) and (orientation: portrait)").matches) {
      planArea.style.removeProperty("--room-plan-height");
      return;
    }

    const metrics = ArvidSvgUtils.getViewBoxMetrics(this.svg);
    const areaWidth = planArea.clientWidth || document.querySelector("[data-room-svg]")?.clientWidth || 320;
    const viewportHeight = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--arvid-app-height"), 10)
      || Math.round(window.visualViewport?.height || window.innerHeight || 0);
    const desiredHeight = Math.round(areaWidth * (metrics?.ratio || 0.68) + 22);
    const maxHeight = Math.max(240, Math.round(viewportHeight * 0.42));
    const nextHeight = Math.max(220, Math.min(desiredHeight, maxHeight));

    planArea.style.setProperty("--room-plan-height", `${nextHeight}px`);
    ARVID_LOG.debug(this.logArea, "Mobile room plan height updated", {
      areaWidth,
      desiredHeight,
      nextHeight,
      viewportHeight,
    });
  }

  getRoomEntities() {
    return ARVID_APP.registry.getEntitiesForArea(this.areaId);
  }

  getDeviceLayout(entityId) {
    return ARVID_APP.layout?.devices?.[entityId] || null;
  }

  renderDeviceMarkers() {
    if (!this.svg) return;

    const layer = ArvidSvgUtils.ensureOverlayLayer(this.svg, "arvid-device-markers");
    ArvidSvgUtils.clearLayer(layer);

    const entities = this.getRoomEntities();
    let rendered = 0;

    entities.forEach((state) => {
      const layout = this.getDeviceLayout(state.entity_id);
      if (!layout || layout.visible === false || layout.x === undefined || layout.y === undefined) return;

      const marker = layout.marker || "icon";
      const kind = layout.icon === "auto" || !layout.icon ? ArvidDeviceUi.markerKind(state) : layout.icon;
      const group = ArvidSvgUtils.createSvgElement("g", {
        class: `device-marker marker-${marker} device-kind-${kind} ${ArvidDeviceUi.isActive(state) ? "is-on is-active" : ""}`,
        transform: `translate(${layout.x}, ${layout.y})`,
        tabindex: "0",
      });

      const iconUrl = marker === "icon" ? ArvidDeviceUi.iconAssetUrl(kind) : null;

      if (iconUrl) {
        // Для SVG-ассета не рисуем дополнительную круглую подложку: сама иконка уже является панелью устройства.
        group.appendChild(ArvidSvgUtils.createSvgElement("rect", {
          x: -24,
          y: -24,
          width: 48,
          height: 48,
          rx: 12,
          class: "device-marker-hit",
        }));
        group.appendChild(ArvidSvgUtils.createSvgElement("image", {
          href: iconUrl,
          x: -22,
          y: -22,
          width: 44,
          height: 44,
          class: "device-marker-image",
          "preserveAspectRatio": "xMidYMid meet",
        }));
      } else {
        // Текстовые fallback-маркеры оставляем в старой форме, чтобы не ломать неизвестные типы устройств.
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
          class: "device-marker-icon",
        });
        text.textContent = marker === "icon" ? ArvidDeviceUi.iconText(kind) : this.getShortMarkerLabel(state);
        group.appendChild(text);
      }

      this.bindDeviceMarkerEvents(group, state);
      layer.appendChild(group);
      rendered += 1;
    });

    ARVID_LOG.debug(this.logArea, "Device markers rendered", { rendered, total: entities.length });
  }

  getShortMarkerLabel(state) {
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

  bindDeviceMarkerEvents(group, state) {
    // Короткое нажатие выполняет основное действие, длинное — открывает точечное управление.
    group.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const press = {
        entityId: state.entity_id,
        handled: false,
        startX: event.clientX,
        startY: event.clientY,
        timer: window.setTimeout(() => {
          press.handled = true;
          this.openDevicePopup(state, group);
          ARVID_LOG.info(this.logArea, "Device long press opened popup", {
            entityId: state.entity_id,
          });
        }, 650),
      };
      this.markerPress = press;

      const onMove = (moveEvent) => {
        if (!this.markerPress || this.markerPress.entityId !== state.entity_id) return;
        const dx = Math.abs(moveEvent.clientX - press.startX);
        const dy = Math.abs(moveEvent.clientY - press.startY);
        if (dx > 8 || dy > 8) this.cancelMarkerPress();
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        const currentPress = this.markerPress;
        this.cancelMarkerPress();
        if (!currentPress?.handled) this.handleMarkerClick(state, group);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });

    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.handleMarkerClick(state, group);
      }
    });
  }

  cancelMarkerPress() {
    if (this.markerPress?.timer) window.clearTimeout(this.markerPress.timer);
    this.markerPress = null;
  }

  handleMarkerClick(state, group = null) {
    const domain = state.entity_id.split(".")[0];
    const popup = this.devicePopup;
    const isSameOpenPopup = popup && !popup.hidden && this.devicePopupEntityId === state.entity_id;
    ARVID_LOG.info(this.logArea, "Device marker clicked", {
      entityId: state.entity_id,
      domain,
      isSameOpenPopup,
    });

    // Повторный клик по той же иконке закрывает открытое окно без выполнения действия.
    if (isSameOpenPopup) {
      this.closeDevicePopup();
      return;
    }

    if (domain === "light") {
      ARVID_APP.ha.callService("light", "toggle", {}, { entity_id: state.entity_id });
      return;
    }

    if (ArvidDeviceUi.isReadableSensor(state) || ArvidDeviceUi.isPanelEvent(state)) {
      this.openDevicePopup(state, group);
      return;
    }

    ARVID_LOG.info(this.logArea, "No direct click action for domain", domain);
  }

  ensureDevicePopup() {
    if (this.devicePopup) return this.devicePopup;

    const popup = document.createElement("aside");
    popup.className = "device-marker-popup";
    popup.hidden = true;
    popup.addEventListener("click", (event) => event.stopPropagation());
    document.body.appendChild(popup);
    this.devicePopup = popup;

    document.addEventListener("pointerdown", (event) => {
      if (!this.devicePopup || this.devicePopup.hidden) return;
      if (this.devicePopup.contains(event.target)) return;
      if (event.target.closest?.(".device-marker")) return;
      this.closeDevicePopup();
    }, true);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.closeDevicePopup();
    });

    return popup;
  }

  openDevicePopup(state, anchorGroup = null) {
    const popup = this.ensureDevicePopup();
    const domain = ArvidDeviceUi.domain(state.entity_id);
    const kind = ArvidDeviceUi.markerKind(state);

    popup.innerHTML = `
      <div class="device-marker-popup__header">
        <div>
          <span>${this.getSensorDisplayLabel(state, kind)}</span>
          <strong>${ArvidDeviceUi.friendlyName(state)}</strong>
        </div>
        <button type="button" data-device-popup-close aria-label="Закрыть">×</button>
      </div>
      <div class="device-marker-popup__body"></div>
    `;

    const body = popup.querySelector(".device-marker-popup__body");
    if (domain === "light") {
      this.renderLightDevicePopupBody(body, state);
    } else {
      this.renderSensorDevicePopupBody(body, state, kind);
    }

    popup.querySelector("[data-device-popup-close]")?.addEventListener("click", () => this.closeDevicePopup());
    popup.hidden = false;
    this.devicePopupEntityId = state.entity_id;
    this.placeDevicePopup(popup, anchorGroup);
  }

  renderLightDevicePopupBody(body, state) {
    const currentBrightness = Number(state.attributes?.brightness);
    const brightnessPct = Number.isFinite(currentBrightness)
      ? Math.max(1, Math.min(100, Math.round((currentBrightness / 255) * 100)))
      : 70;

    body.innerHTML = `
      <label class="device-popup-slider">
        <span>Яркость</span>
        <input data-device-light-brightness type="range" min="1" max="100" value="${brightnessPct}">
        <em data-device-light-brightness-label>${brightnessPct}%</em>
      </label>
      <div class="device-popup-actions">
        <button type="button" data-device-light-on>Вкл</button>
        <button type="button" data-device-light-off>Выкл</button>
      </div>
    `;

    const slider = body.querySelector("[data-device-light-brightness]");
    const label = body.querySelector("[data-device-light-brightness-label]");
    slider.addEventListener("input", () => {
      label.textContent = `${slider.value}%`;
    });
    slider.addEventListener("change", () => {
      const brightnessPct = Number(slider.value);
      ARVID_LOG.info(this.logArea, "Setting single light brightness", {
        entityId: state.entity_id,
        brightnessPct,
      });
      ARVID_APP.ha.callService("light", "turn_on", { brightness_pct: brightnessPct }, { entity_id: state.entity_id });
    });
    body.querySelector("[data-device-light-on]").addEventListener("click", () => {
      ARVID_APP.ha.callService("light", "turn_on", {}, { entity_id: state.entity_id });
    });
    body.querySelector("[data-device-light-off]").addEventListener("click", () => {
      ARVID_APP.ha.callService("light", "turn_off", {}, { entity_id: state.entity_id });
    });
  }

  renderSensorDevicePopupBody(body, state, kind) {
    const unit = state.attributes?.unit_of_measurement || "";
    const value = ArvidDeviceUi.isPanelEvent(state)
      ? ArvidDeviceUi.panelEventText(state)
      : ArvidDeviceUi.isMotion(state)
        ? (ArvidDeviceUi.isMotionActive(state) ? "Есть движение" : "Нет движения")
        : `${state.state}${unit ? ` ${unit}` : ""}`;

    body.innerHTML = `
      <div class="device-popup-metric">
        <span>${this.getSensorDisplayLabel(state, kind)}</span>
        <strong>${value}</strong>
      </div>
      <small>${state.entity_id}</small>
    `;
  }

  placeDevicePopup(popup, anchorGroup) {
    const viewportWidth = window.visualViewport?.width || window.innerWidth;
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const viewportTop = window.visualViewport?.offsetTop || 0;
    const viewportLeft = window.visualViewport?.offsetLeft || 0;
    const padding = 12;
    const rect = anchorGroup?.getBoundingClientRect?.() || document.querySelector("[data-room-svg]")?.getBoundingClientRect?.();

    const width = Math.min(320, viewportWidth - padding * 2);
    popup.style.width = `${width}px`;
    popup.style.left = `${viewportLeft + padding}px`;
    popup.style.top = `${viewportTop + padding}px`;

    const naturalHeight = popup.offsetHeight;
    const left = rect
      ? Math.min(Math.max(rect.left + rect.width / 2 - width / 2, viewportLeft + padding), viewportLeft + viewportWidth - width - padding)
      : viewportLeft + padding;
    const spaceBelow = rect ? viewportTop + viewportHeight - rect.bottom - padding - 8 : viewportHeight;
    const spaceAbove = rect ? rect.top - viewportTop - padding - 8 : 0;
    const openBelow = spaceBelow >= Math.min(naturalHeight, 180) || spaceBelow >= spaceAbove;
    const wantedTop = rect
      ? (openBelow ? rect.bottom + 8 : rect.top - naturalHeight - 8)
      : viewportTop + padding;
    const top = Math.min(
      Math.max(wantedTop, viewportTop + padding),
      viewportTop + viewportHeight - naturalHeight - padding,
    );

    popup.style.left = `${left}px`;
    popup.style.top = `${Math.max(viewportTop + padding, top)}px`;
  }

  closeDevicePopup() {
    if (!this.devicePopup) return;
    this.devicePopup.hidden = true;
    this.devicePopup.innerHTML = "";
    this.devicePopupEntityId = null;
  }

  renderControls() {
    const container = document.querySelector("[data-room-controls]");
    if (!container) return;

    const entities = this.getRoomEntities();
    const lights = entities.filter((state) => state.entity_id.startsWith("light."));
    const sensors = entities.filter((state) => ArvidDeviceUi.isReadableSensor(state));
    const panels = entities.filter((state) => ArvidDeviceUi.isPanelEvent(state));

    container.innerHTML = "";
    if (lights.length) container.appendChild(this.renderLightCard(lights));
    if (sensors.length) container.appendChild(this.renderSensorCard(sensors));
    if (panels.length) container.appendChild(this.renderPanelCard(panels));

    if (!container.children.length) {
      container.innerHTML = "<div class='muted-box'>В этой комнате пока нет поддерживаемых устройств</div>";
    }
  }

  isLightGroup(state) {
    const entityIds = state?.attributes?.entity_id;
    const friendlyName = ArvidDeviceUi.friendlyName(state).toLowerCase();
    const entityId = state?.entity_id?.toLowerCase() || "";

    return Array.isArray(entityIds)
      || entityId.includes("group")
      || entityId.includes("all")
      || friendlyName.includes("группа")
      || friendlyName.includes("весь свет")
      || friendlyName.includes("освещение")
      || friendlyName.includes("group");
  }

  getLightGroups(lights) {
    return lights.filter((state) => this.isLightGroup(state));
  }

  getLightTargetSessionKey() {
    return `arvid.room.${this.areaId}.lightTarget`;
  }

  getLightTargetIds(card, lights) {
    const select = card.querySelector("[data-light-target]");
    const value = select?.value || sessionStorage.getItem(this.getLightTargetSessionKey()) || "all";

    if (value !== "all") return [value];

    // Для всей комнаты отправляем все light.* помещения. Это работает и без групп.
    return lights.map((item) => item.entity_id);
  }

  getAverageBrightnessPct(lights) {
    const brightnessValues = lights
      .map((state) => Number(state.attributes?.brightness))
      .filter((value) => Number.isFinite(value));

    if (!brightnessValues.length) return 70;

    const average = brightnessValues.reduce((sum, value) => sum + value, 0) / brightnessValues.length;
    return Math.max(1, Math.min(100, Math.round((average / 255) * 100)));
  }

  renderLightCard(lights) {
    const card = document.createElement("section");
    card.className = "control-card light-control-card";

    const groups = this.getLightGroups(lights);
    const onCount = lights.filter((state) => state.state === "on").length;
    const brightness = this.getAverageBrightnessPct(lights);
    const showGroupSelect = groups.length > 0;

    card.innerHTML = `
      <header>
        <h3>Освещение</h3>
        <span>${onCount}/${lights.length} включено</span>
      </header>
      ${showGroupSelect ? `
        <label class="compact-field">
          <span>Группа света</span>
          <select data-light-target></select>
        </label>
      ` : ""}
      <label class="slider-row room-main-slider">
        <span>Яркость</span>
        <input data-light-brightness type="range" min="1" max="100" value="${brightness}">
        <em data-light-brightness-label>${brightness}%</em>
      </label>
      <div class="segmented-actions">
        <button data-light-all-on>Вкл</button>
        <button data-light-all-off>Выкл</button>
      </div>
    `;

    const targetSelect = card.querySelector("[data-light-target]");
    if (targetSelect) {
      const allOption = document.createElement("option");
      allOption.value = "all";
      allOption.textContent = "Вся комната";
      targetSelect.appendChild(allOption);

      groups.forEach((group) => {
        const option = document.createElement("option");
        option.value = group.entity_id;
        option.textContent = ArvidDeviceUi.friendlyName(group);
        targetSelect.appendChild(option);
      });

      // Сохраняем выбранную группу хотя бы в текущей вкладке,
      // чтобы после команды и перерисовки карточки список не сбрасывался.
      const savedTarget = sessionStorage.getItem(this.getLightTargetSessionKey());
      const hasSavedTarget = savedTarget && Array.from(targetSelect.options).some((option) => option.value === savedTarget);
      targetSelect.value = hasSavedTarget ? savedTarget : "all";
      targetSelect.addEventListener("change", () => {
        sessionStorage.setItem(this.getLightTargetSessionKey(), targetSelect.value);
        ARVID_LOG.info(this.logArea, "Light target changed", {
          areaId: this.areaId,
          target: targetSelect.value,
        });
      });
    }

    card.querySelector("[data-light-all-on]").addEventListener("click", () => {
      const entityIds = this.getLightTargetIds(card, lights);
      ARVID_LOG.info(this.logArea, "Turning on room light target", { entityIds });
      ARVID_APP.ha.callService("light", "turn_on", {}, { entity_id: entityIds });
    });

    card.querySelector("[data-light-all-off]").addEventListener("click", () => {
      const entityIds = this.getLightTargetIds(card, lights);
      ARVID_LOG.info(this.logArea, "Turning off room light target", { entityIds });
      ARVID_APP.ha.callService("light", "turn_off", {}, { entity_id: entityIds });
    });

    const brightnessInput = card.querySelector("[data-light-brightness]");
    const brightnessLabel = card.querySelector("[data-light-brightness-label]");
    brightnessInput.addEventListener("input", (event) => {
      brightnessLabel.textContent = `${event.target.value}%`;
    });
    brightnessInput.addEventListener("change", (event) => {
      const entityIds = this.getLightTargetIds(card, lights);
      const brightnessPct = Number(event.target.value);
      ARVID_LOG.info(this.logArea, "Setting room light brightness", { entityIds, brightnessPct });
      ARVID_APP.ha.callService("light", "turn_on", { brightness_pct: brightnessPct }, { entity_id: entityIds });
    });

    return card;
  }

  renderSensorCard(sensors) {
    const card = document.createElement("section");
    card.className = "control-card sensor-summary-card";
    card.innerHTML = `
      <header><h3>Статус датчиков</h3><span>${sensors.length}</span></header>
      <div class="sensor-status-list"></div>
    `;

    const list = card.querySelector(".sensor-status-list");
    this.sortSensorsForDisplay(sensors).forEach((state) => list.appendChild(this.renderSensorStatusLine(state)));
    return card;
  }

  sortSensorsForDisplay(sensors) {
    const order = (state) => {
      if (ArvidDeviceUi.isMotion(state)) return 1;
      if (ArvidDeviceUi.isIlluminance(state)) return 2;
      return 9;
    };
    return [...sensors].sort((a, b) => order(a) - order(b));
  }

  renderSensorStatusLine(state) {
    const row = document.createElement("div");
    row.className = "sensor-status-line";

    const unit = state.attributes.unit_of_measurement || "";
    const kind = ArvidDeviceUi.markerKind(state);
    const label = this.getSensorDisplayLabel(state, kind);
    const value = ArvidDeviceUi.isMotion(state)
      ? (ArvidDeviceUi.isMotionActive(state) ? "Есть движение" : "Нет движения")
      : `${state.state}${unit}`;

    row.innerHTML = `
      <span>${label}</span>
      <strong>${value}</strong>
    `;
    return row;
  }

  getSensorDisplayLabel(state, kind) {
    const labels = {
      motion: "Движение",
      illuminance: "Освещённость",
      panel: "Панель",
    };
    return labels[kind] || ArvidDeviceUi.friendlyName(state);
  }

  /**
   * Карточка кнопочных/поворотных панелей: мониторинг последних событий (read-only).
   * Живая лента событий панелей — задача следующих версий (см. DESIGN.md, риск №4).
   */
  renderPanelCard(panels) {
    const card = document.createElement("section");
    card.className = "control-card panel-summary-card";
    card.innerHTML = `
      <header><h3>Панели</h3><span>${panels.length}</span></header>
      <div class="sensor-status-list"></div>
    `;

    const list = card.querySelector(".sensor-status-list");
    panels.forEach((state) => {
      const row = document.createElement("div");
      row.className = "sensor-status-line";
      row.innerHTML = `
        <span>${ArvidDeviceUi.friendlyName(state)}</span>
        <strong>${ArvidDeviceUi.panelEventText(state)}</strong>
      `;
      list.appendChild(row);
    });

    return card;
  }
}

window.ArvidRoomPage = ArvidRoomPage;
