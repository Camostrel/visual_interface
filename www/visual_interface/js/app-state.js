/**
 * Общие runtime-данные SPA.
 * Данные Home Assistant загружаем один раз и переиспользуем между views.
 */
window.ARVID_APP = {
  ha: null,
  storage: null,
  registry: null,
  layout: null,
  health: null,
  currentFloorId: null,
  currentAreaId: null,

  /**
   * СОСТАВ комнаты — истина из Home Assistant (v0.7.0).
   * Только сущности с этим area_id (напрямую или через устройство).
   * По этому списку считаются карточки, счётчики «N/N включено» и статистика комнаты.
   */
  entitiesForArea(areaId) {
    if (!this.registry || !areaId) return [];
    return this.registry.getEntitiesForArea(areaId);
  },

  /**
   * РАЗМЕЩЁННЫЕ на плане этой комнаты (наш layout: координаты + area_id).
   * По этому списку рисуются маркеры. Устройство может быть размещено здесь,
   * но НЕ иметь HA-area — тогда оно помечается как непривязанное (см. room-page).
   */
  placedEntitiesForRoom(areaId) {
    if (!this.registry || !areaId) return [];

    const devices = this.layout?.devices || {};
    const result = [];
    Object.keys(devices).forEach((entityId) => {
      if (devices[entityId]?.area_id !== areaId) return;
      const state = this.registry.getState(entityId);
      if (state) result.push(state);
    });
    return result;
  },

  /**
   * Объединение состава и размещённых — нужно только для подписки на изменения
   * (какие события считать «своими»), но НЕ для состава комнаты.
   */
  entitiesForRoom(areaId) {
    const result = new Map();
    this.entitiesForArea(areaId).forEach((state) => result.set(state.entity_id, state));
    this.placedEntitiesForRoom(areaId).forEach((state) => result.set(state.entity_id, state));
    return [...result.values()];
  },

  // Устройство размещено в комнате, но в HA привязано не к ней (или ни к чему).
  isUnassignedInRoom(entityId, areaId) {
    return this.registry?.getAreaForEntity(entityId) !== areaId;
  },

  /**
   * HA-группа света по формуле имени (v0.6.0):
   *   комната → light.<area_id>   (например area «Офис» = ofis → light.ofis)
   *   этаж    → light.<floor_id>  (например «3 этаж» = 3_etazh → light.3_etazh)
   * Группы создаются в HA заранее (логические группы из DALI-групп) — это детерминированный
   * путь управления. Если группы нет, вызывающий код падает в фолбэк-сборку ламп.
   */
  lightGroupState(objectId) {
    if (!this.registry || !objectId) return null;
    return this.registry.getState(`light.${objectId}`);
  },

  /**
   * Сущность — ГРУППА света, а не физический светильник (v0.9.0).
   * Группы не должны попадать ни в счётчик «N/N включено», ни в состав комнаты,
   * ни на план: иначе одна и та же лампа считается дважды (сама и через группу).
   *
   * Два вида групп:
   *  1. DALI-группа ядра (`DaliGroupLight`) — у её УСТРОЙСТВА в реестре HA
   *     `model = "DALI Group"` (см. light.py ядра). Это надёжный признак: имя группы
   *     произвольное («r2»), по entity_id её не отличить от лампы.
   *  2. Группа/хелпер самого HA (light group) — состояния групп несут в атрибутах
   *     список членов `entity_id: [...]`. Так ловятся light.<area_id>/<floor_id>/all,
   *     заведённые в HA вручную.
   */
  isLightGroupState(state) {
    const entityId = state?.entity_id || "";
    if (!entityId.startsWith("light.")) return false;

    if (this.registry?.getDeviceModel(entityId) === "DALI Group") return true;

    // HA-группа света перечисляет своих членов в атрибуте entity_id.
    return Array.isArray(state?.attributes?.entity_id);
  },
};

window.ARVID_RUNTIME = {
  dataPromise: null,
  stateSubscriptionPromise: null,
  stateHandlers: new Set(),

  async ensureData(logArea = "runtime") {
    if (ARVID_APP.ha && ARVID_APP.storage && ARVID_APP.registry && ARVID_APP.layout) {
      return ARVID_APP;
    }

    if (this.dataPromise) return this.dataPromise;

    this.dataPromise = this.loadData(logArea).catch((error) => {
      this.dataPromise = null;
      throw error;
    });

    return this.dataPromise;
  },

  // Ключ снимка для мгновенной отрисовки (v0.11.4). Схема привязана к версии приложения.
  snapshotKey: "arvid.snapshot.v1",

  async loadData(logArea) {
    const config = window.ARVID_CONFIG;

    if (!config.HA_TOKEN || config.HA_TOKEN.includes("PASTE_")) {
      ARVID_LOG.error(logArea, "HA token is not configured in js/config.js");
      throw new Error("HA_TOKEN не задан в js/config.js");
    }

    ARVID_LOG.info(logArea, "Loading shared ARVID data for SPA");
    // WS поднимаем всегда и первым: коннект быстрый, а без него ни управлять светом, ни получать
    // живые данные нельзя. Тяжёлый loadAll (снимок всех состояний+реестров) откладываем.
    ARVID_APP.ha = await new ArvidHaWebSocket(config).connect();
    ARVID_APP.storage = new ArvidFloorplanStorage(ARVID_APP.ha);
    ARVID_APP.registry = new ArvidHaRegistry(ARVID_APP.ha);
    // Здоровье устройств берём у ядра DALI. Объект создаём сразу, снимок запрашивает страница
    // (ядра может не быть — тогда модуль сам себя отключит, остальной интерфейс не страдает).
    ARVID_APP.health = new ArvidHealth(ARVID_APP.ha, ARVID_APP.registry);

    // Реконнект: пока связи не было, свет могли включить, датчики — сработать. Наши состояния
    // устарели, а событий за время обрыва нам никто не перешлёт. Поэтому после восстановления
    // связи перечитываем снимок целиком (v0.11.0, A3).
    ARVID_APP.ha.addStatusHandler((status) => this.handleConnectionStatus(status));

    /**
     * МГНОВЕННАЯ ОТРИСОВКА ИЗ СНАПШОТА (v0.11.4).
     *
     * Кеш файлов (?v=версия) экономит скачивание, но не отменяет ПЕРЕЗАПУСК приложения при
     * пересоздании iframe в дашборде HA: каждый заход — заново WS + loadAll + отрисовка, и
     * пользователь видит паузу «пересборки». Главная задержка — loadAll (полный снимок всех
     * состояний и реестров по WS).
     *
     * Поэтому держим последний снимок в localStorage (переживает пересоздание iframe): на старте
     * рисуем план СРАЗУ из него, а живые данные подтягиваем в фоне и перерисовываем. Снимок —
     * только для первой отрисовки; истина по-прежнему HA, живые данные его тут же перекрывают.
     */
    const snapshot = this.readSnapshot();
    if (snapshot) {
      ARVID_APP.registry.applyData(snapshot.data);   // гидратация реестра + индексы
      ARVID_APP.layout = snapshot.layout;
      ARVID_APP.live = false;
      ARVID_LOG.info(logArea, "Мгновенная отрисовка из снапшота", {
        states: ARVID_APP.registry.states.length,
        ageMs: snapshot.ts ? Date.now() - snapshot.ts : null,
      });
      this.refreshLive(logArea);   // не ждём: живые данные приедут и перерисуют
      return ARVID_APP;
    }

    // Снимка нет (первый запуск или другая версия) — полная загрузка, как раньше.
    await this.loadLive(logArea);
    ARVID_APP.live = true;
    return ARVID_APP;
  },

  // Живая загрузка: полный снимок состояний+реестров из HA + layout. Пишет снапшот на будущее.
  async loadLive(logArea) {
    await ARVID_APP.storage.ping();
    await ARVID_APP.registry.loadAll();
    // Состав (сущности/устройства/области) меняется в HA и без нашего участия: задали area,
    // переименовали лампу, добавили датчик. Слушаем реестры, чтобы не застывать до F5 (D5).
    if (!this._registrySubscribed) {
      this._registrySubscribed = true;
      await ARVID_APP.registry.subscribeRegistryUpdates();
    }
    ARVID_APP.layout = await ARVID_APP.storage.getLayout();
    this.writeSnapshot();

    ARVID_LOG.info(logArea, "Живые данные HA загружены", {
      floors: ARVID_APP.registry.floors.length,
      areas: ARVID_APP.registry.areas.length,
      states: ARVID_APP.registry.states.length,
    });
  },

  // Фоновое обновление поверх снапшота: приезжают живые данные → перерисовываем страницы.
  async refreshLive(logArea) {
    try {
      await this.loadLive(logArea);
      ARVID_APP.live = true;
      ARVID_APP.registry.notifyComposition("живые данные загружены");
    } catch (error) {
      ARVID_LOG.error(logArea, "Не удалось подтянуть живые данные поверх снапшота", error);
    }
  },

  handleConnectionStatus(status) {
    const wasOffline = this._connectionLost === true;

    if (status === "offline") {
      this._connectionLost = true;
      return;
    }

    if (status !== "online" || !wasOffline) return;

    this._connectionLost = false;
    ARVID_LOG.info("runtime", "Связь восстановлена — перечитываем состояния HA");

    ARVID_APP.registry.loadAll()
      .then(() => {
        this.writeSnapshot();
        // Состав/состояния могли измениться за время обрыва — просим страницы перерисоваться.
        ARVID_APP.registry.notifyComposition("связь восстановлена");
      })
      .catch((error) => {
        ARVID_LOG.error("runtime", "Не удалось перечитать состояния после реконнекта", error);
      });
  },

  /**
   * Снимок для мгновенной отрисовки: реестры + состояния + layout в localStorage.
   * Привязан к версии приложения — после деплоя (смена схемы) старый снимок игнорируем.
   */
  readSnapshot() {
    try {
      const raw = localStorage.getItem(this.snapshotKey);
      if (!raw) return null;

      const snap = JSON.parse(raw);
      if (!snap || snap.v !== window.ARVID_CONFIG.VERSION) {
        ARVID_LOG.debug("runtime", "Снимок другой версии — пропускаем", { was: snap?.v });
        return null;
      }
      if (!snap.data || !Array.isArray(snap.data.states) || !snap.data.states.length) return null;

      return snap;
    } catch (error) {
      ARVID_LOG.debug("runtime", "Снимок нечитаем — пропускаем", error);
      return null;
    }
  },

  writeSnapshot() {
    const registry = ARVID_APP.registry;
    if (!registry || !ARVID_APP.layout) return;

    try {
      const snap = {
        v: window.ARVID_CONFIG.VERSION,
        ts: Date.now(),
        data: {
          floors: registry.floors,
          areas: registry.areas,
          entities: registry.entities,
          devices: registry.devices,
          states: registry.states,
        },
        layout: ARVID_APP.layout,
      };
      localStorage.setItem(this.snapshotKey, JSON.stringify(snap));
    } catch (error) {
      // QuotaExceededError на большом объекте — снимок просто не сохраняем: интерфейс работает
      // как раньше (полная загрузка при старте), только без мгновенной отрисовки.
      ARVID_LOG.warn("runtime", "Снимок не сохранён (вероятно, лимит localStorage) — деградируем к полной загрузке", error);
      try { localStorage.removeItem(this.snapshotKey); } catch (e) { /* ignore */ }
    }
  },

  addStateHandler(handler) {
    if (typeof handler !== "function") return;
    this.stateHandlers.add(handler);
    this.ensureStateSubscription().catch((error) => {
      ARVID_LOG.error("runtime", "Failed to initialize shared state subscription", error);
    });
  },

  async ensureStateSubscription() {
    if (this.stateSubscriptionPromise) return this.stateSubscriptionPromise;

    this.stateSubscriptionPromise = this.ensureData("runtime").then(() => ARVID_APP.ha.subscribeStateChanged((event) => {
      ARVID_APP.registry.updateStateFromEvent(event);
      this.stateHandlers.forEach((handler) => {
        try {
          handler(event);
        } catch (error) {
          ARVID_LOG.error("runtime", "State handler failed", error);
        }
      });
    }));

    return this.stateSubscriptionPromise;
  },
};
