/**
 * SPA-маршрутизатор ARVID.
 * Переключает Главную и Комнату без перезагрузки index.html.
 * Редактирование расстановки — режим внутри комнаты, отдельного view у него нет.
 */
class ArvidSpaApp {
  constructor() {
    this.logArea = "spa";
    this.pages = {};
    this.currentView = null;
  }

  async init() {
    this.bindNavigation();
    window.addEventListener("popstate", () => {
      this.routeFromLocation({ replace: true }).catch((error) => this.handleRouteError(error));
    });

    await this.routeFromLocation({ replace: true });
    ARVID_LOG.info(this.logArea, "SPA initialized");
  }

  bindNavigation() {
    document.addEventListener("click", (event) => {
      const routeButton = event.target.closest?.("[data-route-view]");
      if (routeButton) {
        event.preventDefault();
        const view = routeButton.dataset.routeView;
        this.navigate(view, this.getDefaultParamsForView(view)).catch((error) => this.handleRouteError(error));
        return;
      }

      const link = event.target.closest?.("a[data-spa-link]");
      if (!link) return;

      const url = new URL(link.href, window.location.href);
      if (!this.isLocalIndexUrl(url)) return;

      event.preventDefault();
      const route = this.parseRoute(url.searchParams);
      this.navigate(route.view, route.params).catch((error) => this.handleRouteError(error));
    });
  }

  isLocalIndexUrl(url) {
    if (url.origin !== window.location.origin) return false;
    const currentPath = window.location.pathname.replace(/\/[^/]*$/, "/");
    const urlPath = url.pathname.replace(/\/[^/]*$/, "/");
    return currentPath === urlPath && /\/index\.html$/.test(url.pathname);
  }

  getDefaultParamsForView(view) {
    const params = {};

    if (ARVID_APP.currentFloorId) params.floor_id = ARVID_APP.currentFloorId;
    if (view === "room" && ARVID_APP.currentAreaId) {
      params.area_id = ARVID_APP.currentAreaId;
    }

    return params;
  }

  parseRoute(searchParams = new URLSearchParams(window.location.search)) {
    const params = Object.fromEntries(searchParams.entries());
    let view = params.view || "floor";
    delete params.view;

    // Для старых внутренних ссылок вида index.html?area_id=... считаем, что открывается комната.
    if (!searchParams.get("view") && params.area_id) {
      view = "room";
    }

    if (!["floor", "room"].includes(view)) {
      ARVID_LOG.warn(this.logArea, "Unknown view requested, fallback to floor", { view });
      view = "floor";
    }

    return { view, params };
  }

  buildUrl(view, params = {}) {
    const search = new URLSearchParams();

    if (view !== "floor") search.set("view", view);

    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        search.set(key, value);
      }
    });

    const query = search.toString();
    return `index.html${query ? `?${query}` : ""}`;
  }

  async navigate(view, params = {}, options = {}) {
    const url = this.buildUrl(view, params);

    if (options.replace) {
      window.history.replaceState({ view, params }, "", url);
    } else {
      window.history.pushState({ view, params }, "", url);
    }

    await this.showView(view, params);
  }

  async routeFromLocation(options = {}) {
    const route = this.parseRoute();
    await this.navigate(route.view, route.params, { replace: options.replace });
  }

  getTransitionDirection(from, to) {
    if (!from || from === to) return "none";
    if (to === "room") return "floor-to-room";
    if (to === "floor") return "room-to-floor";
    return "none";
  }

  async showView(view, params = {}) {
    if (view === "room" && !params.area_id) {
      ARVID_LOG.warn(this.logArea, "Room view requested without area_id, fallback to floor");
      await this.navigate("floor", params, { replace: true });
      return;
    }

    this.beforeViewChange();

    const direction = this.getTransitionDirection(this.currentView, view);
    const html = document.documentElement;
    if (direction !== "none") html.dataset.navTransition = direction;

    if (document.startViewTransition && direction !== "none") {
      const transition = document.startViewTransition(() => {
        this.activateView(view);
      });
      await Promise.all([transition.finished, this.getPage(view).init(params)]);
    } else {
      this.activateView(view);
      await this.getPage(view).init(params);
    }

    if (direction !== "none") delete html.dataset.navTransition;
    this.currentView = view;
    this.syncRouteButtons(view);
    this.updateTitle(view);

    ARVID_LOG.info(this.logArea, "View shown", { view, params });
  }

  beforeViewChange() {
    this.pages.floor?.closeMobileAccordionOverlay?.();
    this.pages.room?.closeDevicePopup?.();
  }

  activateView(view) {
    document.querySelectorAll(".spa-view[data-spa-view]").forEach((el) => {
      el.hidden = el.dataset.spaView !== view;
    });
  }

  getPage(view) {
    if (this.pages[view]) return this.pages[view];

    if (view === "floor") this.pages.floor = new ArvidFloorPage();
    if (view === "room") this.pages.room = new ArvidRoomPage();

    return this.pages[view];
  }

  syncRouteButtons(activeView) {
    document.querySelectorAll("[data-route-view]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.routeView === activeView);
    });
  }

  updateTitle(view) {
    const titles = {
      floor: "ARVID Visual Interface",
      room: "ARVID Visual Interface — Помещение",
    };
    document.title = titles[view] || titles.floor;
  }

  handleRouteError(error) {
    ARVID_LOG.error(this.logArea, "Route failed", error);
    const activeView = document.querySelector("[data-spa-view]:not([hidden])");
    if (activeView) {
      activeView.innerHTML = `<div class="arvid-error">Ошибка маршрута: ${error.message || error}</div>`;
    }
  }
}

window.ArvidSpaApp = ArvidSpaApp;
