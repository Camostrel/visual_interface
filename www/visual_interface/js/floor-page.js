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
    // Этаж реагирует на ЛЮБОЕ событие (фильтра «своих» нет — см. долг D19), поэтому event не нужен.
    // В комнате наоборот: там event обязателен, иначе фильтр по entity_id молча отсекает всё.
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
      this.updatePlanDeviceStates();   // устройства, объявленные планом (data-entity)
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
      onZoom: (zoom) => this.applyZoomLevel(zoom),
    });

    this.collectPlanDevices();          // устройства, объявленные самим планом (data-entity)
    this.updateMobilePlanLayout();
    this.bindResponsiveResize();
    this.syncRoomZones();
    this.updatePlanDeviceStates();
    this.applyZoomLevel(this.panZoom?.getZoomValue() ?? 1);
    this.renderFloorDashboard();
  }

  /**
   * D2: устройства читаются ИЗ САМОГО ПЛАНА (data-entity), а не из нашего стора координат.
   * Так работают планы из CAD (docs/SVG_PLAN_SPEC.md): конвертер вешает data-entity прямо
   * на геометрию светильника. Ручная расстановка (layout.devices) остаётся для частных
   * объектов и здесь не используется — на этаже её координат нет.
   */
  collectPlanDevices() {
    this.planDevices = [];
    if (!this.svg) return;

    this.svg.querySelectorAll("[data-entity]").forEach((el) => {
      this.planDevices.push({ entityId: el.getAttribute("data-entity"), element: el });
    });

    ARVID_LOG.info(this.logArea, "Устройства прочитаны из плана", {
      floorId: ARVID_APP.currentFloorId,
      count: this.planDevices.length,
    });
  }

  /**
   * Состояние устройств плана: только классы, без перестроения DOM (инвариант v0.6.0).
   * Здоровье сопоставляем по device_id: пара ms_/il_ — одно устройство и один значок,
   * но ДВЕ записи здоровья с разными entity_id (см. health.js).
   */
  updatePlanDeviceStates() {
    if (!this.planDevices?.length) return;

    const health = ARVID_APP.health;

    this.planDevices.forEach(({ entityId, element }) => {
      const state = ARVID_APP.registry.getState(entityId);

      // Устройства нет в HA (план богаче объекта) — гасим, чтобы не выдавать за рабочее.
      element.classList.toggle("is-unknown", !state);
      if (!state) return;

      element.classList.toggle("is-on", ArvidDeviceUi.isOn(state));
      element.classList.toggle("is-active", ArvidDeviceUi.isActive(state));

      let offline = 0;
      let anomaly = 0;
      if (health && health.available !== false) {
        const deviceId = ARVID_APP.registry.getDeviceId(entityId);
        const stats = deviceId ? health.statsForDevice(deviceId) : health.statsForEntity(entityId);
        offline = stats.offline;
        anomaly = stats.anomaly;
      }

      element.classList.toggle("is-offline", offline > 0);
      element.classList.toggle("is-anomaly", offline === 0 && anomaly > 0);
    });
  }

  /**
   * Фаза 3.5 (просьба заказчика): пока план далеко — помещение показывает АГРЕГАТ (зона
   * мигает/красится). Стоит приблизить — зона уступает место конкретным светильникам,
   * и проблемное устройство видно поимённо, без захода в комнату.
   *
   * Сами элементы устройств уже в DOM (их принёс SVG), поэтому переключение — это класс,
   * а не перерисовка: ни создания узлов, ни пересчёта координат.
   */
  applyZoomLevel(zoom) {
    const stage = document.querySelector("[data-floor-svg]");
    if (!stage) return;

    const zoomedIn = zoom >= ArvidFloorPage.DEVICE_ZOOM_THRESHOLD;
    if (stage.classList.contains("is-zoomed") === zoomedIn) return;   // ничего не изменилось

    stage.classList.toggle("is-zoomed", zoomedIn);
    ARVID_LOG.debug(this.logArea, "Масштаб плана", {
      zoom: Math.round(zoom * 100) / 100,
      devicesVisible: zoomedIn,
    });
  }

  /** Порог, за которым помещение «разбивается» на устройства. */
  static get DEVICE_ZOOM_THRESHOLD() {
    return 2.2;
  }

  bindResponsiveResize() {
    if (this._responsiveResizeBound) return;
    this._responsiveResizeBound = true;

    const refresh = () => this.updateMobilePlanLayout();
    window.addEventListener("resize", refresh);
    window.visualViewport?.addEventListener("resize", refresh);
  }

  /**
   * Высоту плана на телефоне задаёт CSS (flex), а не JS (v0.10.1).
   *
   * Раньше здесь считалась высота по пропорциям чертежа: `ширина × ratio`. На плоском плане
   * этажа (857×233, ratio 0.27) контейнер схлопывался до минимума — под ним зияла пустота,
   * а панорамировать было некуда: план тут же уезжал за край.
   *
   * Метод оставлен как точка пересчёта после смены ориентации/размера: убираем инлайн-высоту,
   * если она осталась от прошлой версии в кеше браузера.
   */
  updateMobilePlanLayout() {
    const stage = document.querySelector("[data-floor-svg]");
    if (!stage) return;
    stage.style.removeProperty("--floor-plan-height");
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

  /**
   * Фолбэк: все лампы из реестра (когда HA-группы light.all ещё нет).
   * Группы отсеиваем — иначе команда ушла бы и в группу, и в её же лампы (двойная работа).
   */
  getAllLightEntityIds() {
    return ARVID_APP.registry.states
      .filter((state) => state.entity_id?.startsWith("light.") && !ARVID_APP.isLightGroupState(state))
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

  /**
   * «Выключить свет» из сводки этажа. До v0.9.0 этот путь единственный шёл в обход
   * HA-группы — собирал лампы поиском, нарушая инвариант «свет только через группы».
   * Теперь как везде: группа light.<area_id>, фолбэк — лампы комнаты с предупреждением.
   */
  async turnOffRoomLights(areaId) {
    const group = ARVID_APP.lightGroupState(areaId);

    if (group) {
      await ARVID_APP.ha.callService("light", "turn_off", {}, { entity_id: group.entity_id });
      ARVID_LOG.info(this.logArea, "Room lights turned off via HA group", {
        areaId,
        group: group.entity_id,
      });
      return;
    }

    const entityIds = this.getRoomMemberLights(areaId)
      .filter((state) => state.state === "on")
      .map((state) => state.entity_id);

    if (!entityIds.length) {
      ARVID_LOG.debug(this.logArea, "No active room lights to turn off", { areaId });
      return;
    }

    ARVID_LOG.warn(this.logArea, `Нет HA-группы light.${areaId} — фолбэк на сборку ламп`, { areaId });
    await ARVID_APP.ha.callService("light", "turn_off", {}, { entity_id: entityIds });
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
      zone.dataset.hasArea = String(hasArea);

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
          // Enter/Пробел — основное действие режима: свет в «Освещении», иначе переход в комнату.
          if (this.canToggleLightsFromMap()) this.toggleRoomLights(areaId);
          else this.openRoomByArea(areaId);
        }
      }, { signal: this.roomZoneAbortController.signal });

      bound += 1;
    });

    this.updateZoneAriaLabels();

    ARVID_LOG.debug(this.logArea, "Room SVG zones bound", {
      total: zones.length,
      bound,
      floorId: ARVID_APP.currentFloorId,
    });
  }

  /**
   * Подпись зоны зависит от режима: в «Освещении» тап переключает свет, в остальных — нет.
   * Обновляем и при загрузке плана, и при смене режима (bindRoomZones по режиму не зовём).
   */
  updateZoneAriaLabels() {
    if (!this.svg) return;

    const action = this.canToggleLightsFromMap()
      ? "тап — свет, двойной тап — открыть"
      : "двойной тап — открыть";

    this.svg.querySelectorAll(".room-zone[data-room-id]").forEach((zone) => {
      const areaId = zone.dataset.roomId;
      const label = zone.dataset.hasArea === "true"
        ? `Помещение ${areaId}: ${action}`
        : `Помещение ${areaId} не найдено в Home Assistant`;
      zone.setAttribute("aria-label", label);
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

    // Управление светом с карты живёт только в «Освещении» — подписи зон должны это отражать.
    this.updateZoneAriaLabels();

    // В «Диагностике» снимок нужен сразу и обновляться должен чаще.
    if (mode === "diagnostics") this.refreshHealth();
    this.updateHealthPolling();

    ARVID_LOG.info(this.logArea, "Режим карты изменён", { mode });
  }

  /**
   * Здоровье устройств приходит от ядра DALI, своей логики offline мы не ведём.
   * Основной путь — живая подписка health_subscribe (push, без поллинга);
   * на старом ядре ArvidHealth сам уходит в фолбэк-поллинг health_data.
   */
  initHealth() {
    if (!ARVID_APP.health) return;
    ARVID_APP.health.addUpdateHandler(() => this.applyHealthToUi());
    ARVID_APP.health.start();
  }

  // Разовый снимок нужен только в фолбэк-режиме; в push-режиме метод — no-op.
  refreshHealth() {
    ARVID_APP.health?.refresh();
  }

  /**
   * Только для фолбэк-поллинга (старое ядро): в «Диагностике» опрашиваем чаще,
   * чтобы починенная зона гасла быстро. В push-режиме startPolling ничего не делает.
   */
  updateHealthPolling() {
    if (!ARVID_APP.health) return;

    const interval = this.mapMode === "diagnostics"
      ? ArvidHealth.ACTIVE_INTERVAL_MS
      : ArvidHealth.IDLE_INTERVAL_MS;

    ARVID_APP.health.startPolling(interval);
  }

  // Снимок здоровья влияет на классы зон (агрегат), устройств плана и слот «Предупреждения».
  applyHealthToUi() {
    if (!this.initialized) return;
    this.applyZoneStateClasses();
    this.updatePlanDeviceStates();
    this.renderFloorWarnings();
  }

  /**
   * Управлять светом с карты можно только в режиме «Освещение» (v0.8.1).
   * В «Присутствии» и «Диагностике» карта — информационная: случайный тап по зоне
   * не должен гасить свет в помещении, за которым наблюдают.
   */
  canToggleLightsFromMap() {
    return this.mapMode === "light";
  }

  /**
   * Тап по зоне комнаты: различаем короткий (свет) и двойной (переход) по таймауту.
   * Вне режима «Освещение» короткий тап не делает ничего, двойной по-прежнему открывает комнату.
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

      if (!this.canToggleLightsFromMap()) {
        ARVID_LOG.debug(this.logArea, "Одиночный тап игнорируется: режим карты не «Освещение»", {
          areaId,
          mode: this.mapMode,
        });
        return;
      }

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

  /**
   * Лампы-члены комнаты по составу HA — только ФИЗИЧЕСКИЕ светильники (v0.9.0).
   * Группы (light.<area_id> и DALI-группы ядра с моделью «DALI Group») исключаются:
   * иначе одна лампа считается дважды — сама и через группу.
   */
  getRoomMemberLights(areaId) {
    return ARVID_APP.entitiesForArea(areaId).filter((state) => (
      state.entity_id.startsWith("light.") && !ARVID_APP.isLightGroupState(state)
    ));
  }

  syncRoomZones() {
    // На плане: подсветка зон по состоянию + прямое управление тапом (см. bindRoomZones).
    if (!this.svg) return;
    this.bindRoomZones();
    this.applyZoneStateClasses();
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
