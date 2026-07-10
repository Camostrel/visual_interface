/**
 * Home Assistant WebSocket client.
 * Responsible for auth, command calls, service calls and state subscriptions.
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

  connect() {
    return new Promise((resolve, reject) => {
      const wsUrl = this.getWsUrl();
      ARVID_LOG.info(this.logArea, "Connecting to Home Assistant WebSocket", wsUrl);

      this.socket = new WebSocket(wsUrl);

      this.socket.addEventListener("open", () => {
        ARVID_LOG.debug(this.logArea, "Socket opened, waiting for auth_required");
      });

      this.socket.addEventListener("message", (event) => {
        this.handleMessage(event, resolve, reject);
      });

      this.socket.addEventListener("error", (event) => {
        ARVID_LOG.error(this.logArea, "WebSocket error", event);
        reject(new Error("Home Assistant WebSocket connection error"));
      });

      this.socket.addEventListener("close", (event) => {
        ARVID_LOG.warn(this.logArea, "WebSocket closed", {
          code: event.code,
          reason: event.reason,
        });
        this.isAuthed = false;
      });
    });
  }

  handleMessage(event, resolveConnect, rejectConnect) {
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
      this.isAuthed = true;
      ARVID_LOG.info(this.logArea, "Home Assistant WebSocket auth OK");
      resolveConnect(this);
      return;
    }

    if (msg.type === "auth_invalid") {
      ARVID_LOG.error(this.logArea, "Home Assistant token rejected", msg);
      rejectConnect(new Error("Home Assistant token rejected"));
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
   * Подписка на произвольную WS-команду, которая шлёт push-события с тем же id
   * (например arvid_dali_center/health_subscribe).
   * Первый ответ — снимок (result), дальше приходят события в onEvent.
   * Возвращает result снимка; при ошибке (нет команды) промис отклоняется.
   */
  subscribeCommand(command, onEvent) {
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
          ARVID_LOG.info(this.logArea, "Subscribed to command", { id, type: command.type });
          resolve(result);
        },
        reject,
      });
    });
  }

  subscribeStateChanged(handler) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.isAuthed) {
      return Promise.reject(new Error("WebSocket is not connected or not authenticated"));
    }

    const id = this.messageId++;
    const payload = {
      id,
      type: "subscribe_events",
      event_type: "state_changed",
    };

    ARVID_LOG.debug(this.logArea, "Sending state_changed subscription", payload);
    this.socket.send(JSON.stringify(payload));

    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        type: payload.type,
        resolve: (result) => {
          this.eventHandlers.set(id, handler);
          ARVID_LOG.info(this.logArea, "Subscribed to state_changed events", { id, result });
          resolve(id);
        },
        reject,
      });
    });
  }
}

window.ArvidHaWebSocket = ArvidHaWebSocket;
