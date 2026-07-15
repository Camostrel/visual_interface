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
    // Режим редактирования расстановки устройств (v0.2.0) — вместо отдельной страницы редактора.
    this.editMode = false;
    this.editDirty = false;
    this.editSelectedEntityId = null;
    this.editFilter = "all";
    this.editSearch = "";
    this.editStatusText = "";
    this.deviceDrag = null;
    this.initialized = false;
  }

  async init(params = {}) {
    if (this.initialized) return this.show(params);

    ARVID_LOG.info(this.logArea, "Initializing room view");

    await this.initData();
    ArvidShellUi.initTheme(ARVID_APP.layout);
    ArvidShellUi.initConnectionStatus();   // плашка «нет связи» (A3)
    ArvidShellUi.initViewportHeight();
    ArvidShellUi.renderBrand(ARVID_APP.layout);
    ArvidShellUi.initPanelToggles();
    ArvidShellUi.startClock();

    this.bindUi();
    // Событие обязательно пробрасывать: handleStateChanged фильтрует по entity_id события.
    ARVID_RUNTIME.addStateHandler((event) => this.handleStateChanged(event));

    // Здоровье устройств (D6): снимок приходит push'ем от ядра — обновляем маркеры и карточки.
    // start() идемпотентен: комнату можно открыть прямой ссылкой, минуя план этажа.
    ARVID_APP.health?.addUpdateHandler(() => this.handleHealthChanged());
    ARVID_APP.health?.start();

    // Состав комнаты изменился в HA (устройству задали area, добавили лампу) — D5.
    // Значение состояния карточки не пересобирает, а вот появление устройства — обязано.
    ARVID_APP.registry.addCompositionHandler(() => this.handleCompositionChanged());

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
    this.invalidateRoomEntityCache(); // сменилась комната — состав пересоберём лениво
  }

  async show(params = {}) {
    this.setRouteParams(params);

    // При каждом показе комнаты выходим из режима редактирования;
    // несохранённые изменения разруливаем через подтверждение.
    if (this.editMode) {
      await this.resolveEditDirty();
      this.setEditMode(false, { skipRender: true });
    }

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

  /**
   * Реакция на state_changed (v0.6.0).
   * НЕ перестраиваем DOM: полная перерисовка карточек ломала взаимодействие
   * (кнопки/слайдер мигали при потоке показаний люкс-датчика). Обновляем только значения.
   */
  handleStateChanged(event) {
    if (!this.initialized || !this.areaId) return;
    // В режиме редактирования состояние на разметку не влияет (и drag не должен дёргаться).
    if (this.editMode) return;

    const entityId = event?.data?.entity_id;
    if (!entityId || !this.isRoomEntityId(entityId)) return; // чужие сущности игнорируем

    this.scheduleStateUpdate();
  }

  /**
   * Новый снимок здоровья (D6). Плашку «не на связи» строит render, поэтому её обновляем
   * полной перерисовкой карточек — но только когда состав недоступных РЕАЛЬНО изменился,
   * иначе push'и дёргали бы DOM (инвариант «не перестраивать по потоку событий»).
   * Маркеры и значения обновляются точечно всегда.
   */
  handleHealthChanged() {
    if (!this.initialized || !this.areaId || this.editMode) return;

    const signature = this.getOfflineSignature();
    const changed = signature !== this._offlineSignature;
    this._offlineSignature = signature;

    if (changed) {
      this.renderControls();        // плашка + состав «не на связи»
      this.renderDeviceMarkers();
      this.updatePlanDeviceStates(); // элементы плана не пересоздаются — обновляем классы
      return;
    }

    this.scheduleStateUpdate();
  }

  /**
   * Состав комнаты изменился (D5): в HA появилось/исчезло устройство, поменялась area.
   * Раньше карточки застывали до перехода в другую комнату и обратно — `render*` вызывался
   * только при смене комнаты. Теперь пересобираем состав и рисуем заново.
   *
   * В режиме редактирования перерисовку откладываем: она снесла бы DOM-маркер, который тянут.
   */
  handleCompositionChanged() {
    if (!this.initialized || !this.areaId) return;

    this.invalidateRoomEntityCache();

    if (this.editMode) {
      this._compositionDirty = true;
      return;
    }

    this.renderDeviceMarkers();
    this.renderControls();
    this.updatePlanDeviceStates();
  }

  // Отпечаток состава недоступных устройств комнаты — чтобы не перерисовывать зря.
  getOfflineSignature() {
    return this.getRoomComposition()
      .filter((state) => this.isDeviceOffline(state))
      .map((state) => state.entity_id)
      .sort()
      .join(",");
  }

  /**
   * Фильтр «своё событие». Подписка на state_changed глобальная, поэтому этот метод
   * зовётся на КАЖДОЕ событие HA. Состав комнаты кешируем: без кеша тут был бы полный
   * резолв area по всем сущностям на каждое событие (на объекте это тысячи сущностей).
   * Кеш пересобирается при смене комнаты и полной перерисовке (см. invalidateRoomEntityCache).
   */
  isRoomEntityId(entityId) {
    if (!this._roomEntityIds) {
      this._roomEntityIds = new Set(this.getRoomEntities().map((state) => state.entity_id));
      // Устройства, объявленные планом (data-entity), тоже «свои»: без этого их события
      // отсеялись бы, и лампа на плане не меняла бы состояние. В составе комнаты (area HA)
      // их может не быть — план знает о них раньше, чем HA.
      (this.planDevices || []).forEach(({ entityId: id }) => this._roomEntityIds.add(id));
    }
    return this._roomEntityIds.has(entityId);
  }

  invalidateRoomEntityCache() {
    this._roomEntityIds = null;
  }

  // Коалесценция: пачку событий за кадр сливаем в одно обновление значений.
  scheduleStateUpdate() {
    if (this._updateScheduled) return;
    this._updateScheduled = true;
    window.requestAnimationFrame(() => {
      this._updateScheduled = false;
      this.updateDeviceMarkerStates();
      this.updatePlanDeviceStates();   // устройства, объявленные планом (data-entity)
      this.updateControlValues();
    });
  }

  /**
   * D2: устройства, объявленные САМИМ планом (data-entity) — планы из CAD.
   * Отличать от маркеров расстановки (.device-marker), которые рисуются по нашему стору
   * координат: это два независимых пути, и они могут сосуществовать на одном плане.
   */
  collectPlanDevices() {
    this.planDevices = [];
    if (!this.svg) return;

    this.svg.querySelectorAll("[data-entity]").forEach((el) => {
      // Маркеры расстановки тоже несут data-entity — их обновляет updateDeviceMarkerStates.
      if (el.classList.contains("device-marker")) return;
      this.planDevices.push({ entityId: el.getAttribute("data-entity"), element: el });
    });

    if (this.planDevices.length) {
      ARVID_LOG.info(this.logArea, "Устройства прочитаны из плана комнаты", {
        areaId: this.areaId,
        count: this.planDevices.length,
      });
    }

    this.bindPlanDeviceEvents();
  }

  /**
   * Делаем устройства ПЛАНА кликабельными (v0.11.1): тап по лампе на плане комнаты = toggle
   * этой лампы, долгое удержание = попап яркости. Раньше клики вешались только на маркеры
   * расстановки (.device-marker); на плане из CAD (.device-node) лампа не реагировала вовсе,
   * а тап по ней начинал панораму. Поведение теперь как у маркеров — единый bindDevicePress.
   *
   * ⚠ Тонкий контур светильника (fill:transparent) кликается целиком по площади полигона —
   * и когда лампа горит, и когда потухла (заливка прозрачная, но остаётся hit-областью).
   * Это правило CSS (.device-node { fill: transparent }); отдельная мишень-прямоугольник не
   * нужна и невозможна: data-entity висит на самом <path>, а <path> не рендерит детей.
   */
  bindPlanDeviceEvents() {
    if (!this.planDevices?.length) return;

    this.planDevices.forEach(({ entityId, element }) => {
      if (element.dataset.pressBound === "1") return;   // не вешаем повторно

      const state = ARVID_APP.registry.getState(entityId);
      // Устройства нет в HA (план богаче объекта) — не выдаём его за рабочее, кликов не даём.
      if (!state) return;

      element.classList.add("is-interactive");
      element.setAttribute("tabindex", "0");
      // blockPan:false — панораму не глушим: жест «тащу план, палец на лампе» должен работать.
      this.bindDevicePress(element, state, { blockPan: false });
      element.dataset.pressBound = "1";
    });
  }

  // Состояние устройств плана: только классы (инвариант — DOM не перестраиваем).
  updatePlanDeviceStates() {
    if (!this.planDevices?.length) return;

    this.planDevices.forEach(({ entityId, element }) => {
      const state = ARVID_APP.registry.getState(entityId);

      // План богаче объекта: устройство нарисовано, но в HA его нет — гасим.
      element.classList.toggle("is-unknown", !state);
      if (!state) return;

      element.classList.toggle("is-on", ArvidDeviceUi.isOn(state));
      element.classList.toggle("is-active", ArvidDeviceUi.isActive(state));

      const health = this.getHealthFor(state);   // по device_id: пара ms_/il_ = одно устройство
      const offline = health.offline > 0;
      element.classList.toggle("is-offline", offline);
      element.classList.toggle("is-anomaly", !offline && health.anomaly > 0);
    });
  }

  // Маркеры на плане: только классы (активность + здоровье), без пересоздания SVG-элементов.
  updateDeviceMarkerStates() {
    if (!this.svg) return;
    this.svg.querySelectorAll(".device-marker[data-entity]").forEach((group) => {
      const state = ARVID_APP.registry.getState(group.getAttribute("data-entity"));
      if (!state) return;

      const active = ArvidDeviceUi.isActive(state);
      group.classList.toggle("is-on", active);
      group.classList.toggle("is-active", active);

      const health = this.getHealthFor(state);
      const isOffline = health.offline > 0;
      group.classList.toggle("is-offline", isOffline);
      group.classList.toggle("is-anomaly", !isOffline && health.anomaly > 0);
    });
  }

  /**
   * Обновление значений в карточках без перестроения DOM.
   * Слайдер яркости не трогаем, пока пользователь его двигает или он в фокусе.
   */
  updateControlValues() {
    const container = document.querySelector("[data-room-controls]");
    if (!container) return;

    // Свет: счётчик включённых.
    const lights = this.getRoomMemberLights();
    const countEl = container.querySelector("[data-light-count]");
    if (countEl) {
      const onCount = lights.filter((state) => state.state === "on").length;
      countEl.textContent = `${onCount}/${lights.length} включено`;
    }

    // Свет: слайдер яркости (только если пользователь его не удерживает).
    const slider = container.querySelector("[data-light-brightness]");
    const sliderLabel = container.querySelector("[data-light-brightness-label]");
    if (slider && !this._brightnessInteracting && document.activeElement !== slider && lights.length) {
      const pct = this.getAverageBrightnessPct(lights);
      slider.value = pct;
      if (sliderLabel) sliderLabel.textContent = `${pct}%`;
    }

    // Датчики: пересчитываем показания по якорю пары ms_/il_ (+ статус связи).
    container.querySelectorAll("[data-sensor-anchor]").forEach((row) => {
      const anchor = ARVID_APP.registry.getState(row.getAttribute("data-sensor-anchor"));
      const valueEl = row.querySelector("strong");
      if (!anchor || !valueEl) return;
      valueEl.textContent = this.formatSensorReadings(anchor);
      row.classList.toggle("is-offline", this.isDeviceOffline(anchor));
    });

    // Панели: последнее событие (+ статус связи).
    container.querySelectorAll("[data-panel-entity]").forEach((row) => {
      const state = ARVID_APP.registry.getState(row.getAttribute("data-panel-entity"));
      const valueEl = row.querySelector("strong");
      if (!state || !valueEl) return;

      const offline = this.isDeviceOffline(state);
      valueEl.textContent = offline ? "не на связи" : ArvidDeviceUi.panelEventText(state);
      row.classList.toggle("is-offline", offline);
    });

    // Свет: если ни одна лампа комнаты не на связи — управлять нечем, блокируем контролы (D6).
    const allLightsOffline = lights.length > 0 && lights.every((state) => this.isDeviceOffline(state));
    container.querySelectorAll(".light-control-card button, .light-control-card input, .light-control-card select")
      .forEach((control) => { control.disabled = allLightsOffline; });
    container.querySelector(".light-control-card")?.classList.toggle("is-offline", allLightsOffline);
  }

  /**
   * Лампы-члены комнаты по составу HA — только ФИЗИЧЕСКИЕ светильники.
   * Любые группы света исключаются (v0.9.0): и light.<area_id>, и DALI-группы ядра
   * («DALI Group» в модели устройства), у которых имя произвольное («r2») и по entity_id
   * их от лампы не отличить. Иначе счётчик «N/N включено» считал бы лампы дважды.
   */
  getRoomMemberLights() {
    return this.getRoomComposition().filter((state) => (
      state.entity_id.startsWith("light.") && !ARVID_APP.isLightGroupState(state)
    ));
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

    document.querySelector("[data-room-edit-toggle]")?.addEventListener("click", () => {
      this.toggleEditMode().catch((error) => {
        ARVID_LOG.error(this.logArea, "Failed to toggle room edit mode", error);
      });
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

    // Быстрый переход между комнатами = две параллельные загрузки в один контейнер.
    // Результат устаревшей выбрасываем, иначе в DOM останется план не той комнаты (v0.11.0).
    const token = Symbol("room-load");
    this._roomLoadToken = token;

    const svg = await ArvidSvgUtils.loadSvgInto(container, this.getRoomSvg(), {
      fallbackUrl: ARVID_CONFIG.DEFAULT_ROOM_SVG,
    });

    if (this._roomLoadToken !== token) {
      ARVID_LOG.debug(this.logArea, "План комнаты устарел, пока грузился — результат отброшен", {
        areaId: this.areaId,
      });
      return;
    }

    this.svg = svg;

    // Управление планом комнаты: колесо, drag плана, pinch и кнопки +/-.
    this.panZoom = ArvidSvgUtils.setupPanZoom(container, this.svg, {
      logArea: this.logArea,
    });

    // D2: устройства, объявленные самим планом (data-entity) — планы из CAD.
    // В комнате они видны всегда: порог зума нужен только этажу, где их сотни.
    this.collectPlanDevices();
    this.invalidateRoomEntityCache();   // фильтр «свои события» должен узнать о них
    this.updatePlanDeviceStates();

    // Щелчок/тап по плану в режиме редактирования размещает выбранное устройство.
    // Запоминаем точку нажатия, чтобы отличить клик от панорамирования (см. handleEditPlanClick).
    this.svg.addEventListener("pointerdown", (event) => {
      this._editClickStart = { x: event.clientX, y: event.clientY };
    });
    this.svg.addEventListener("click", (event) => this.handleEditPlanClick(event));

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

  // СОСТАВ комнаты — истина HA (карточки, счётчики). См. ARVID_APP.entitiesForArea.
  getRoomComposition() {
    return ARVID_APP.entitiesForArea(this.areaId);
  }

  // РАЗМЕЩЁННЫЕ на плане (маркеры). Могут быть не привязаны к комнате в HA.
  getPlacedEntities() {
    return ARVID_APP.placedEntitiesForRoom(this.areaId);
  }

  /**
   * Здоровье устройства (D6, v0.9.0) — снимок ядра DALI, своей логики offline не ведём.
   *
   * ⚠ Ключ — device_id, а НЕ entity_id: пара движение+люкс это ОДНО устройство HA и ОДИН
   * маркер на плане, но ДВЕ записи здоровья (0201/0202) с разными entity_id. Координата
   * маркера лежит под ms_, поэтому ошибка люкса (sensor.il_*) по entity_id до него не доедет.
   * Фолбэк по entity_id — на случай, если устройства нет в реестре.
   *
   * Возвращает {offline, anomaly, total, records}.
   */
  getHealthFor(state) {
    const health = ARVID_APP.health;
    if (!health || health.available === false) return { offline: 0, anomaly: 0, total: 0, records: [] };

    const deviceId = ARVID_APP.registry.getDeviceId(state.entity_id);
    if (deviceId) return health.statsForDevice(deviceId);
    return health.statsForEntity(state.entity_id);
  }

  isDeviceOffline(state) {
    return this.getHealthFor(state).offline > 0;
  }

  // Объединение — только для фильтра «свои события» (не состав).
  getRoomEntities() {
    return ARVID_APP.entitiesForRoom(this.areaId);
  }

  /**
   * Скоуп интерфейса: свет / датчик / панель — но ГРУППЫ света исключаем (v0.9.0).
   * Группа — не физическое устройство: её нельзя расставить на плане, у неё нет
   * координаты и здоровья, а в счётчике она удваивала бы свои же лампы.
   */
  isScopedState(state) {
    return ArvidDeviceUi.isScoped(state) && !ARVID_APP.isLightGroupState(state);
  }

  /**
   * Схлопываем сущности в «точки-устройства»: пара датчика ms_/il_ (общий device_id)
   * превращается в одну точку. Якорь пары — сущность движения (ms_), к ней прикреплена
   * освещённость. Свет и панели остаются как есть.
   */
  collapseToUnits(states) {
    const units = [];
    const seenSensorDevices = new Set();

    states.forEach((state) => {
      if (ArvidDeviceUi.markerKind(state) !== "sensor") {
        units.push(state);
        return;
      }

      const deviceId = ARVID_APP.registry.getDeviceId(state.entity_id);
      const groupKey = deviceId || state.entity_id;
      if (seenSensorDevices.has(groupKey)) return;
      seenSensorDevices.add(groupKey);

      // Якорь — движение (ms_), если оно есть у этого устройства; иначе текущая сущность.
      const siblings = deviceId ? ARVID_APP.registry.getEntitiesForDevice(deviceId) : [state];
      const anchor = siblings.find((s) => ArvidDeviceUi.isMotion(s)) || state;
      units.push(anchor);
    });

    return units;
  }

  // Показания единого датчика: движение (ms_) + освещённость (il_) одного устройства.
  getSensorReadings(anchorState) {
    const deviceId = ARVID_APP.registry.getDeviceId(anchorState.entity_id);
    const siblings = deviceId ? ARVID_APP.registry.getEntitiesForDevice(deviceId) : [anchorState];
    return {
      motion: siblings.find((s) => ArvidDeviceUi.isMotion(s)) || null,
      lux: siblings.find((s) => ArvidDeviceUi.isIlluminance(s)) || null,
    };
  }

  /**
   * Все устройства скоупа во всём HA (не только этой комнаты), схлопнутые в точки.
   * Нужны в режиме редактирования: на частных объектах area не заданы, поэтому
   * для расстановки показываем полный список с поиском, а не только устройства area.
   */
  getAllScopedEntities() {
    return this.collapseToUnits(ARVID_APP.registry.states.filter((state) => this.isScopedState(state)));
  }

  getDeviceLayout(entityId) {
    return ARVID_APP.layout?.devices?.[entityId] || null;
  }

  renderDeviceMarkers() {
    if (!this.svg) return;

    const layer = ArvidSvgUtils.ensureOverlayLayer(this.svg, "arvid-device-markers");
    ArvidSvgUtils.clearLayer(layer);

    // И на плане, и в редакторе показываем только устройства скоупа.
    // Иначе старые записи layout (климат/шторы из общего стора) висят «пустыми»
    // неубираемыми маркерами: их нет в списке редактора, значит их нельзя снять.
    const entities = this.getScopedEntities();
    let rendered = 0;

    entities.forEach((state) => {
      const layout = this.getDeviceLayout(state.entity_id);
      if (!layout || layout.x === undefined || layout.y === undefined) return;

      // Убранные с плана устройства в обычном режиме не показываем,
      // в режиме редактирования — показываем полупрозрачными, чтобы их можно было вернуть.
      const isHiddenOnPlan = layout.visible === false;
      if (isHiddenOnPlan && !this.editMode) return;

      const marker = layout.marker || "icon";
      const kind = layout.icon === "auto" || !layout.icon ? ArvidDeviceUi.markerKind(state) : layout.icon;
      const isSelected = this.editMode && state.entity_id === this.editSelectedEntityId;
      // Устройство стоит на плане комнаты, но в HA к ней не привязано — помечаем.
      const isUnassigned = ARVID_APP.isUnassignedInRoom(state.entity_id, this.areaId);
      // Здоровье устройства (D6): не на связи — приглушаем и метим красным.
      const health = this.getHealthFor(state);
      const isOffline = health.offline > 0;
      const hasAnomaly = !isOffline && health.anomaly > 0;
      const group = ArvidSvgUtils.createSvgElement("g", {
        class: `device-marker marker-${marker} device-kind-${kind} ${ArvidDeviceUi.isActive(state) ? "is-on is-active" : ""} ${isSelected ? "is-selected" : ""} ${isHiddenOnPlan ? "is-hidden-on-plan" : ""} ${isUnassigned ? "is-unassigned" : ""} ${isOffline ? "is-offline" : ""} ${hasAnomaly ? "is-anomaly" : ""}`,
        transform: `translate(${layout.x}, ${layout.y})`,
        tabindex: "0",
        // Якорь для точечного обновления состояния без пересоздания маркера.
        "data-entity": state.entity_id,
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

      // Рамка выделения выбранного устройства (только в режиме редактирования).
      if (this.editMode) {
        group.appendChild(ArvidSvgUtils.createSvgElement("rect", {
          x: -24,
          y: -24,
          width: 48,
          height: 48,
          rx: 12,
          class: "device-marker-selection",
        }));
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
      sensor: "D",
      panel: "P",
    };
    return labels[kind] || ArvidDeviceUi.domain(state.entity_id).slice(0, 2).toUpperCase();
  }

  bindDeviceMarkerEvents(group, state) {
    // В режиме редактирования маркер не управляет устройством: drag переносит, клик выбирает.
    if (this.editMode) {
      group.addEventListener("pointerdown", (event) => this.startDeviceDrag(event, state, group));
      return;
    }

    // Маркер расстановки блокирует панораму (blockPan): он мелкий и точечный.
    this.bindDevicePress(group, state, { blockPan: true });
  }

  /**
   * Единый жест «нажатие на устройство»: короткий тап = основное действие (свет — toggle),
   * долгое удержание = попап точечного управления. Используется и маркерами расстановки,
   * и устройствами плана из CAD (v0.11.1, D2).
   *
   * blockPan:
   *   true  — маркеры расстановки: гасим панораму (stopPropagation), они точечные;
   *   false — устройства ПЛАНА: панораму НЕ трогаем. На объекте лампы всюду, и жест
   *           «тащу план, палец попал на лампу» должен панорамировать, а не залипать.
   *           Тап от панорамы отличаем по сдвигу пальца (порог 8px), как везде в проекте.
   */
  bindDevicePress(element, state, { blockPan = false } = {}) {
    element.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      if (blockPan) event.stopPropagation();

      const press = { handled: false, moved: false, startX: event.clientX, startY: event.clientY };
      press.timer = window.setTimeout(() => {
        if (press.moved) return;
        press.handled = true;
        this.openDevicePopup(state, element);
        ARVID_LOG.info(this.logArea, "Долгое нажатие: попап устройства", { entityId: state.entity_id });
      }, 650);

      const onMove = (moveEvent) => {
        if (Math.abs(moveEvent.clientX - press.startX) > 8 || Math.abs(moveEvent.clientY - press.startY) > 8) {
          press.moved = true;             // это панорама, не тап
          window.clearTimeout(press.timer);
        }
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        window.clearTimeout(press.timer);
        // Тап срабатывает только если палец не уехал (иначе была панорама) и попап не открыт удержанием.
        if (!press.moved && !press.handled) this.handleMarkerClick(state, element);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });

    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.handleMarkerClick(state, element);
      }
    });
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
    // Панель — последнее событие.
    if (ArvidDeviceUi.isPanelEvent(state)) {
      body.innerHTML = `
        <div class="device-popup-metric">
          <span>Последнее событие</span>
          <strong>${ArvidDeviceUi.panelEventText(state)}</strong>
        </div>
        <small>${state.entity_id}</small>
      `;
      return;
    }

    // Датчик — оба показания одного устройства: движение и освещённость.
    const { motion, lux } = this.getSensorReadings(state);
    const rows = [];
    if (motion) {
      rows.push(`<div class="device-popup-metric"><span>Движение</span><strong>${ArvidDeviceUi.isMotionActive(motion) ? "Есть движение" : "Нет движения"}</strong></div>`);
    }
    if (lux) {
      rows.push(`<div class="device-popup-metric"><span>Освещённость</span><strong>${lux.state} ${lux.attributes?.unit_of_measurement || "lx"}</strong></div>`);
    }
    if (!rows.length) {
      rows.push(`<div class="device-popup-metric"><span>Датчик</span><strong>${state.state}</strong></div>`);
    }
    body.innerHTML = rows.join("");
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

    if (this.editMode) {
      this.renderEditPanel(container);
      return;
    }

    // Состав комнаты — истина HA (area), а не то, что расставлено на плане.
    const entities = this.getRoomComposition();
    // Лампы — только физические светильники: любые группы света исключены (v0.9.0),
    // иначе одна лампа считалась бы дважды — сама и через группу.
    const lights = this.getRoomMemberLights();
    // Датчики схлопываем в точки: пара ms_/il_ = одна строка с двумя показаниями.
    const sensors = this.collapseToUnits(entities.filter((state) => ArvidDeviceUi.isSensor(state)));
    const panels = entities.filter((state) => ArvidDeviceUi.isPanelEvent(state));

    container.innerHTML = "";
    const offlineNote = this.buildOfflineNote();
    if (offlineNote) container.appendChild(offlineNote);
    const unassignedNote = this.buildUnassignedNote();
    if (unassignedNote) container.appendChild(unassignedNote);
    if (lights.length) container.appendChild(this.renderLightCard(lights));
    if (sensors.length) container.appendChild(this.renderSensorCard(sensors));
    if (panels.length) container.appendChild(this.renderPanelCard(panels));

    if (!container.children.length) {
      container.innerHTML = "<div class='muted-box'>В этой комнате пока нет поддерживаемых устройств</div>";
    }
  }

  /**
   * Плашка «не на связи» (D6, v0.9.0): устройства комнаты, которые ядро DALI считает
   * недоступными. Имена берём из состава комнаты, а не из записи здоровья: в записи имя
   * устройства ядра, а пользователь видит friendly_name из HA.
   */
  buildOfflineNote() {
    const offline = this.getRoomComposition()
      .filter((state) => this.isScopedState(state))
      .filter((state) => this.isDeviceOffline(state));

    if (!offline.length) return null;

    // Пара ms_/il_ — одно устройство: в перечислении не двоим.
    const names = [...new Set(this.collapseToUnits(offline).map((state) => ArvidDeviceUi.friendlyName(state)))];

    const box = document.createElement("div");
    box.className = "muted-box offline-note";

    const title = document.createElement("strong");
    title.textContent = `${names.length} устр. не на связи`;
    box.appendChild(title);

    const detail = document.createElement("small");
    detail.textContent = names.join(", ");
    box.appendChild(detail);

    return box;
  }

  /**
   * Плашка: устройства стоят на плане комнаты, но в HA не привязаны к ней.
   * Они видны на плане приглушёнными, но в состав (карточки/счётчики) не входят.
   */
  buildUnassignedNote() {
    const unassigned = this.getPlacedEntities()
      .filter((state) => this.isScopedState(state))
      .filter((state) => ARVID_APP.isUnassignedInRoom(state.entity_id, this.areaId));

    if (!unassigned.length) return null;

    const box = document.createElement("div");
    box.className = "muted-box unassigned-note";
    box.innerHTML = `
      <strong>${unassigned.length} устр. на плане не привязано к помещению в HA</strong>
      <small>Задайте им пространство «${this.getArea()?.name || this.areaId}» в Home Assistant,
      иначе они не попадут в состав комнаты и в группу света.</small>
    `;
    return box;
  }

  /**
   * Группы света помещения — цели для селекта «Группа света» (v0.9.0).
   * Раньше группы УГАДЫВАЛИСЬ по словам в имени («группа», «all», «освещение») среди ламп —
   * это ловило лампу с именем «Освещение стола» и пропускало DALI-группу с именем «r2».
   * Теперь признак честный (ARVID_APP.isLightGroupState: модель «DALI Group» либо список
   * членов в атрибутах), а группы вообще не попадают в состав ламп.
   */
  getRoomLightGroups() {
    return this.getRoomComposition().filter((state) => (
      state.entity_id.startsWith("light.") && ARVID_APP.isLightGroupState(state)
    ));
  }

  getLightTargetSessionKey() {
    return `arvid.room.${this.areaId}.lightTarget`;
  }

  // Формула HA-группы света комнаты: light.<area_id> (см. ARVID_APP.lightGroupState).
  getRoomLightGroupId() {
    return `light.${this.areaId}`;
  }

  getLightTargetIds(card, lights) {
    const select = card.querySelector("[data-light-target]");
    const value = select?.value || sessionStorage.getItem(this.getLightTargetSessionKey()) || "all";

    if (value !== "all") return [value];

    // «Вся комната» — детерминированно через HA-группу light.<area_id>, если она есть.
    const group = ARVID_APP.lightGroupState(this.areaId);
    if (group) return [group.entity_id];

    // Фолбэк (группы ещё нет): отправляем все лампы-члены помещения.
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

    const groups = this.getRoomLightGroups();
    const onCount = lights.filter((state) => state.state === "on").length;
    const brightness = this.getAverageBrightnessPct(lights);
    const showGroupSelect = groups.length > 0;

    card.innerHTML = `
      <header>
        <h3>Освещение</h3>
        <span data-light-count>${onCount}/${lights.length} включено</span>
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

    // Пока пользователь держит слайдер — обновления по state_changed его не трогают.
    brightnessInput.addEventListener("pointerdown", () => { this._brightnessInteracting = true; });
    ["pointerup", "pointercancel", "blur"].forEach((eventName) => {
      brightnessInput.addEventListener(eventName, () => { this._brightnessInteracting = false; });
    });

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

  // Строка датчика: имя + оба показания (движение · освещённость) одного устройства.
  renderSensorStatusLine(anchorState) {
    const row = document.createElement("div");
    row.className = "sensor-status-line";
    // Не на связи (D6) — строку приглушаем (класс обновляется и в updateControlValues).
    row.classList.toggle("is-offline", this.isDeviceOffline(anchorState));
    // Якорь для точечного обновления показаний (см. updateControlValues).
    row.dataset.sensorAnchor = anchorState.entity_id;

    row.innerHTML = `
      <span>${ArvidDeviceUi.friendlyName(anchorState)}</span>
      <strong>${this.formatSensorReadings(anchorState)}</strong>
    `;
    return row;
  }

  formatSensorReadings(anchorState) {
    // Устройство не на связи — показания устарели, честнее сказать это прямо (D6).
    if (this.isDeviceOffline(anchorState)) return "не на связи";

    const { motion, lux } = this.getSensorReadings(anchorState);
    const parts = [];
    if (motion) parts.push(ArvidDeviceUi.isMotionActive(motion) ? "движение" : "нет движения");
    if (lux) parts.push(`${lux.state} ${lux.attributes?.unit_of_measurement || "lx"}`);
    return parts.join(" · ") || "—";
  }

  getSensorDisplayLabel(state, kind) {
    if (ArvidDeviceUi.isPanelEvent(state)) return "Панель";
    if (kind === "sensor") return "Датчик";
    return ArvidDeviceUi.friendlyName(state);
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
      const offline = this.isDeviceOffline(state);   // не на связи (D6)
      const row = document.createElement("div");
      row.className = "sensor-status-line";
      row.classList.toggle("is-offline", offline);
      // Якорь для точечного обновления последнего события панели.
      row.dataset.panelEntity = state.entity_id;
      row.innerHTML = `
        <span>${ArvidDeviceUi.friendlyName(state)}</span>
        <strong>${offline ? "не на связи" : ArvidDeviceUi.panelEventText(state)}</strong>
      `;
      list.appendChild(row);
    });

    return card;
  }

  /* ===== Режим редактирования расстановки устройств (v0.2.0) =====
   * Не отдельная страница: включается кнопкой в шапке комнаты.
   * Упрощённый редактор: список устройств с фильтрами, перенос маркеров
   * (drag на компьютере, тап по плану на телефоне), «убрать с плана», сохранение.
   */

  async toggleEditMode() {
    if (this.editMode) await this.resolveEditDirty();
    this.setEditMode(!this.editMode);
  }

  // Перед выходом из режима спрашиваем, что делать с несохранёнными изменениями.
  async resolveEditDirty() {
    if (!this.editDirty) return;

    const shouldSave = window.confirm("Сохранить изменения расстановки устройств?");
    if (shouldSave) {
      await this.saveEditChanges();
    } else {
      await this.discardEditChanges();
    }
  }

  setEditMode(enabled, options = {}) {
    this.editMode = enabled;
    this.editSelectedEntityId = null;
    this.editSearch = "";
    this.editStatusText = "";
    this.closeDevicePopup();

    const shell = document.querySelector('[data-spa-view="room"] .arvid-shell');
    shell?.classList.toggle("is-room-editing", enabled);

    const toggle = document.querySelector("[data-room-edit-toggle]");
    if (toggle) {
      toggle.textContent = enabled ? "Готово" : "Редактор";
      toggle.classList.toggle("is-active", enabled);
    }

    ARVID_LOG.info(this.logArea, "Room edit mode toggled", { enabled, areaId: this.areaId });

    // Пока редактировали, состав мог измениться в HA — догоняем на выходе (см. D5).
    if (!enabled && this._compositionDirty) {
      this._compositionDirty = false;
      this.invalidateRoomEntityCache();
    }

    if (options.skipRender) return;
    this.renderDeviceMarkers();
    this.renderControls();
  }

  getScopedEntities() {
    // Маркеры на плане рисуем по РАЗМЕЩЁННЫМ (у них есть координаты),
    // схлопывая пару датчика ms_/il_ в одну точку.
    return this.collapseToUnits(this.getPlacedEntities().filter((state) => this.isScopedState(state)));
  }

  matchesEditFilter(kind) {
    if (this.editFilter === "all") return true;
    if (this.editFilter === "sensors") return kind === "sensor";
    return kind === this.editFilter;
  }

  ensureDeviceLayout(entityId) {
    ARVID_APP.layout.devices = ARVID_APP.layout.devices || {};
    const current = ARVID_APP.layout.devices[entityId] || {};

    ARVID_APP.layout.devices[entityId] = {
      area_id: current.area_id || this.areaId,
      visible: current.visible ?? true,
      marker: current.marker || "icon",
      icon: current.icon || "auto",
      ...current,
    };

    return ARVID_APP.layout.devices[entityId];
  }

  isDevicePlaced(entityId) {
    const layout = this.getDeviceLayout(entityId);
    return Boolean(layout && layout.visible !== false && layout.x !== undefined && layout.y !== undefined);
  }

  renderEditPanel(container) {
    const filters = [
      { key: "all", title: "Все" },
      { key: "light", title: "Свет" },
      { key: "sensors", title: "Датчики" },
      { key: "panel", title: "Панели" },
    ];

    // Показываем ВСЕ устройства скоупа во всём HA (не только area комнаты):
    // на частных объектах area не заданы, а расставить нужно любое устройство.
    // Фильтр по помещению (area) — идея на будущее (когда area будут заданы),
    // сейчас он мешает. Вместо него — чипы по типу + поиск по названию.
    const entities = this.getAllScopedEntities();
    const visibleEntities = entities.filter((state) => this.matchesEditFilter(ArvidDeviceUi.markerKind(state)));
    const selected = this.editSelectedEntityId;
    const selectedPlaced = selected ? this.isDevicePlaced(selected) : false;

    container.innerHTML = "";

    const card = document.createElement("section");
    card.className = "control-card room-edit-card";
    card.innerHTML = `
      <header>
        <h3>Расстановка устройств</h3>
        <span>${visibleEntities.length}/${entities.length}</span>
      </header>
      <div class="edit-filter-chips"></div>
      <input class="edit-search" data-edit-search type="search" placeholder="Поиск по названию…" autocomplete="off">
      <div class="edit-device-list"></div>
      <div class="muted-box" data-edit-hint></div>
      <div class="segmented-actions edit-actions">
        <button data-edit-center ${selected ? "" : "disabled"}>В центр плана</button>
        <button data-edit-remove ${selected && selectedPlaced ? "" : "disabled"}>Убрать с плана</button>
      </div>
      <button class="panel-action primary-button" data-edit-save ${this.editDirty ? "" : "disabled"}>Сохранить разметку</button>
      <div class="edit-status" data-edit-status></div>
    `;

    const chips = card.querySelector(".edit-filter-chips");
    filters.forEach((filter) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = filter.title;
      chip.classList.toggle("is-active", this.editFilter === filter.key);
      chip.addEventListener("click", () => {
        this.editFilter = filter.key;
        this.renderControls();
      });
      chips.appendChild(chip);
    });

    const list = card.querySelector(".edit-device-list");
    if (!visibleEntities.length) {
      list.innerHTML = "<div class='muted-box'>По выбранному фильтру устройств нет</div>";
    }
    visibleEntities.forEach((state) => list.appendChild(this.buildEditDeviceRow(state)));

    const hint = card.querySelector("[data-edit-hint]");
    hint.textContent = selected
      ? "Телефон: тапни по месту на плане. Компьютер: перетащи маркер мышью."
      : "Выбери устройство в списке, чтобы разместить или перенести его.";

    // Поиск фильтрует уже отрисованные строки локально (без перерисовки),
    // иначе поле теряло бы фокус на каждом символе.
    const search = card.querySelector("[data-edit-search]");
    if (search) {
      search.value = this.editSearch || "";
      search.addEventListener("input", () => {
        this.editSearch = search.value;
        this.applyEditSearchFilter(list);
      });
    }

    card.querySelector("[data-edit-center]")?.addEventListener("click", () => this.placeSelectedDeviceToCenter());
    card.querySelector("[data-edit-remove]")?.addEventListener("click", () => this.removeSelectedDeviceFromPlan());
    card.querySelector("[data-edit-save]")?.addEventListener("click", () => {
      this.saveEditChanges().catch((error) => {
        ARVID_LOG.error(this.logArea, "Failed to save room layout from edit panel", error);
      });
    });

    container.appendChild(card);
    this.applyEditSearchFilter(list);
    this.syncEditStatus();
  }

  applyEditSearchFilter(list) {
    const query = (this.editSearch || "").trim().toLowerCase();
    list.querySelectorAll(".edit-device-row").forEach((row) => {
      const haystack = row.dataset.search || "";
      row.style.display = !query || haystack.includes(query) ? "" : "none";
    });
  }

  buildEditDeviceRow(state) {
    const kind = ArvidDeviceUi.markerKind(state);
    const placed = this.isDevicePlaced(state.entity_id);
    const row = document.createElement("button");
    row.type = "button";
    row.className = `edit-device-row ${placed ? "is-placed" : ""} ${state.entity_id === this.editSelectedEntityId ? "is-selected" : ""}`;

    const iconUrl = ArvidDeviceUi.iconAssetUrl(kind);
    const iconHtml = iconUrl
      ? `<img src="${iconUrl}" alt="">`
      : `<span class="edit-device-fallback">${ArvidDeviceUi.iconText(kind)}</span>`;

    const name = ArvidDeviceUi.friendlyName(state);
    // Строка поиска: имя + entity_id, чтобы искать и по названию, и по id.
    row.dataset.search = `${name} ${state.entity_id}`.toLowerCase();

    row.innerHTML = `
      ${iconHtml}
      <span class="edit-device-name">
        <strong>${name}</strong>
        <small>${state.entity_id}</small>
      </span>
      <em>${placed ? "на плане" : "не размещено"}</em>
    `;

    row.addEventListener("click", () => this.selectEditDevice(state.entity_id));
    return row;
  }

  selectEditDevice(entityId) {
    // Повторный клик по выбранной строке снимает выбор.
    this.editSelectedEntityId = entityId === this.editSelectedEntityId ? null : entityId;
    ARVID_LOG.info(this.logArea, "Edit device selected", { entityId: this.editSelectedEntityId });
    this.renderDeviceMarkers();
    this.renderControls();
  }

  /**
   * Пометить правку. `entityId` копится в _editTouched: при сохранении отправим ТОЛЬКО эти
   * устройства, а не весь документ (A4).
   */
  markEditDirty(reason, entityId = null) {
    this.editDirty = true;
    if (entityId) {
      this._editTouched = this._editTouched || new Set();
      this._editTouched.add(entityId);
    }

    this.setEditStatus("Есть несохранённые изменения");
    const saveButton = document.querySelector("[data-edit-save]");
    if (saveButton) saveButton.disabled = false;
    ARVID_LOG.debug(this.logArea, "Room layout marked dirty", { reason, entityId });
  }

  setEditStatus(text) {
    this.editStatusText = text;
    this.syncEditStatus();
  }

  syncEditStatus() {
    const status = document.querySelector("[data-edit-status]");
    if (status) status.textContent = this.editStatusText;
  }

  /**
   * Сохранение разметки — ТОЧЕЧНОЕ (v0.11.0, долг A4).
   *
   * Раньше уходил `saveLayout(ARVID_APP.layout)` — весь документ снимком из этой вкладки.
   * Расстановка, сделанная параллельно с другого устройства, затиралась молча. Теперь шлём
   * только те entity_id, которые правили в этой сессии редактирования.
   */
  async saveEditChanges() {
    const touched = [...(this._editTouched || [])];

    if (!touched.length) {
      this.editDirty = false;
      this.setEditStatus("Изменений нет");
      return;
    }

    this.setEditStatus("Сохраняю разметку...");

    const devices = {};
    touched.forEach((entityId) => {
      const device = ARVID_APP.layout?.devices?.[entityId];
      if (device) devices[entityId] = device;
    });

    try {
      const layout = await ARVID_APP.storage.updateDevices(devices);

      // Сервер вернул актуальный документ (в нём и чужие правки) — принимаем его целиком.
      ARVID_APP.layout = layout;
      this._editTouched = new Set();
      this.editDirty = false;
      this.invalidateRoomEntityCache(); // расстановка меняет набор «своих» сущностей
      this.setEditStatus("Разметка сохранена");
      ARVID_LOG.info(this.logArea, "Room layout saved from edit mode", {
        areaId: this.areaId,
        devices: touched.length,
      });
    } catch (error) {
      this.setEditStatus("Ошибка сохранения разметки");
      ARVID_LOG.error(this.logArea, "Failed to save room layout", error);
      throw error;
    }
    if (this.editMode) {
      this.renderDeviceMarkers();
      this.renderControls();
    }
  }

  async discardEditChanges() {
    // Отбрасываем несохранённые правки: перечитываем layout из HA storage.
    ARVID_APP.layout = await ARVID_APP.storage.getLayout();
    this._editTouched = new Set();
    this.editDirty = false;
    this.invalidateRoomEntityCache();   // состав «своих» вернулся к сохранённому
    this.setEditStatus("Изменения отменены");
    ARVID_LOG.info(this.logArea, "Room layout changes discarded", { areaId: this.areaId });
  }

  handleEditPlanClick(event) {
    if (!this.editMode || !this.svg) return;
    if (event.target.closest?.(".device-marker")) return;

    // Отличаем клик-размещение от панорамирования плана: при заметном сдвиге
    // указателя между down и up считаем это pan и ничего не ставим.
    const start = this._editClickStart;
    if (start && (Math.abs(event.clientX - start.x) > 8 || Math.abs(event.clientY - start.y) > 8)) {
      return;
    }

    if (!this.editSelectedEntityId) {
      this.setEditStatus("Сначала выбери устройство в списке, затем щёлкни по месту на плане");
      return;
    }

    // Работает и на компьютере (щелчок), и на телефоне (тап).
    const point = ArvidSvgUtils.clientPointToSvg(this.svg, event.clientX, event.clientY);
    if (!point) return;
    this.placeDeviceAt(this.editSelectedEntityId, point.x, point.y, "щелчок по плану");
  }

  placeDeviceAt(entityId, x, y, reason) {
    const layout = this.ensureDeviceLayout(entityId);
    layout.area_id = this.areaId;
    layout.x = Math.round(x * 10) / 10;
    layout.y = Math.round(y * 10) / 10;
    layout.visible = true;

    this.markEditDirty(reason, entityId);
    this.renderDeviceMarkers();
    this.renderControls();

    ARVID_LOG.info(this.logArea, "Device placed on room plan", {
      entityId,
      x: layout.x,
      y: layout.y,
      reason,
    });
  }

  placeSelectedDeviceToCenter() {
    if (!this.editSelectedEntityId || !this.svg) return;

    const metrics = ArvidSvgUtils.getViewBoxMetrics(this.svg);
    if (!metrics) return;

    this.placeDeviceAt(
      this.editSelectedEntityId,
      metrics.x + metrics.width / 2,
      metrics.y + metrics.height / 2,
      "кнопка «В центр плана»",
    );
  }

  removeSelectedDeviceFromPlan() {
    if (!this.editSelectedEntityId) return;

    const layout = this.ensureDeviceLayout(this.editSelectedEntityId);
    layout.visible = false;

    this.markEditDirty("устройство убрано с плана", this.editSelectedEntityId);
    this.renderDeviceMarkers();
    this.renderControls();
  }

  startDeviceDrag(event, state, group) {
    if (!this.svg) return;
    if (event.button !== undefined && event.button !== 0) return;

    // Если пользователь потянул маркер, план не должен начинать pan.
    event.preventDefault();
    event.stopPropagation();

    // Выбираем без перерисовки слоя: перерисовка удалила бы DOM-маркер, который тянем.
    this.editSelectedEntityId = state.entity_id;

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
  }

  handleDeviceDragMove(event) {
    if (!this.deviceDrag || !this.svg) return;
    if (event.pointerId !== this.deviceDrag.pointerId) return;

    event.preventDefault();
    event.stopPropagation();

    const point = ArvidSvgUtils.clientPointToSvg(this.svg, event.clientX, event.clientY);
    if (!point) return;

    const layout = this.ensureDeviceLayout(this.deviceDrag.entityId);
    layout.area_id = this.areaId;
    layout.x = Math.round(point.x * 10) / 10;
    layout.y = Math.round(point.y * 10) / 10;
    layout.visible = true;

    this.deviceDrag.group.setAttribute("transform", `translate(${layout.x}, ${layout.y})`);
    this.deviceDrag.moved = true;
  }

  finishDeviceDrag(event) {
    if (!this.deviceDrag) return;

    event?.preventDefault?.();
    event?.stopPropagation?.();

    const { entityId, group, moved } = this.deviceDrag;
    group.classList.remove("is-dragging");
    this.deviceDrag = null;

    if (moved) {
      this.markEditDirty("маркер перенесён перетаскиванием", entityId);
      ARVID_LOG.info(this.logArea, "Device drag finished", { entityId });
    }

    // Клик без переноса — просто выбор устройства: обновляем список и рамку выделения.
    this.renderDeviceMarkers();
    this.renderControls();
  }
}

window.ArvidRoomPage = ArvidRoomPage;
