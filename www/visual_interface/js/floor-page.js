/**
 * Main floor navigator page.
 */
class ArvidFloorPage {
  constructor() {
    this.logArea = "floor-page";
    this.svg = null;
    this.panZoom = null;
    this.mobileAccordionSections = [];
    // Режим карты: light | presence | diagnostics (v0.8.0).
    // Зоны всегда несут все классы состояния; какой из них виден — решает CSS
    // по data-map-mode на контейнере плана. Смена режима = один атрибут, без пересчёта.
    this.mapMode = "light";
    this.initialized = false;
  }

  async init(params = {}) {
    if (this.initialized) return this.show(params);

    ARVID_LOG.info(this.logArea, "Initializing floor view");

    await this.initData();
    ArvidShellUi.initTheme(ARVID_APP.layout);
    ArvidShellUi.initViewportHeight();
    ArvidShellUi.renderBrand(ARVID_APP.layout);
    ArvidShellUi.initPanelToggles();
    ArvidShellUi.startClock();

    this.bindUi();
    this.renderFloors();
    this.renderModes();
    this.initMobileAccordions();
    this.initHealth();
    ARVID_RUNTIME.addStateHandler(() => this.handleStateChanged());

    this.initialized = true;
    await this.show(params);

    ARVID_LOG.info(this.logArea, "Floor view initialized");
  }

  async initData() {
    await ARVID_RUNTIME.ensureData(this.logArea);
  }

  async show(params = {}) {
    ArvidShellUi.initPanelToggles();
    const floorId = params.floor_id || this.getInitialFloorId();
    await this.selectFloor(floorId);
  }

  /**
   * Реакция на state_changed (v0.6.0).
   * НЕ вызываем syncRoomZones (он перевешивал обработчики зон на каждое событие)
   * и не пересобираем кнопки режимов. Обновляем только классы и значения,
   * коалесцируя пачку событий в один кадр.
   */
  handleStateChanged() {
    if (!this.initialized) return;

    if (this._floorUpdateScheduled) return;
    this._floorUpdateScheduled = true;
    window.requestAnimationFrame(() => {
      this._floorUpdateScheduled = false;
      this.applyZoneStateClasses();
      this.updateModeCards();
      this.renderFloorDashboard();
    });
  }

  bindUi() {
    // Обрабатываем все кнопки темы: полная панель и иконки в свернутом меню.
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      if (button.dataset.themeToggleReady === "1") return;
      button.dataset.themeToggleReady = "1";
      button.addEventListener("click", () => ArvidShellUi.toggleTheme());
    });

    document.querySelector("[data-floor-select]")?.addEventListener("change", (event) => {
      this.selectFloor(event.target.value).catch((error) => {
        ARVID_LOG.error(this.logArea, "Failed to change floor", error);
      });
    });

    document.querySelector("[data-floor-lights-off]")?.addEventListener("click", () => {
      this.turnOffFloorLights().catch((error) => {
        ARVID_LOG.error(this.logArea, "Failed to turn off floor lights", error);
      });
    });

    // Табы режима карты над планом (v0.8.0). Атрибут выставляем сразу, а не только по клику:
    // до первого переключения плану нужен режим по умолчанию.
    document.querySelectorAll("[data-map-mode-option]").forEach((tab) => {
      tab.addEventListener("click", () => this.setMapMode(tab.dataset.mapModeOption));
    });
    this.setMapMode(this.mapMode);

    document.querySelector("[data-all-lights-on]")?.addEventListener("click", () => {
      this.setAllLights(true).catch((error) => {
        ARVID_LOG.error(this.logArea, "Failed to turn on all lights", error);
      });
    });

    document.querySelector("[data-all-lights-off]")?.addEventListener("click", () => {
      this.setAllLights(false).catch((error) => {
        ARVID_LOG.error(this.logArea, "Failed to turn off all lights", error);
      });
    });
  }

  initMobileAccordions() {
    // Нижняя мобильная панель остаётся набором кнопок, а содержимое переносится в отдельный плавающий слой.
    const panel = document.querySelector(".right-panel");
    const sections = Array.from(document.querySelectorAll(".mobile-accordion-section"));
    if (!panel || !sections.length) return;

    this.mobileAccordionSections = sections;

    const syncPanelState = () => {
      const hasOpenSection = sections.some((section) => section.classList.contains("is-open"));
      panel.classList.toggle("has-mobile-accordion-open", hasOpenSection);

      sections.forEach((section) => {
        const toggle = section.querySelector("[data-mobile-accordion-toggle]");
        if (toggle) {
          toggle.setAttribute("aria-expanded", String(section.classList.contains("is-open")));
        }
      });

      this.placeOpenMobileAccordionBody();
    };

    sections.forEach((section) => {
      const toggle = section.querySelector("[data-mobile-accordion-toggle]");
      if (!toggle || toggle.dataset.accordionReady === "1") return;

      toggle.dataset.accordionReady = "1";
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();

        const shouldOpen = !section.classList.contains("is-open");
        const sectionTitle = toggle.querySelector("span")?.textContent?.trim() || toggle.textContent.trim();

        this.restoreMobileAccordionBody();
        sections.forEach((item) => item.classList.remove("is-open"));

        if (shouldOpen) {
          section.classList.add("is-open");
          this.activateMobileAccordionBody(section);
        } else {
          this.closeFloorSummaryPopover();
        }

        syncPanelState();

        ARVID_LOG.debug(this.logArea, "Mobile bottom panel overlay toggled", {
          title: sectionTitle,
          opened: shouldOpen,
        });
      });
    });

    // Кнопка «Расписание» открывает popup расписания поверх SPA.
    // На мобиле она лежит внутри плавающего слоя аккордиона (z-index 3400 —
    // выше overlay расписания с z-index 200), поэтому при открытии popup слой
    // нужно закрыть, иначе он перекрывает список событий до клика по сторонке.
    const scheduleBtn = document.querySelector("[data-open-schedule]");
    if (scheduleBtn && scheduleBtn.dataset.accordionCloseReady !== "1") {
      scheduleBtn.dataset.accordionCloseReady = "1";
      scheduleBtn.addEventListener("click", () => {
        this.closeMobileAccordionOverlay();
        syncPanelState();
      });
    }

    document.addEventListener("pointerdown", (event) => {
      const openSection = this.getOpenMobileAccordionSection();
      if (!openSection) return;

      const body = this.mobileAccordionFloatingBody;
      const toggle = openSection.querySelector("[data-mobile-accordion-toggle]");
      const target = event.target;

      if (this.summaryPopover?.contains(target)) return;
      if (body?.contains(target)) return;
      if (toggle?.contains(target)) return;

      this.closeMobileAccordionOverlay();
      syncPanelState();
    }, true);

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!this.getOpenMobileAccordionSection()) return;

      this.closeMobileAccordionOverlay();
      syncPanelState();
    });

    const reposition = () => this.placeOpenMobileAccordionBody();
    window.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("resize", reposition);
    document.addEventListener("scroll", reposition, true);

    syncPanelState();
  }

  activateMobileAccordionBody(section) {
    const body = section.querySelector(".mobile-accordion-body");
    if (!body) return;

    // На телефоне выносим содержимое из нижней панели, чтобы overflow родителя не обрезал popover.
    if (!window.matchMedia("(max-width: 760px)").matches) return;

    const placeholder = document.createComment("arvid-mobile-accordion-placeholder");
    section.appendChild(placeholder);
    document.body.appendChild(body);
    body.classList.add("is-floating");

    this.mobileAccordionFloatingBody = body;
    this.mobileAccordionPlaceholder = placeholder;
    this.mobileAccordionOriginalSection = section;

    ARVID_LOG.debug(this.logArea, "Mobile accordion body moved to document overlay", {
      sectionTitle: section.querySelector("[data-mobile-accordion-toggle]")?.textContent?.trim(),
    });
  }

  restoreMobileAccordionBody() {
    const body = this.mobileAccordionFloatingBody;
    const placeholder = this.mobileAccordionPlaceholder;
    const section = this.mobileAccordionOriginalSection;

    if (!body || !section) return;

    body.classList.remove("is-floating");
    body.style.removeProperty("--mobile-accordion-left");
    body.style.removeProperty("--mobile-accordion-top");
    body.style.removeProperty("--mobile-accordion-width");
    body.style.removeProperty("--mobile-accordion-max-height");

    if (placeholder?.parentNode) {
      placeholder.parentNode.insertBefore(body, placeholder);
      placeholder.remove();
    } else {
      section.appendChild(body);
    }

    this.mobileAccordionFloatingBody = null;
    this.mobileAccordionPlaceholder = null;
    this.mobileAccordionOriginalSection = null;
  }

  closeMobileAccordionOverlay() {
    this.mobileAccordionSections.forEach((section) => section.classList.remove("is-open"));
    this.closeFloorSummaryPopover();
    this.restoreMobileAccordionBody();

    ARVID_LOG.debug(this.logArea, "Mobile accordion overlay closed");
  }

  getOpenMobileAccordionSection() {
    return this.mobileAccordionSections.find((section) => section.classList.contains("is-open")) || null;
  }

  placeOpenMobileAccordionBody() {
    const openSection = this.getOpenMobileAccordionSection();
    if (!openSection) return;

    const trigger = openSection.querySelector("[data-mobile-accordion-toggle]");
    let body = this.mobileAccordionFloatingBody || openSection.querySelector(".mobile-accordion-body");
    if (!body || !trigger) return;

    if (!window.matchMedia("(max-width: 760px)").matches) {
      this.restoreMobileAccordionBody();
      body = openSection.querySelector(".mobile-accordion-body");
      if (!body) return;
      body.style.removeProperty("--mobile-accordion-left");
      body.style.removeProperty("--mobile-accordion-top");
      body.style.removeProperty("--mobile-accordion-width");
      body.style.removeProperty("--mobile-accordion-max-height");
      return;
    }

    if (!this.mobileAccordionFloatingBody) {
      this.activateMobileAccordionBody(openSection);
      body = this.mobileAccordionFloatingBody;
      if (!body) return;
    }

    const triggerRect = trigger.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width || window.innerWidth;
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const viewportTop = window.visualViewport?.offsetTop || 0;
    const viewportLeft = window.visualViewport?.offsetLeft || 0;
    const padding = 12;
    const gap = 8;

    const width = Math.min(520, Math.max(280, viewportWidth - padding * 2));
    const left = Math.min(
      Math.max(triggerRect.left, viewportLeft + padding),
      viewportLeft + viewportWidth - width - padding,
    );

    body.style.setProperty("--mobile-accordion-left", `${left}px`);
    body.style.setProperty("--mobile-accordion-width", `${width}px`);
    body.style.setProperty("--mobile-accordion-top", `${viewportTop + padding}px`);
    body.style.setProperty("--mobile-accordion-max-height", `${viewportHeight - padding * 2}px`);

    const naturalHeight = body.scrollHeight;
    const spaceBelow = viewportTop + viewportHeight - triggerRect.bottom - padding - gap;
    const spaceAbove = triggerRect.top - viewportTop - padding - gap;
    const openBelow = spaceBelow >= Math.min(naturalHeight, 220) || spaceBelow >= spaceAbove;
    const chosenSpace = Math.max(180, openBelow ? spaceBelow : spaceAbove);
    const maxHeight = Math.min(chosenSpace, viewportHeight - padding * 2);
    const finalHeight = Math.min(naturalHeight, maxHeight);
    const wantedTop = openBelow
      ? triggerRect.bottom + gap
      : triggerRect.top - gap - finalHeight;
    const minTop = viewportTop + padding;
    const maxTop = viewportTop + viewportHeight - padding - finalHeight;
    const top = Math.min(Math.max(wantedTop, minTop), Math.max(minTop, maxTop));

    body.style.setProperty("--mobile-accordion-top", `${top}px`);
    body.style.setProperty("--mobile-accordion-max-height", `${maxHeight}px`);

    ARVID_LOG.debug(this.logArea, "Mobile bottom panel overlay positioned", {
      top,
      maxHeight,
      openBelow,
    });
  }

  getInitialFloorId() {
    const fromUrl = new URLSearchParams(window.location.search).get("floor_id");
    if (fromUrl) return fromUrl;

    const layoutDefault = ARVID_APP.layout?.building?.default_floor_id;
    if (layoutDefault) return layoutDefault;
    if (ARVID_APP.registry.floors[0]) return ARVID_APP.registry.floors[0].floor_id;
    return null;
  }

  renderFloors() {
    const floorList = document.querySelector("[data-floor-list]");
    const floorSelect = document.querySelector("[data-floor-select]");
    if (!floorList || !floorSelect) return;

    floorList.innerHTML = "";
    floorSelect.innerHTML = "";

    ARVID_APP.registry.floors.forEach((floor) => {
      const item = document.createElement("button");
      item.className = "floor-item";
      item.dataset.floorId = floor.floor_id;
      item.dataset.mobileLabel = this.getMobileFloorLabel(floor);
      item.title = `${floor.name} (${floor.floor_id})`;
      item.innerHTML = `<span>${floor.name}</span><small>${floor.floor_id}</small>`;
      item.addEventListener("click", () => this.selectFloor(floor.floor_id));
      floorList.appendChild(item);

      const option = document.createElement("option");
      option.value = floor.floor_id;
      option.textContent = floor.name;
      floorSelect.appendChild(option);
    });

    ARVID_LOG.info(this.logArea, "Floors rendered", ARVID_APP.registry.floors.length);
  }

  getMobileFloorLabel(floor) {
    // В мобильной верхней панели показываем короткую подпись этажа.
    // Например: "1 этаж" → "1", "2 этаж актовый зал" → "2А".
    const name = floor.name || floor.floor_id || "?";
    const floorId = floor.floor_id || "";
    const numberMatch = name.match(/-?\d+/) || floorId.match(/-?\d+/);
    const number = numberMatch ? numberMatch[0] : name.slice(0, 2).toUpperCase();
    const lowerName = name.toLowerCase();

    if (lowerName.includes("актов")) return `${number}А`;
    if (lowerName.includes("паркин") || lowerName.includes("parking")) return "P";
    return number;
  }

  getFloorSvg(floorId) {
    const configuredSvg = ARVID_APP.layout?.floors?.[floorId]?.svg;
    const svgUrl = ARVID_CONFIG.resolveAssetUrl(configuredSvg, `assets/floors/${floorId}.svg`);
    ARVID_LOG.debug(this.logArea, "Resolved floor SVG", {
      floorId,
      configuredSvg,
      svgUrl,
      fallbackUrl: ARVID_CONFIG.DEFAULT_FLOOR_SVG,
    });
    return svgUrl;
  }

  async selectFloor(floorId) {
    if (!floorId) {
      ARVID_LOG.warn(this.logArea, "No floor selected");
      return;
    }

    this.closeRoomQuickView();
    ARVID_APP.currentFloorId = floorId;
    ARVID_LOG.info(this.logArea, "Selecting floor", floorId);

    document.querySelectorAll(".floor-item").forEach((item) => {
      item.classList.toggle("is-active", item.dataset.floorId === floorId);
    });

    const floorSelect = document.querySelector("[data-floor-select]");
    if (floorSelect) floorSelect.value = floorId;

    const floor = ARVID_APP.registry.floors.find((item) => item.floor_id === floorId);
    document.querySelector("[data-current-floor-name]").textContent = floor?.name || floorId;

    const svgUrl = this.getFloorSvg(floorId);
    const container = document.querySelector("[data-floor-svg]");
    this.svg = await ArvidSvgUtils.loadSvgInto(container, svgUrl, {
      fallbackUrl: ARVID_CONFIG.DEFAULT_FLOOR_SVG,
    });

    // Подключаем управление планом после загрузки SVG, потому что управление меняет viewBox конкретного SVG.
    this.panZoom = ArvidSvgUtils.setupPanZoom(container, this.svg, {
      logArea: this.logArea,
    });

    this.updateMobilePlanLayout();
    this.bindResponsiveResize();
    this.syncRoomZones();
    this.renderFloorDashboard();
  }

  bindResponsiveResize() {
    if (this._responsiveResizeBound) return;
    this._responsiveResizeBound = true;

    const refresh = () => this.updateMobilePlanLayout();
    window.addEventListener("resize", refresh);
    window.visualViewport?.addEventListener("resize", refresh);
  }

  updateMobilePlanLayout() {
    const stage = document.querySelector("[data-floor-svg]");
    if (!stage || !this.svg) return;

    if (!window.matchMedia("(max-width: 760px) and (orientation: portrait)").matches) {
      stage.style.removeProperty("--floor-plan-height");
      return;
    }

    const metrics = ArvidSvgUtils.getViewBoxMetrics(this.svg);
    const stageWidth = stage.clientWidth || document.querySelector(".workspace")?.clientWidth || 320;
    const viewportHeight = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--arvid-app-height"), 10)
      || Math.round(window.visualViewport?.height || window.innerHeight || 0);
    const desiredHeight = Math.round(stageWidth * (metrics?.ratio || 0.4) + 20);
    const maxHeight = Math.max(220, Math.round(viewportHeight * 0.35));
    const nextHeight = Math.max(180, Math.min(desiredHeight, maxHeight));

    stage.style.setProperty("--floor-plan-height", `${nextHeight}px`);
    ARVID_LOG.debug(this.logArea, "Mobile floor plan height updated", {
      stageWidth,
      desiredHeight,
      nextHeight,
      viewportHeight,
    });
  }

  // Фолбэк: все лампы этажа по комнатам (когда HA-группы этажа ещё нет).
  getFloorLightEntityIds() {
    const ids = new Set();
    this.getAreasForCurrentFloor().forEach((area) => {
      this.getRoomMemberLights(area.area_id).forEach((state) => ids.add(state.entity_id));
    });
    return [...ids];
  }

  /**
   * «Выключить свет этажа» (быстрое действие правой панели).
   * Основной путь — HA-группа light.<floor_id> (например light.3_etazh).
   * Фолбэк — сборка ламп по комнатам этажа, с предупреждением.
   */
  async turnOffFloorLights() {
    const floorId = ARVID_APP.currentFloorId;
    const group = ARVID_APP.lightGroupState(floorId);

    if (group) {
      await ARVID_APP.ha.callService("light", "turn_off", {}, { entity_id: group.entity_id });
      ARVID_LOG.info(this.logArea, "Floor lights turned off via HA group", {
        floorId,
        group: group.entity_id,
      });
      return;
    }

    const entityIds = this.getFloorLightEntityIds();
    if (!entityIds.length) {
      ARVID_LOG.warn(this.logArea, "На этаже не найдено ламп для выключения", { floorId });
      return;
    }

    ARVID_LOG.warn(this.logArea, `Нет HA-группы light.${floorId} — фолбэк на сборку ламп этажа`, { floorId });
    await ARVID_APP.ha.callService("light", "turn_off", {}, { entity_id: entityIds });
  }

  // Фолбэк: все light.* из реестра (когда HA-группы всего объекта ещё нет).
  getAllLightEntityIds() {
    return ARVID_APP.registry.states
      .filter((state) => state.entity_id?.startsWith("light."))
      .map((state) => state.entity_id);
  }

  /**
   * «Включить/выключить весь свет» (быстрые действия).
   * Основной путь — HA-группа всего объекта light.all (v0.6.1).
   * Фолбэк — все light.* из реестра, с предупреждением.
   */
  async setAllLights(shouldTurnOn) {
    const service = shouldTurnOn ? "turn_on" : "turn_off";
    const group = ARVID_APP.lightGroupState("all");

    if (group) {
      await ARVID_APP.ha.callService("light", service, {}, { entity_id: group.entity_id });
      ARVID_LOG.info(this.logArea, "All lights action via HA group", {
        group: group.entity_id,
        service,
      });
      return;
    }

    const entityIds = this.getAllLightEntityIds();
    if (!entityIds.length) {
      ARVID_LOG.warn(this.logArea, "No light entities found for global light action");
      return;
    }

    ARVID_LOG.warn(this.logArea, "Нет HA-группы light.all — фолбэк на все light.* из реестра");
    await ARVID_APP.ha.callService("light", service, {}, { entity_id: entityIds });
  }

  async turnOffRoomLights(areaId) {
    const entityIds = ARVID_APP.registry.getEntitiesByDomainForArea(areaId, ["light"])
      .filter((state) => state.state === "on")
      .map((state) => state.entity_id);

    if (!entityIds.length) {
      ARVID_LOG.debug(this.logArea, "No active room lights to turn off", { areaId });
      return;
    }

    await ARVID_APP.ha.callService("light", "turn_off", {}, { entity_id: entityIds });
    ARVID_LOG.info(this.logArea, "Room lights turned off from floor summary", { areaId, entityCount: entityIds.length });
  }

  getAreasForCurrentFloor() {
    return ARVID_APP.registry.areas.filter((area) => area.floor_id === ARVID_APP.currentFloorId);
  }

  getRoomLayout(areaId) {
    return ARVID_APP.layout?.rooms?.[areaId] || null;
  }

  /**
   * Собираем краткую сводку по помещению для Quick View и сводки этажа.
   */
  getRoomStats(areaId) {
    // Состав комнаты — истина HA (area), а не расстановка на плане (v0.7.0).
    const entities = ARVID_APP.entitiesForArea(areaId);
    // Лампы-члены (сама групповая сущность light.<area_id> в счёт не идёт).
    const lights = this.getRoomMemberLights(areaId);
    const lightsOn = lights.filter((state) => state.state === "on");
    const motionSensors = entities.filter((state) => ArvidDeviceUi.isMotion(state));
    const luxSensor = entities.find((state) => ArvidDeviceUi.isIlluminance(state));

    // Истина о «свет включён» — HA-группа комнаты, если она есть; иначе любая лампа.
    const group = ARVID_APP.lightGroupState(areaId);
    const hasLightOn = group ? group.state === "on" : lightsOn.length > 0;

    // Здоровье устройств помещения — снимок ядра DALI (свою логику offline не ведём).
    const health = ARVID_APP.health?.statsForArea(areaId) || { offline: 0, anomaly: 0 };

    return {
      lightsTotal: lights.length,
      hasLightOn,
      lightOnCount: lightsOn.length,
      // Движение есть, если сработал ЛЮБОЙ датчик помещения (а не только первый найденный).
      motionSensor: motionSensors[0],
      motionActive: motionSensors.some((state) => ArvidDeviceUi.isMotionActive(state)),
      luxSensor,
      offlineCount: health.offline,
      anomalyCount: health.anomaly,
    };
  }

  getFloorRoomDashboardRows() {
    return this.getAreasForCurrentFloor().map((area) => ({
      area,
      stats: this.getRoomStats(area.area_id),
    }));
  }

  renderFloorDashboard() {
    this.renderFloorSummary();
    this.renderFloorWarnings();
  }

  renderFloorSummary() {
    const container = document.querySelector("[data-floor-summary]");
    if (!container) return;

    const rows = this.getFloorRoomDashboardRows();
    const lightsOnRooms = rows.filter((row) => row.stats.hasLightOn);
    const motionRooms = rows.filter((row) => row.stats.motionActive);
    const summaryOptions = [
      {
        type: "lights",
        title: "Включён свет",
        count: lightsOnRooms.length,
        rows: lightsOnRooms,
        emptyText: "На этаже нет помещений с включённым светом",
        actionText: "Выключить свет",
        onAction: (areaId) => this.turnOffRoomLights(areaId),
      },
      {
        type: "motion",
        title: "Движение",
        count: motionRooms.length,
        rows: motionRooms,
        emptyText: "Активного движения на этаже нет",
        actionText: "Открыть помещение",
        onAction: (areaId) => this.openRoomByArea(areaId),
      },
    ];

    container.innerHTML = "";
    summaryOptions.forEach((options) => {
      container.appendChild(this.buildFloorSummaryCard(options));
    });

    if (this.openSummaryType && this.summaryPopover && !this.summaryPopover.hidden) {
      const options = summaryOptions.find((item) => item.type === this.openSummaryType);
      const trigger = container.querySelector(`[data-summary-type="${this.openSummaryType}"] .floor-summary-toggle`);
      if (options && trigger) {
        this.openFloorSummaryPopover(options, trigger);
      } else {
        this.closeFloorSummaryPopover();
      }
    }
  }

  buildFloorSummaryCard(options) {
    const wrapper = document.createElement("div");
    wrapper.className = "floor-summary-card";
    wrapper.dataset.summaryType = options.type;

    const toggle = document.createElement("button");
    toggle.className = "floor-summary-toggle";
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(this.openSummaryType === options.type));
    toggle.innerHTML = `<span>${options.title}</span><strong>${options.count}</strong>`;
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleFloorSummaryPopover(options, toggle);
    });
    wrapper.appendChild(toggle);

    if (this.openSummaryType === options.type) {
      wrapper.classList.add("is-open");
    }

    return wrapper;
  }

  toggleFloorSummaryPopover(options, trigger) {
    // Список сводки показываем плавающим слоем, чтобы он не менял высоту правой панели.
    const isSamePopoverOpen = this.openSummaryType === options.type
      && this.summaryPopover
      && !this.summaryPopover.hidden;

    if (isSamePopoverOpen) {
      this.closeFloorSummaryPopover();
      return;
    }

    this.openFloorSummaryPopover(options, trigger);
  }

  openFloorSummaryPopover(options, trigger) {
    const popover = this.ensureFloorSummaryPopover();
    this.openSummaryType = options.type;
    this.summaryPopoverTrigger = trigger;
    this.currentSummaryOptions = options;

    document.querySelectorAll(".floor-summary-card").forEach((card) => {
      const isCurrent = card.dataset.summaryType === options.type;
      card.classList.toggle("is-open", isCurrent);
      card.querySelector(".floor-summary-toggle")?.setAttribute("aria-expanded", String(isCurrent));
    });

    popover.innerHTML = "";
    const title = document.createElement("div");
    title.className = "floor-summary-popover-title";
    title.innerHTML = `<span>${options.title}</span><strong>${options.count}</strong>`;
    popover.appendChild(title);

    if (!options.rows.length) {
      const empty = document.createElement("div");
      empty.className = "muted-box";
      empty.textContent = options.emptyText;
      popover.appendChild(empty);
    } else {
      options.rows.forEach((row) => {
        const { area, warning } = row;
        const item = document.createElement("button");
        item.className = "floor-summary-room";
        item.type = "button";
        item.innerHTML = warning
          ? `<span>${area.name || area.area_id}</span><small>${warning.value} · ${options.actionText}</small>`
          : `<span>${area.name || area.area_id}</span><small>${options.actionText}</small>`;
        item.addEventListener("click", async (event) => {
          event.stopPropagation();
          try {
            item.disabled = true;
            await options.onAction(area.area_id, warning);
            ARVID_LOG.info(this.logArea, "Floor summary popover action executed", {
              type: options.type,
              areaId: area.area_id,
            });
          } catch (error) {
            ARVID_LOG.error(this.logArea, "Floor summary popover action failed", {
              type: options.type,
              areaId: area.area_id,
              error,
            });
          } finally {
            item.disabled = false;
          }
        });
        popover.appendChild(item);
      });
    }

    popover.hidden = false;
    this.placeFloorSummaryPopover();
    this.bindFloorSummaryPopoverEvents();

    ARVID_LOG.debug(this.logArea, "Floor summary popover opened", {
      type: options.type,
      count: options.count,
    });
  }

  ensureFloorSummaryPopover() {
    if (this.summaryPopover) return this.summaryPopover;

    const popover = document.createElement("div");
    popover.className = "floor-summary-popover";
    popover.hidden = true;
    popover.addEventListener("click", (event) => event.stopPropagation());
    document.body.appendChild(popover);
    this.summaryPopover = popover;
    return popover;
  }

  bindFloorSummaryPopoverEvents() {
    if (this.summaryPopoverEventsReady) return;

    // Любой клик вне плавающего списка закрывает список. Клик внутри списка его не закрывает.
    this.handleSummaryPopoverOutsidePointer = (event) => {
      const target = event.target;
      if (this.summaryPopover?.contains(target)) return;
      if (target.closest?.(".floor-summary-toggle")) return;
      this.closeFloorSummaryPopover();
    };

    this.handleSummaryPopoverEscape = (event) => {
      if (event.key === "Escape") this.closeFloorSummaryPopover();
    };

    this.handleSummaryPopoverReposition = () => {
      if (!this.summaryPopover || this.summaryPopover.hidden) return;
      if (!this.summaryPopoverTrigger?.isConnected) {
        this.closeFloorSummaryPopover();
        return;
      }
      this.placeFloorSummaryPopover();
    };

    document.addEventListener("pointerdown", this.handleSummaryPopoverOutsidePointer, true);
    document.addEventListener("keydown", this.handleSummaryPopoverEscape);
    window.addEventListener("resize", this.handleSummaryPopoverReposition);
    window.visualViewport?.addEventListener("resize", this.handleSummaryPopoverReposition);
    document.addEventListener("scroll", this.handleSummaryPopoverReposition, true);
    this.summaryPopoverEventsReady = true;
  }

  placeFloorSummaryPopover() {
    if (!this.summaryPopover || !this.summaryPopoverTrigger) return;

    const popover = this.summaryPopover;
    const triggerRect = this.summaryPopoverTrigger.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width || window.innerWidth;
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const viewportTop = window.visualViewport?.offsetTop || 0;
    const viewportLeft = window.visualViewport?.offsetLeft || 0;
    const padding = 12;
    const gap = 8;
    const isMobile = window.matchMedia("(max-width: 760px)").matches;
    const width = isMobile
      ? viewportWidth - padding * 2
      : Math.min(Math.max(triggerRect.width, 280), viewportWidth - padding * 2);
    const left = isMobile
      ? viewportLeft + padding
      : Math.min(Math.max(triggerRect.left, viewportLeft + padding), viewportLeft + viewportWidth - width - padding);

    popover.style.width = `${Math.max(220, width)}px`;
    popover.style.left = `${left}px`;
    popover.style.maxHeight = "none";
    popover.style.top = "0px";

    const naturalHeight = popover.offsetHeight;
    const spaceBelow = viewportTop + viewportHeight - triggerRect.bottom - padding - gap;
    const spaceAbove = triggerRect.top - viewportTop - padding - gap;
    const openBelow = spaceBelow >= Math.min(naturalHeight, 220) || spaceBelow >= spaceAbove;
    const totalAvailableHeight = Math.max(80, viewportHeight - padding * 2);
    const chosenSpace = Math.max(0, openBelow ? spaceBelow : spaceAbove);
    const availableHeight = Math.min(Math.max(80, chosenSpace), totalAvailableHeight);
    const finalHeight = Math.min(naturalHeight, availableHeight);
    const wantedTop = openBelow
      ? triggerRect.bottom + gap
      : triggerRect.top - gap - finalHeight;
    const minTop = viewportTop + padding;
    const maxTop = viewportTop + viewportHeight - padding - finalHeight;
    const top = Math.min(Math.max(wantedTop, minTop), Math.max(minTop, maxTop));

    popover.style.maxHeight = `${availableHeight}px`;
    popover.style.top = `${top}px`;
  }

  closeFloorSummaryPopover() {
    if (this.summaryPopover) {
      this.summaryPopover.hidden = true;
      this.summaryPopover.innerHTML = "";
    }

    document.querySelectorAll(".floor-summary-card").forEach((card) => {
      card.classList.remove("is-open");
      card.querySelector(".floor-summary-toggle")?.setAttribute("aria-expanded", "false");
    });

    if (this.openSummaryType) {
      ARVID_LOG.debug(this.logArea, "Floor summary popover closed", {
        type: this.openSummaryType,
      });
    }

    this.openSummaryType = null;
    this.summaryPopoverTrigger = null;
    this.currentSummaryOptions = null;
  }

  /**
   * Предупреждения этажа — из снимка ядра DALI (health_data).
   * Упавший шлюз к помещению не привязан, поэтому идёт отдельной строкой, а не подсветкой зоны.
   */
  renderFloorWarnings() {
    const container = document.querySelector("[data-floor-warnings]");
    if (!container) return;

    const health = ARVID_APP.health;
    if (!health || health.available === false) {
      container.innerHTML = "<div class='muted-box'>Данные о здоровье недоступны</div>";
      return;
    }

    const areaIds = this.getAreasForCurrentFloor().map((area) => area.area_id);
    const { offline, anomaly, rooms } = health.statsForAreas(areaIds);
    const gateways = health.gatewayIssues;

    if (!offline && !anomaly && !gateways.length) {
      container.innerHTML = "<div class='muted-box'>Предупреждений нет</div>";
      return;
    }

    // Имена устройств и помещений задают люди — собираем узлы, а не строку HTML.
    container.innerHTML = "";
    gateways.forEach((issue) => {
      container.appendChild(this.buildFloorWarning("Шлюз не на связи", issue.name, "is-critical"));
    });

    rooms.forEach((room) => {
      const areaName = ARVID_APP.registry.areas.find((area) => area.area_id === room.areaId)?.name || room.areaId;
      const parts = [];
      if (room.offline) parts.push(`не на связи: ${room.offline}`);
      if (room.anomaly) parts.push(`аномалии: ${room.anomaly}`);
      container.appendChild(this.buildFloorWarning(areaName, parts.join(" · "), room.offline ? "is-critical" : "is-warning"));
    });

    if (health.unmappedCount) {
      container.appendChild(this.buildFloorWarning("Без помещения", `устройств: ${health.unmappedCount}`, ""));
    }
  }

  buildFloorWarning(title, detail, severityClass) {
    const row = document.createElement("div");
    row.className = `floor-warning ${severityClass}`.trim();
    row.textContent = title;

    const small = document.createElement("small");
    small.textContent = detail;
    row.appendChild(small);

    return row;
  }

  openRoomByArea(areaId) {
    const params = new URLSearchParams();
    params.set("area_id", areaId);
    params.set("floor_id", ARVID_APP.currentFloorId);
    window.ARVID_SPA?.navigate("room", Object.fromEntries(params.entries()));
  }

  formatRoomMetricValue(state, fallbackUnit = "") {
    if (!state) return "—";
    const unit = state.attributes?.unit_of_measurement || fallbackUnit;
    return `${state.state}${unit ? ` ${unit}` : ""}`;
  }

  getRoomQuickViewMetrics(stats) {
    // Карточка «Свет» должна оставаться первой: клик по ней переключает свет помещения.
    return [
      {
        label: "Свет",
        value: stats.lightsTotal ? `${stats.lightOnCount}/${stats.lightsTotal}` : "нет",
        active: stats.hasLightOn,
      },
      {
        label: "Движение",
        value: stats.motionActive ? "есть" : "нет",
        active: stats.motionActive,
      },
      {
        label: "Освещённость",
        value: this.formatRoomMetricValue(stats.luxSensor, "lx"),
        active: Boolean(stats.luxSensor),
      },
    ];
  }

  bindRoomZones() {
    if (!this.svg) return;

    // После загрузки нового SVG сбрасываем старые обработчики, чтобы не ловить клики с прошлого этажа.
    this.roomZoneAbortController?.abort();
    this.roomZoneAbortController = new AbortController();

    const zones = Array.from(this.svg.querySelectorAll(".room-zone[data-room-id]"));
    const availableAreaIds = new Set(this.getAreasForCurrentFloor().map((area) => area.area_id));
    let bound = 0;

    zones.forEach((zone) => {
      const areaId = zone.dataset.roomId;
      const hasArea = availableAreaIds.has(areaId);
      zone.classList.toggle("is-disabled", !hasArea);
      zone.setAttribute("tabindex", hasArea ? "0" : "-1");
      zone.setAttribute("role", "button");
      zone.setAttribute("aria-label", hasArea ? `Помещение ${areaId}: тап — свет, двойной тап — открыть` : `Помещение ${areaId} не найдено в Home Assistant`);

      if (!hasArea) return;

      // Модель взаимодействия (v0.5.0, ТЗ заказчика):
      // короткий тап = вкл/выкл света комнаты; двойной тап = переход на план комнаты.
      zone.addEventListener("click", (event) => {
        event.stopPropagation();
        this.handleZoneTap(areaId);
      }, { signal: this.roomZoneAbortController.signal });

      zone.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.toggleRoomLights(areaId); // Enter/Пробел — основное действие (свет)
        }
      }, { signal: this.roomZoneAbortController.signal });

      bound += 1;
    });

    ARVID_LOG.debug(this.logArea, "Room SVG zones bound", {
      total: zones.length,
      bound,
      floorId: ARVID_APP.currentFloorId,
    });
  }

  /**
   * Режим карты (слой подсветки полигонов): light | presence | diagnostics.
   * Классы состояния на зонах уже стоят (applyZoneStateClasses) — здесь только переключаем
   * атрибут, по которому CSS решает, какой слой показывать. Перерисовки нет.
   */
  setMapMode(mode) {
    this.mapMode = mode;

    const stage = document.querySelector("[data-floor-svg]");
    if (stage) stage.dataset.mapMode = mode;

    document.querySelectorAll("[data-map-mode-option]").forEach((tab) => {
      const isActive = tab.dataset.mapModeOption === mode;
      tab.setAttribute("aria-pressed", String(isActive));
      tab.classList.toggle("is-active", isActive);
    });

    // В «Диагностике» снимок нужен сразу и обновляться должен чаще.
    if (mode === "diagnostics") this.refreshHealth();
    this.updateHealthPolling();

    ARVID_LOG.info(this.logArea, "Режим карты изменён", { mode });
  }

  /**
   * Здоровье устройств приходит от ядра DALI (arvid_dali_center/health_data), своей логики
   * offline мы не ведём. Первый снимок берём сразу, дальше — по таймеру.
   */
  initHealth() {
    if (!ARVID_APP.health) return;
    ARVID_APP.health.setUpdateHandler(() => this.applyHealthToUi());
    this.refreshHealth();
    this.updateHealthPolling();
  }

  // UI обновится сам — через обработчик, поставленный в initHealth.
  refreshHealth() {
    ARVID_APP.health?.refresh();
  }

  /**
   * Частота опроса: ошибка не может появиться раньше грейса ядра (5 мин), поэтому в фоне
   * опрашиваем раз в 5 минут. В «Диагностике» чаще — чтобы починенная зона гасла быстро.
   */
  updateHealthPolling() {
    if (!ARVID_APP.health) return;

    const interval = this.mapMode === "diagnostics"
      ? ArvidHealth.ACTIVE_INTERVAL_MS
      : ArvidHealth.IDLE_INTERVAL_MS;

    ARVID_APP.health.startPolling(interval);
  }

  // Снимок здоровья влияет на классы зон (offline/аномалия) и на слот «Предупреждения».
  applyHealthToUi() {
    if (!this.initialized) return;
    this.applyZoneStateClasses();
    this.renderFloorWarnings();
  }

  /**
   * Тап по зоне комнаты: различаем короткий (свет) и двойной (переход) по таймауту.
   */
  handleZoneTap(areaId) {
    if (this._zoneTapTimer && this._zoneTapAreaId === areaId) {
      // Второй тап по той же зоне в пределах окна — это двойной тап.
      window.clearTimeout(this._zoneTapTimer);
      this._zoneTapTimer = null;
      this._zoneTapAreaId = null;
      this.openRoomByArea(areaId);
      return;
    }

    this._zoneTapAreaId = areaId;
    this._zoneTapTimer = window.setTimeout(() => {
      this._zoneTapTimer = null;
      this._zoneTapAreaId = null;
      this.toggleRoomLights(areaId);
    }, 250);
  }

  /**
   * Вкл/выкл всего света комнаты (короткий тап по зоне).
   * Основной путь — HA-группа light.<area_id> (детерминированно).
   * Фолбэк (группы ещё нет) — сборка ламп комнаты, с предупреждением в лог.
   */
  async toggleRoomLights(areaId) {
    const group = ARVID_APP.lightGroupState(areaId);

    if (group) {
      const action = group.state === "on" ? "turn_off" : "turn_on";
      await ARVID_APP.ha.callService("light", action, {}, { entity_id: group.entity_id });
      ARVID_LOG.info(this.logArea, "Room lights toggled via HA group", {
        areaId,
        group: group.entity_id,
        action,
      });
      return;
    }

    const lights = this.getRoomMemberLights(areaId);
    if (!lights.length) {
      ARVID_LOG.warn(this.logArea, "Zone tap: в комнате нет света", { areaId });
      return;
    }

    ARVID_LOG.warn(this.logArea, `Нет HA-группы light.${areaId} — фолбэк на сборку ламп`, { areaId });
    const action = lights.some((state) => state.state === "on") ? "turn_off" : "turn_on";
    await ARVID_APP.ha.callService("light", action, {}, {
      entity_id: lights.map((state) => state.entity_id),
    });
  }

  // Лампы-члены комнаты по составу HA (без самой групповой сущности light.<area_id>).
  getRoomMemberLights(areaId) {
    const groupId = `light.${areaId}`;
    return ARVID_APP.entitiesForArea(areaId).filter((state) => (
      state.entity_id.startsWith("light.") && state.entity_id !== groupId
    ));
  }

  syncRoomZones() {
    // На плане: подсветка зон по состоянию + прямое управление тапом (см. bindRoomZones).
    if (!this.svg) return;
    this.bindRoomZones();
    this.applyZoneStateClasses();

    if (this.quickViewAreaId) {
      this.refreshRoomQuickView();
    }
  }

  /**
   * Классы состояния зон — сразу все, независимо от режима карты (v0.8.0):
   *   has-light-on  — включён свет           (режим «Освещение»)
   *   has-motion    — есть движение          (режим «Присутствие»)
   *   has-offline   — устройства не на связи (режим «Диагностика», красный пульс)
   *   has-anomaly   — залипший датчик и т.п. (режим «Диагностика», янтарный)
   * Что из этого видно — решает CSS по data-map-mode. Так смена режима не требует пересчёта,
   * а state_changed по-прежнему трогает только классы, не DOM.
   * Вызывается при загрузке плана, на state_changed и после снимка health.
   */
  applyZoneStateClasses() {
    if (!this.svg) return;
    this.svg.querySelectorAll(".room-zone[data-room-id]").forEach((zone) => {
      const stats = this.getRoomStats(zone.dataset.roomId);
      zone.classList.toggle("has-light-on", stats.hasLightOn);
      zone.classList.toggle("has-motion", stats.motionActive);
      zone.classList.toggle("has-offline", stats.offlineCount > 0);
      zone.classList.toggle("has-anomaly", stats.offlineCount === 0 && stats.anomalyCount > 0);
    });
  }

  getRoomZoneCenter(areaId) {
    const zone = this.svg?.querySelector(`.room-zone[data-room-id="${CSS.escape(areaId)}"]`);
    if (!zone || typeof zone.getBBox !== "function") return null;

    try {
      const box = zone.getBBox();
      const point = this.svg.createSVGPoint();
      point.x = box.x + box.width / 2;
      point.y = box.y + box.height / 2;
      const screenPoint = point.matrixTransform(this.svg.getScreenCTM());
      return { x: screenPoint.x, y: screenPoint.y };
    } catch (error) {
      ARVID_LOG.warn(this.logArea, "Failed to calculate room zone center", { areaId, error });
      return null;
    }
  }

  getQuickViewPosition(areaId, event) {
    // При обновлении состояния (event=null) сохраняем текущую позицию без пересчёта.
    if (!event && this.quickView?.classList.contains("is-open")) {
      return {
        left: parseFloat(this.quickView.style.getPropertyValue("--quick-view-left")) || 16,
        top: parseFloat(this.quickView.style.getPropertyValue("--quick-view-top")) || 16,
        width: parseFloat(this.quickView.style.getPropertyValue("--quick-view-width")) || 320,
      };
    }

    const viewportWidth = window.visualViewport?.width || window.innerWidth;
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const viewportLeft = window.visualViewport?.offsetLeft || 0;
    const viewportTop = window.visualViewport?.offsetTop || 0;
    const padding = 12;
    const width = Math.min(320, viewportWidth - padding * 2);
    const height = 290;
    const anchor = event?.clientX !== undefined
      ? { x: event.clientX, y: event.clientY }
      : this.getRoomZoneCenter(areaId) || { x: viewportLeft + viewportWidth / 2, y: viewportTop + viewportHeight / 2 };

    let left = anchor.x + 14;
    let top = anchor.y + 14;

    if (left + width > viewportLeft + viewportWidth - padding) {
      left = anchor.x - width - 14;
    }

    if (top + height > viewportTop + viewportHeight - padding) {
      top = anchor.y - height - 14;
    }

    left = Math.max(viewportLeft + padding, Math.min(left, viewportLeft + viewportWidth - width - padding));
    top = Math.max(viewportTop + padding, Math.min(top, viewportTop + viewportHeight - height - padding));

    return { left, top, width };
  }

  ensureRoomQuickView() {
    if (this.quickView) return this.quickView;

    const quickView = document.createElement("aside");
    quickView.className = "floor-room-quick-view";
    quickView.setAttribute("role", "dialog");
    quickView.setAttribute("aria-live", "polite");
    document.body.appendChild(quickView);

    if (!this._quickViewCloseBound) {
      this._quickViewCloseBound = true;

      document.addEventListener("pointerdown", (event) => {
        if (!this.quickView?.classList.contains("is-open")) return;
        if (this.quickView.contains(event.target)) return;
        if (event.target.closest?.(".room-zone")) return;
        this.closeRoomQuickView();
      }, true);

      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") this.closeRoomQuickView();
      });
    }

    this.quickView = quickView;
    return quickView;
  }

  openRoomQuickView(areaId, event = null) {
    const area = ARVID_APP.registry.areas.find((item) => item.area_id === areaId);
    if (!area) {
      ARVID_LOG.warn(this.logArea, "Room quick view skipped: area not found", { areaId });
      return;
    }

    this.quickViewAreaId = areaId;
    this.svg?.querySelectorAll(".room-zone").forEach((zone) => {
      zone.classList.toggle("is-active", zone.dataset.roomId === areaId);
    });

    this.refreshRoomQuickView(event);

    ARVID_LOG.info(this.logArea, "Room quick view opened", {
      areaId,
      floorId: ARVID_APP.currentFloorId,
    });
  }

  refreshRoomQuickView(event = null) {
    if (!this.quickViewAreaId) return;

    const areaId = this.quickViewAreaId;
    const area = ARVID_APP.registry.areas.find((item) => item.area_id === areaId);
    if (!area) {
      this.closeRoomQuickView();
      return;
    }

    const stats = this.getRoomStats(areaId);
    const metrics = this.getRoomQuickViewMetrics(stats);
    const params = new URLSearchParams();
    params.set("area_id", areaId);
    params.set("floor_id", ARVID_APP.currentFloorId);

    const quickView = this.ensureRoomQuickView();
    quickView.innerHTML = `
      <div class="floor-room-quick-view__header">
        <div>
          <span>Помещение</span>
          <strong>${area.name || areaId}</strong>
        </div>
        <button type="button" data-quick-view-close aria-label="Закрыть">×</button>
      </div>
      <div class="floor-room-quick-view__metrics">
        ${metrics.map((metric, index) => `
          <div class="floor-room-quick-view__metric ${metric.active ? "is-active" : ""} ${index === 0 && stats.lightsTotal > 0 ? "is-clickable" : ""}" ${index === 0 && stats.lightsTotal > 0 ? "data-quick-view-light-toggle" : ""}>
            <span>${metric.label}</span>
            <strong>${metric.value}</strong>
          </div>
        `).join("")}
      </div>
      <a class="floor-room-quick-view__open" href="index.html?view=room&${params.toString()}" data-spa-link>Открыть помещение</a>
    `;

    quickView.querySelector("[data-quick-view-close]")?.addEventListener("click", () => this.closeRoomQuickView());
    quickView.querySelector("[data-quick-view-light-toggle]")?.addEventListener("click", () => {
      const lightEntityIds = ARVID_APP.registry.getEntitiesByDomainForArea(areaId, ["light"])
        .map((state) => state.entity_id);
      if (!lightEntityIds.length) return;
      const action = stats.hasLightOn ? "turn_off" : "turn_on";
      ARVID_APP.ha.callService("light", action, {}, { entity_id: lightEntityIds })
        .catch((err) => ARVID_LOG.error(this.logArea, "Quick View: ошибка переключения света", err));
    });

    const position = this.getQuickViewPosition(areaId, event);
    quickView.style.setProperty("--quick-view-left", `${position.left}px`);
    quickView.style.setProperty("--quick-view-top", `${position.top}px`);
    quickView.style.setProperty("--quick-view-width", `${position.width}px`);

    // Точка раскрытия Quick View — позиция клика относительно карточки.
    const anchor = event?.clientX !== undefined
      ? { x: event.clientX, y: event.clientY }
      : { x: position.left, y: position.top };
    quickView.style.setProperty("--quick-view-origin-x", `${Math.max(0, Math.min(anchor.x - position.left, position.width))}px`);
    quickView.style.setProperty("--quick-view-origin-y", `${Math.max(0, Math.min(anchor.y - position.top, 290))}px`);

    // Сбрасываем в закрытое состояние и форсируем reflow — анимация запускается каждый раз.
    quickView.classList.remove("is-open");
    quickView.getBoundingClientRect();
    quickView.classList.add("is-open");
  }

  closeRoomQuickView() {
    if (!this.quickView?.classList.contains("is-open")) return;

    const areaId = this.quickViewAreaId;
    this.quickView.classList.remove("is-open");
    this.quickViewAreaId = null;
    this.svg?.querySelectorAll(".room-zone.is-active").forEach((zone) => zone.classList.remove("is-active"));

    ARVID_LOG.debug(this.logArea, "Room quick view closed", { areaId });
  }

  getDisplayModes() {
    // Для наглядности всегда показываем базовую пару режимов: Авто и Ручной.
    const modes = [...(ARVID_APP.layout?.modes || [])];
    const hasAuto = modes.some((mode) => String(mode.title || "").toLowerCase().includes("авто"));
    const hasManual = modes.some((mode) => String(mode.title || "").toLowerCase().includes("руч"));

    if (!hasAuto) {
      modes.unshift({ title: "Авто", entity_id: "input_boolean.auto_mode", is_fallback: true });
    }

    if (!hasManual) {
      modes.push({ title: "Ручной", entity_id: "input_boolean.manual_mode", is_fallback: true });
    }

    return modes;
  }

  renderModes() {
    const container = document.querySelector("[data-building-modes]");
    if (!container) return;

    const modes = this.getDisplayModes();
    container.innerHTML = "";

    modes.forEach((mode) => {
      const state = ARVID_APP.registry.getState(mode.entity_id);
      const button = document.createElement("button");
      button.className = `mode-card ${state?.state === "on" ? "is-active" : ""} ${!state ? "is-demo" : ""}`;
      // Якорь для точечного обновления класса (демо-режимы не трогаем).
      if (state) button.dataset.modeEntity = mode.entity_id;
      button.innerHTML = `<strong>${mode.title}</strong><small>${state ? mode.entity_id : "визуальный режим"}</small>`;
      button.addEventListener("click", () => {
        if (!state) {
          // Взаимоисключающее переключение: только один демо-режим может быть активен
          const wasActive = button.classList.contains("is-active");
          container.querySelectorAll(".mode-card.is-demo").forEach((card) => card.classList.remove("is-active"));
          if (!wasActive) button.classList.add("is-active");
          ARVID_LOG.warn(this.logArea, "Mode entity is not found, only visual state was toggled", mode);
          return;
        }

        const domain = mode.entity_id.split(".")[0];
        ARVID_APP.ha.callService(domain, "toggle", {}, { entity_id: mode.entity_id });
      });
      container.appendChild(button);
    });
  }

  // Обновление активности режимов без пересоздания кнопок.
  updateModeCards() {
    document.querySelectorAll(".mode-card[data-mode-entity]").forEach((button) => {
      const state = ARVID_APP.registry.getState(button.dataset.modeEntity);
      if (state) button.classList.toggle("is-active", state.state === "on");
    });
  }
}

window.ArvidFloorPage = ArvidFloorPage;
