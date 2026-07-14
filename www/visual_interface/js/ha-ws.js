/**
 * Home Assistant WebSocket client.
 * Responsible for auth, command calls, service calls and state subscriptions.
 *
 * v0.11.0 — РЕКОННЕКТ (долг A3). Раньше обработчик `close` только писал в лог, и после любого
 * обрыва (рестарт HA, Wi-Fi, ночь) интерфейс показывал ЗАСТЫВШУЮ, убедительно выглядящую
 * картинку: зоны горят, датчики «работают», а тапы молча отваливались. Лечилось только F5 —
 * о чём диспетчер не догадается. Для настенного экрана 24/7 это был дефект №1.
 *
 * Теперь:
 *  - переподключение с нарастающей паузой (1с → 30с), бесконечно;
 *  - подписки восстанавливаются сами (мы помним, на что подписаны, — id после реконнекта новые);
 *  - висящие запросы при обрыве ОТКЛОНЯЮТСЯ (раньше их промисы не завершались никогда);
 *  - статус связи транслируется наружу (addStatusHandler) — по нему рисуется плашка «нет связи».
 */
class ArvidHaWebSocket {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.messageId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.isAuthed = false;
    this.logArea = "ha-ws";

    // Подписки, которые нужно восстановить после реконнекта: id меняется, суть — нет.
    this.subscriptions = [];
    this.statusHandlers = new Set();
    this.status = "connecting";        // connecting | online | offline
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
  }

  static get RECONNECT_MIN_MS() {
    return 1000;
  }

  static get RECONNECT_MAX_MS() {
    return 30000;
  }

  getBaseUrl() {
    return this.config.HA_BASE_URL || window.location.origin;
  }

  getWsUrl() {
    const base = new URL(this.getBaseUrl());
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = "/api/websocket";
    base.search = "";
    return base.toString();
  }

  // ------------------------------------------------------------------
  // Статус связи (для плашки «нет связи»)
  // ------------------------------------------------------------------

  addStatusHandler(handler) {
    if (typeof handler !== "function") return;
    this.statusHandlers.add(handler);
    handler(this.status);   // сразу отдаём текущее состояние
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;

    ARVID_LOG.info(this.logArea, "Состояние связи с Home Assistant", { status });
    this.statusHandlers.forEach((handler) => {
      try {
        handler(status);
      } catch (error) {
        ARVID_LOG.error(this.logArea, "Обработчик статуса связи упал", error);
      }
    });
  }

  isOnline() {
    return this.status === "online";
  }

  // ------------------------------------------------------------------
  // Подключение
  // ------------------------------------------------------------------

  /** Первое подключение. Промис ждёт auth_ok (дальше реконнект живёт сам). */
  connect() {
    return new Promise((resolve, reject) => {
      this._firstConnect = { resolve, reject };
      this.openSocket();
    });
  }

  openSocket() {
    const wsUrl = this.getWsUrl();
    ARVID_LOG.info(this.logArea, "Connecting to Home Assistant WebSocket", wsUrl);
    this.setStatus(this.reconnectAttempt ? "offline" : "connecting");

    this.socket = new WebSocket(wsUrl);

    this.socket.addEventListener("open", () => {
      ARVID_LOG.debug(this.logArea, "Socket opened, waiting for auth_required");
    });

    this.socket.addEventListener("message", (event) => {
      this.handleMessage(event);
    });

    this.socket.addEventListener("error", (event) => {
      ARVID_LOG.error(this.logArea, "WebSocket error", event);
      // Не реджектим соединение здесь: за «error» всегда следует «close», где мы и решаем,
      // что делать. Иначе первый же сетевой чих убивал промис connect() навсегда.
    });

    this.socket.addEventListener("close", (event) => {
      this.handleClose(event);
    });
  }

  handleClose(event) {
    const wasAuthed = this.isAuthed;
    this.isAuthed = false;

    ARVID_LOG.warn(this.logArea, "WebSocket closed", {
      code: event.code,
      reason: event.reason,
      wasAuthed,
    });

    // Висящие запросы: их ответ уже не придёт никогда. Раньше промисы просто оставались
    // неразрешёнными — вызывающий код ждал вечно.
    this.rejectAllPending(new Error("Соединение с Home Assistant потеряно"));
    this.eventHandlers.clear();

    this.setStatus("offline");

    if (!this.shouldReconnect) return;
    this.scheduleReconnect();
  }

  rejectAllPending(error) {
    this.pending.forEach((pending) => {
      try {
        pending.reject(error);
      } catch (err) {
        ARVID_LOG.debug(this.logArea, "Не удалось отклонить ожидающий запрос", err);
      }
    });
    this.pending.clear();
  }

  /** Пауза растёт 1с → 2с → 4с … до 30с: сеть может лежать долго, долбить её незачем. */
  scheduleReconnect() {
    if (this.reconnectTimer) return;

    const delay = Math.min(
      ArvidHaWebSocket.RECONNECT_MIN_MS * (2 ** this.reconnectAttempt),
      ArvidHaWebSocket.RECONNECT_MAX_MS,
    );
    this.reconnectAttempt += 1;

    ARVID_LOG.info(this.logArea, "Переподключение к Home Assistant", {
      attempt: this.reconnectAttempt,
      delayMs: delay,
    });

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  handleMessage(event) {
    let msg;

    try {
      msg = JSON.parse(event.data);
    } catch (error) {
      ARVID_LOG.error(this.logArea, "Failed to parse WebSocket message", event.data);
      return;
    }

    if (msg.type === "auth_required") {
      ARVID_LOG.debug(this.logArea, "Auth required, sending token");
      this.socket.send(JSON.stringify({
        type: "auth",
        access_token: this.config.HA_TOKEN,
      }));
      return;
    }

    if (msg.type === "auth_ok") {
      this.onAuthOk();
      return;
    }

    if (msg.type === "auth_invalid") {
      // Токен не примут и со второй попытки — реконнект здесь бессмысленен и вреден.
      ARVID_LOG.error(this.logArea, "Home Assistant token rejected", msg);
      this.shouldReconnect = false;
      this.setStatus("offline");
      this._firstConnect?.reject(new Error("Home Assistant token rejected"));
      this._firstConnect = null;
      return;
    }

    if (msg.id && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);

      if (msg.success === false) {
        ARVID_LOG.error(this.logArea, "Command failed", msg);
        pending.reject(msg.error || msg);
      } else {
        ARVID_LOG.debug(this.logArea, "Command success", {
          id: msg.id,
          type: pending.type,
        });
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.type === "event" && this.eventHandlers.has(msg.id)) {
      this.eventHandlers.get(msg.id)(msg.event);
      return;
    }

    ARVID_LOG.debug(this.logArea, "Unhandled WebSocket message", msg);
  }

  onAuthOk() {
    const isReconnect = this.reconnectAttempt > 0;
    this.isAuthed = true;
    this.reconnectAttempt = 0;

    ARVID_LOG.info(this.logArea, "Home Assistant WebSocket auth OK", { isReconnect });
    this.setStatus("online");

    // Первое подключение: отдаём промис вызывающему (ARVID_RUNTIME.loadData).
    if (this._firstConnect) {
      this._firstConnect.resolve(this);
      this._firstConnect = null;
      return;
    }

    if (isReconnect) this.restoreSubscriptions();
  }

  /**
   * Восстановление подписок после реконнекта.
   * Подписки живут по id соединения — после разрыва все id мертвы, нужно подписаться заново.
   * Иначе интерфейс «подключён», но событий не получает — та же застывшая картинка.
   */
  restoreSubscriptions() {
    const toRestore = [...this.subscriptions];
    this.subscriptions = [];

    ARVID_LOG.info(this.logArea, "Восстанавливаем подписки после реконнекта", {
      count: toRestore.length,
    });

    toRestore.forEach(({ command, onEvent, onSnapshot }) => {
      this.subscribeCommand(command, onEvent, { onSnapshot })
        .then((snapshot) => {
          // Снимок при переподписке — не то же самое, что событие: health_subscribe отдаёт
          // им ТЕКУЩЕЕ здоровье. Без этого «Диагностика» ждала бы следующего пересчёта ядра.
          if (onSnapshot) onSnapshot(snapshot);
        })
        .catch((error) => {
          ARVID_LOG.error(this.logArea, "Не удалось восстановить подписку", { command, error });
        });
    });
  }

  // ------------------------------------------------------------------
  // Команды
  // ------------------------------------------------------------------

  send(command) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.isAuthed) {
      return Promise.reject(new Error("WebSocket is not connected or not authenticated"));
    }

    const id = this.messageId++;
    const payload = { id, ...command };

    ARVID_LOG.debug(this.logArea, "Sending command", payload);
    this.socket.send(JSON.stringify(payload));

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, type: command.type });
    });
  }

  callService(domain, service, serviceData = {}, target = {}) {
    ARVID_LOG.info(this.logArea, "Calling HA service", {
      domain,
      service,
      serviceData,
      target,
    });

    return this.send({
      type: "call_service",
      domain,
      service,
      service_data: serviceData,
      target,
    });
  }

  /**
   * Подписка на команду, которая шлёт push-события с тем же id
   * (`subscribe_events`, `arvid_dali_center/health_subscribe`, …).
   * Первый ответ — снимок (result), дальше приходят события в onEvent.
   * Подписку запоминаем: после реконнекта её нужно оформить заново (id будет другой).
   */
  subscribeCommand(command, onEvent, options = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.isAuthed) {
      return Promise.reject(new Error("WebSocket is not connected or not authenticated"));
    }

    const id = this.messageId++;
    const payload = { id, ...command };

    ARVID_LOG.debug(this.logArea, "Subscribing to command", payload);
    this.socket.send(JSON.stringify(payload));

    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        type: command.type,
        resolve: (result) => {
          // Обработчик вешаем только после успешного ответа: если команды нет, событий не будет.
          this.eventHandlers.set(id, onEvent);
          // onSnapshot нужен при ПЕРЕподписке: команда отдаёт снимок в ответе, а не событием.
          this.subscriptions.push({ command, onEvent, onSnapshot: options.onSnapshot });
          ARVID_LOG.info(this.logArea, "Subscribed to command", { id, type: command.type });
          resolve(result);
        },
        reject,
      });
    });
  }

  subscribeStateChanged(handler) {
    return this.subscribeCommand(
      { type: "subscribe_events", event_type: "state_changed" },
      handler,
    );
  }
}

window.ArvidHaWebSocket = ArvidHaWebSocket;
