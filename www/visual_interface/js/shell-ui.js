/**
 * Общая логика оболочки: тема, панели, часы и бренд.
 * Панели управляются классами на самой панели и на .arvid-shell,
 * чтобы центральный план автоматически занимал освободившееся место.
 */
class ArvidShellUi {
  static getActiveRoot() {
    return document.querySelector('.spa-view[data-spa-view]:not([hidden])') || document;
  }

  static query(selector) {
    return this.getActiveRoot().querySelector(selector);
  }

  static queryAll(selector) {
    return Array.from(this.getActiveRoot().querySelectorAll(selector));
  }

  /**
   * Плашка «нет связи» (v0.11.0, долг A3).
   *
   * Главная опасность обрыва — не в том, что интерфейс перестаёт работать, а в том, что он
   * продолжает УБЕДИТЕЛЬНО ВЫГЛЯДЕТЬ рабочим: зоны горят, датчики показывают последние значения.
   * Диспетчер верит картинке, которой уже несколько часов. Поэтому состояние связи должно быть
   * видно на экране, а не только в консоли.
   */
  static initConnectionStatus() {
    if (this._connectionStatusReady || !window.ARVID_APP?.ha) return;
    this._connectionStatusReady = true;

    ARVID_APP.ha.addStatusHandler((status) => this.renderConnectionStatus(status));
  }

  static renderConnectionStatus(status) {
    let banner = document.querySelector("[data-connection-banner]");

    if (!banner) {
      banner = document.createElement("div");
      banner.className = "connection-banner";
      banner.dataset.connectionBanner = "1";
      banner.setAttribute("role", "status");
      document.body.appendChild(banner);
    }

    const isOffline = status === "offline";
    banner.textContent = isOffline
      ? "Нет связи с Home Assistant — данные на экране устарели"
      : "";
    banner.classList.toggle("is-visible", isOffline);

    // Пока связи нет, экран не отражает реальность: гасим интерактив, чтобы тап
    // не выглядел «сработавшим», хотя команда никуда не ушла.
    document.documentElement.classList.toggle("is-ha-offline", isOffline);
  }

  static initViewportHeight() {
    if (!this._viewportHandler) {
      // Храним обработчик, чтобы не плодить одинаковые подписки при повторной инициализации страницы.
      this._viewportHandler = () => this.updateViewportHeight();
      window.addEventListener("resize", this._viewportHandler);
      window.visualViewport?.addEventListener("resize", this._viewportHandler);
      window.visualViewport?.addEventListener("scroll", this._viewportHandler);
    }

    this.updateViewportHeight();
  }

  static updateViewportHeight() {
    const nextHeight = Math.round(
      window.visualViewport?.height ||
      window.innerHeight ||
      document.documentElement.clientHeight ||
      0,
    );

    if (!nextHeight || nextHeight === this._lastViewportHeight) return;

    this._lastViewportHeight = nextHeight;
    document.documentElement.style.setProperty("--arvid-app-height", `${nextHeight}px`);
    ARVID_LOG.debug("shell", "Viewport height updated", { nextHeight });
  }


  static initTheme(layout) {
    // Тема из localStorage применяется ещё в <head>, чтобы не было мигания.
    // После загрузки layout синхронизируем localStorage с темой из HA, если локально тема ещё не выбрана.
    const storedTheme = localStorage.getItem("arvid.theme");
    const layoutTheme = layout?.ui?.theme;
    const theme = storedTheme || layoutTheme || "dark";

    document.documentElement.dataset.theme = theme;
    localStorage.setItem("arvid.theme", theme);

    // Если layout ещё не содержит тему, фиксируем текущее состояние в памяти приложения.
    if (layout) {
      layout.ui = layout.ui || {};
      layout.ui.theme = theme;
    }

    ARVID_LOG.info("shell", "Theme initialized", {
      theme,
      source: storedTheme ? "localStorage" : layoutTheme ? "ha-layout" : "default",
    });
  }

  static toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    this.setTheme(next, { persistToHa: true });
  }

  static setTheme(theme, options = {}) {
    // Меняем тему сразу, а сохранение в HA делаем фоном, чтобы UI не тормозил.
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("arvid.theme", theme);

    if (window.ARVID_APP?.layout) {
      ARVID_APP.layout.ui = ARVID_APP.layout.ui || {};
      ARVID_APP.layout.ui.theme = theme;
    }

    ARVID_LOG.info("shell", "Theme changed", {
      theme,
      persistToHa: Boolean(options.persistToHa),
    });

    /**
     * Сохраняем ТОЛЬКО тему (v0.11.0, долг A4).
     *
     * Раньше здесь звался `saveLayout(ARVID_APP.layout)` — то есть смена темы отправляла
     * ВЕСЬ документ из своей вкладки. Если в это время кто-то расставил устройства с другого
     * устройства, его работа затиралась снимком часовой давности. Молча.
     *
     * Ответ сервера в `ARVID_APP.layout` тоже больше не подменяем целиком: в объекте могут
     * лежать несохранённые правки редактора — забирем только ревизию и ui.
     */
    if (options.persistToHa && window.ARVID_APP?.storage && window.ARVID_APP?.layout) {
      window.clearTimeout(this.themeSaveTimer);
      this.themeSaveTimer = window.setTimeout(() => {
        ARVID_APP.storage.updateUi({ theme })
          .then((layout) => {
            if (ARVID_APP.layout?.meta) ARVID_APP.layout.meta = layout?.meta || ARVID_APP.layout.meta;
            ARVID_LOG.info("shell", "Theme saved to HA layout", theme);
          })
          .catch((error) => {
            ARVID_LOG.error("shell", "Failed to save theme to HA layout", error);
          });
      }, 250);
    }
  }

  static initPanelToggles() {
    const shell = this.query(".arvid-shell");
    if (!shell) {
      ARVID_LOG.warn("shell", "Shell element not found");
      return;
    }

    this.applyInitialPanelState();
    this.syncPanelState();

    this.queryAll("[data-toggle-panel]").forEach((button) => {
      if (button.dataset.panelToggleReady === "1") return;
      button.dataset.panelToggleReady = "1";
      button.addEventListener("click", () => {
        const selector = button.dataset.togglePanel;
        const panel = this.getActiveRoot().querySelector(selector);

        if (!panel) {
          ARVID_LOG.warn("shell", "Panel toggle target not found", selector);
          return;
        }

        panel.classList.toggle("is-collapsed");
        this.savePanelState(panel);
        this.syncPanelState();

        ARVID_LOG.info("shell", "Panel collapsed state changed", {
          selector,
          collapsed: panel.classList.contains("is-collapsed"),
        });
      });
    });

    if (!this._panelResizeBound) {
      this._panelResizeBound = true;
      window.addEventListener("resize", () => {
        window.clearTimeout(this.resizeTimer);
        this.resizeTimer = window.setTimeout(() => this.syncPanelState(), 120);
      });
    }
  }

  static isMobilePortrait() {
    return window.matchMedia("(max-width: 760px) and (orientation: portrait)").matches;
  }

  static getPanelStorageKey(panel) {
    if (panel.id === "leftPanel") return "arvid.leftPanel.collapsed";
    if (panel.id === "rightPanel") return "arvid.rightPanel.collapsed";
    return null;
  }

  static applyInitialPanelState() {
    const leftPanel = this.query("#leftPanel");
    const rightPanel = this.query("#rightPanel");

    [leftPanel, rightPanel].forEach((panel) => {
      if (!panel) return;

      const key = this.getPanelStorageKey(panel);
      const stored = key ? localStorage.getItem(key) : null;

      // На телефоне правую панель больше не превращаем в overlay-sheet.
      // Она отображается отдельным блоком под планом, поэтому держим её раскрытой.
      if (panel.id === "rightPanel" && this.isMobilePortrait()) {
        panel.classList.remove("is-collapsed");
        return;
      }

      const shouldCollapse = stored === "1";
      panel.classList.toggle("is-collapsed", shouldCollapse);
    });
  }

  static savePanelState(panel) {
    const key = this.getPanelStorageKey(panel);
    if (!key) return;

    localStorage.setItem(key, panel.classList.contains("is-collapsed") ? "1" : "0");
  }

  static syncPanelState() {
    const shell = this.query(".arvid-shell");
    const leftPanel = this.query("#leftPanel");
    const rightPanel = this.query("#rightPanel");

    if (!shell) return;

    const mobilePortrait = this.isMobilePortrait();

    // В вертикальной мобильной версии панели работают в специальной компоновке:
    // левая панель превращается в верхнюю строку, правая — в компактный блок под планом.
    if (mobilePortrait && leftPanel?.classList.contains("is-collapsed")) {
      leftPanel.classList.remove("is-collapsed");
    }

    if (mobilePortrait && rightPanel?.classList.contains("is-collapsed")) {
      rightPanel.classList.remove("is-collapsed");
    }

    const leftCollapsed = leftPanel?.classList.contains("is-collapsed") || false;
    const rightCollapsed = rightPanel?.classList.contains("is-collapsed") || false;

    shell.classList.toggle("is-left-collapsed", leftCollapsed);
    shell.classList.toggle("is-right-collapsed", rightCollapsed);
    shell.classList.toggle("is-mobile-portrait", mobilePortrait);

    this.updatePanelToggleLabels();
  }

  static updatePanelToggleLabels() {
    this.queryAll("[data-toggle-panel]").forEach((button) => {
      const selector = button.dataset.togglePanel;
      const panel = this.getActiveRoot().querySelector(selector);
      if (!panel) return;

      const collapsed = panel.classList.contains("is-collapsed");
      const isRight = panel.id === "rightPanel";
      const label = collapsed
        ? isRight ? "Открыть общие функции" : "Открыть меню"
        : isRight ? "Свернуть общие функции" : "Свернуть меню";

      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    });
  }

  static startClock() {
    const tick = () => {
      const now = new Date();
      document.querySelectorAll("[data-clock-time]").forEach((timeEl) => {
        timeEl.textContent = now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      });
      document.querySelectorAll("[data-clock-date]").forEach((dateEl) => {
        dateEl.textContent = now.toLocaleDateString("ru-RU", { day: "2-digit", month: "long", weekday: "long" });
      });
    };

    tick();
    if (this._clockStarted) return;
    this._clockStarted = true;
    setInterval(tick, 30000);
  }

  static renderBrand(layout) {
    const logo = ARVID_CONFIG.resolveAssetUrl(layout?.building?.logo, "assets/logo/arvid-logo.svg");
    const name = layout?.building?.company || "ARVID";
    const building = layout?.building?.name || "Smart Building";

    ARVID_LOG.debug("shell", "Brand assets resolved", { logo, localBasePath: ARVID_CONFIG.LOCAL_BASE_PATH });
    document.querySelectorAll("[data-company-logo]").forEach((img) => { img.src = logo; });
    document.querySelectorAll("[data-company-name]").forEach((el) => { el.textContent = name; });
    document.querySelectorAll("[data-building-name]").forEach((el) => { el.textContent = building; });
  }
}

window.ArvidShellUi = ArvidShellUi;
