/**
 * Клиент здоровья устройств — данные берём у ядра DALI, свою логику не изобретаем.
 *
 * Основной путь (ядро ≥ v1.1.1): `arvid_dali_center/health_subscribe` — PUSH-подписка
 * (read-only, без require_admin). Отдаёт снимок сразу и присылает его заново на каждый
 * пересчёт оценщика. Поллинга нет.
 *
 * Фолбэк (старое ядро, `unknown_command`): `health_data` + опрос по таймеру.
 *
 * ⚠ Почему именно подписка, а не поллинг (ядро, docs/HEALTH.md):
 *  - `health_data` ФОРСИРУЕТ полный пересчёт здоровья на каждый запрос: обход всех устройств
 *    всех шлюзов + резолв трёх реестров на каждое, синхронно в петле HA. Две открытые вкладки =
 *    два прохода. На объекте это тысячи устройств. Подписка пересчёт не вызывает — она получает
 *    результат чужого.
 *  - Грейс `interval_min` (5 мин) действует на УСТРОЙСТВА, но НЕ на шлюз: `gw_offline` оценщик
 *    ставит через ~1.5 с после сигнала связи. Самое срочное событие мониторинга здания поллинг
 *    как раз и задерживал (до 300 с).
 *
 * Записи active: {key, kind, kindLabel, name, devType, gw_sn, since,
 *                 area, floor, area_id, floor_id, device_id, entity_id}.
 * ⚠ Движение и люкс — ОДНО устройство HA, но ДВЕ записи (0201/0202): разные entity_id
 * (sensor.ms_* / sensor.il_*), общий device_id. Кто рисует один маркер на пару — сопоставляет
 * по device_id (он же не меняется при переименовании, в отличие от entity_id).
 * ⚠ До первой оценки после рестарта HA (≤15 с) active отдаётся из персиста в СТАРОЙ форме,
 * без area_id/device_id — отсюда фолбэк резолва по имени помещения.
 */
class ArvidHealth {
  constructor(ha, registry) {
    this.ha = ha;
    this.registry = registry;
    this.logArea = "health";

    // null — ещё не знаем; false — ядра нет (ни подписки, ни команды).
    this.available = null;
    // "push" (health_subscribe) | "poll" (health_data по таймеру) | null
    this.mode = null;

    this.active = [];
    this.byAreaId = new Map();    // area_id → [запись, …]  — подсветка зон
    this.byDeviceId = new Map();  // device_id → [запись, …] — маркер устройства (пара ms_/il_)
    this.byEntityId = new Map();  // entity_id → [запись, …] — точечная привязка к сущности
    this.gatewayIssues = [];      // gw_offline — к помещению не привязан
    this.unmappedCount = 0;       // записи, чью область не удалось сопоставить
    this.lastUpdateAt = null;

    this._inflight = null;
    this._timer = null;
    this._intervalMs = ArvidHealth.IDLE_INTERVAL_MS;
    this._onUpdate = null;
    this._visibilityBound = false;
    this._resubscribeTimer = null;
  }

  /** Фолбэк-поллинг: не чаще периода оценщика ядра (interval_min = 5 мин). */
  static get IDLE_INTERVAL_MS() {
    return 300000;
  }

  /** Фолбэк-поллинг в режиме «Диагностика»: починенная зона гаснет быстрее. */
  static get ACTIVE_INTERVAL_MS() {
    return 30000;
  }

  /** Повтор подписки, если ядро ответило временной ошибкой (стор ещё не поднят). */
  static get RESUBSCRIBE_DELAY_MS() {
    return 60000;
  }

  /**
   * Классификация видов ошибок ядра:
   *   offline — устройство не на связи / без состояния (красный пульс);
   *   anomaly — устройство отвечает, но данные подозрительные (янтарная заливка);
   *   gateway — упал шлюз, к помещению не привязан (строка в «Предупреждениях»).
   */
  static get KIND_SEVERITY() {
    return {
      lamp_offline: "offline",
      lamp_unknown: "offline",
      sensor_unknown: "offline",
      panel_unknown: "offline",
      gw_offline: "gateway",
      motion_stuck: "anomaly",
      motion_idle: "anomaly",
      lux_stale: "anomaly",
    };
  }

  static severityOf(kind) {
    return ArvidHealth.KIND_SEVERITY[kind] || "anomaly";
  }

  /** Кого звать после каждого обновления снимка. */
  setUpdateHandler(handler) {
    this._onUpdate = handler;
  }

  notifyUpdate() {
    if (this._onUpdate) this._onUpdate(this);
  }

  /**
   * Точка входа: пробуем подписку, при её отсутствии — фолбэк на поллинг.
   * Безопасно вызывать повторно.
   */
  async start() {
    if (this.mode || this.available === false) return;
    await this.trySubscribe();
  }

  async trySubscribe() {
    try {
      const snapshot = await this.ha.subscribeCommand(
        { type: "arvid_dali_center/health_subscribe" },
        (event) => this.applySnapshot(event, "push-событие"),
      );

      this.mode = "push";
      this.available = true;
      this.applySnapshot(snapshot, "снимок подписки");
      ARVID_LOG.info(this.logArea, "Здоровье: живая подписка health_subscribe");
      return;
    } catch (error) {
      if (error?.code === "unknown_command") {
        // Старое ядро (< v1.1.1): подписки нет, живём на поллинге health_data.
        ARVID_LOG.warn(this.logArea, "health_subscribe нет — фолбэк на поллинг health_data", error);
        this.mode = "poll";
        this.refresh();
        this.startPolling(this._intervalMs);
        return;
      }

      // Временная ошибка (стор ещё не поднят / обрыв WS) — повторим подписку позже.
      ARVID_LOG.warn(this.logArea, "health_subscribe не удалась, повтор позже", error);
      this.scheduleResubscribe();
    }
  }

  scheduleResubscribe() {
    if (this._resubscribeTimer) return;
    this._resubscribeTimer = window.setTimeout(() => {
      this._resubscribeTimer = null;
      this.trySubscribe();
    }, ArvidHealth.RESUBSCRIBE_DELAY_MS);
  }

  /** Снимок (из подписки или из health_data) → индексы → обновление UI. */
  applySnapshot(payload, source) {
    this.lastUpdateAt = Date.now();
    this.indexActive(payload?.active || []);

    ARVID_LOG.debug(this.logArea, "Снимок здоровья", {
      source,
      active: this.active.length,
      rooms: this.byAreaId.size,
      gateways: this.gatewayIssues.length,
      unmapped: this.unmappedCount,
    });

    this.notifyUpdate();
  }

  /**
   * Фолбэк-режим: разовый снимок через health_data.
   * В push-режиме не нужен — данные приходят сами.
   */
  async refresh() {
    if (this.mode !== "poll") return null;
    if (this._inflight) return this._inflight;

    this._inflight = this.ha.send({ type: "arvid_dali_center/health_data" })
      .then((result) => {
        this.available = true;
        this.applySnapshot(result, "health_data");
        return this;
      })
      .catch((error) => {
        // unknown_command — ядра нет вовсе: выключаем модуль, чтобы не долбить WS.
        if (error?.code === "unknown_command") {
          this.available = false;
          this.stopPolling();
          this.active = [];
          this.byAreaId.clear();
          this.byDeviceId.clear();
          this.byEntityId.clear();
          this.gatewayIssues = [];

          ARVID_LOG.warn(this.logArea, "Ядро arvid_dali_center не отвечает — Диагностика без данных", error);
          this.notifyUpdate();
          return null;
        }

        // Обрыв WS / стор не поднят — временно: снимок оставляем, поллинг продолжается.
        ARVID_LOG.warn(this.logArea, "Снимок health не получен, повторим по таймеру", error);
        return null;
      })
      .finally(() => {
        this._inflight = null;
      });

    return this._inflight;
  }

  /**
   * Карта «имя помещения → area_id» — фолбэк для записей из персиста (без area_id).
   * Строим на каждый снимок: помещения могли переименовать.
   * Дубли имён исключаем — сопоставить их однозначно нельзя.
   */
  buildAreaNameIndex() {
    const byName = new Map();
    const duplicates = new Set();

    (this.registry?.areas || []).forEach((area) => {
      const name = String(area.name || "").trim().toLowerCase();
      if (!name) return;
      if (byName.has(name)) duplicates.add(name);
      byName.set(name, area.area_id);
    });

    duplicates.forEach((name) => byName.delete(name));
    if (duplicates.size) {
      ARVID_LOG.warn(this.logArea, "Дубли имён помещений — health по ним не сопоставим", [...duplicates]);
    }

    return byName;
  }

  /** area_id записи: из ядра (v1.1.1+); иначе — резолв по имени (записи из персиста). */
  resolveAreaId(record, nameIndex) {
    if (record.area_id) return record.area_id;
    const name = String(record.area || "").trim().toLowerCase();
    return name ? nameIndex.get(name) || null : null;
  }

  indexActive(records) {
    const nameIndex = this.buildAreaNameIndex();

    this.active = records.map((record) => ({
      ...record,
      severity: ArvidHealth.severityOf(record.kind),
    }));
    this.byAreaId = new Map();
    this.byDeviceId = new Map();
    this.byEntityId = new Map();
    this.gatewayIssues = [];
    this.unmappedCount = 0;

    this.active.forEach((record) => {
      if (record.severity === "gateway") {
        this.gatewayIssues.push(record);
        return;
      }

      // Устройство: маркер на плане — по device_id (один на пару ms_/il_),
      // точечная привязка к сущности — по entity_id.
      if (record.device_id) ArvidHealth.pushTo(this.byDeviceId, record.device_id, record);
      if (record.entity_id) ArvidHealth.pushTo(this.byEntityId, record.entity_id, record);

      const areaId = this.resolveAreaId(record, nameIndex);
      if (!areaId) {
        this.unmappedCount += 1;
        return;
      }

      ArvidHealth.pushTo(this.byAreaId, areaId, record);
    });

    if (this.unmappedCount) {
      ARVID_LOG.debug(this.logArea, "Записи health без помещения", this.unmappedCount);
    }
  }

  static pushTo(map, key, value) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }

  static summarize(records) {
    let offline = 0;
    let anomaly = 0;

    records.forEach((record) => {
      if (record.severity === "offline") offline += 1;
      else anomaly += 1;
    });

    return { offline, anomaly, total: records.length, records };
  }

  /** Сводка по помещению: сколько устройств не на связи и сколько с аномалией. */
  statsForArea(areaId) {
    return ArvidHealth.summarize(this.byAreaId.get(areaId) || []);
  }

  /** Сводка по устройству HA (пара движение+люкс — одно устройство, две записи). */
  statsForDevice(deviceId) {
    return ArvidHealth.summarize(this.byDeviceId.get(deviceId) || []);
  }

  /** Сводка по конкретной сущности. */
  statsForEntity(entityId) {
    return ArvidHealth.summarize(this.byEntityId.get(entityId) || []);
  }

  /** Все ошибки помещений этажа (для сводки/предупреждений). */
  statsForAreas(areaIds) {
    let offline = 0;
    let anomaly = 0;
    const rooms = [];

    areaIds.forEach((areaId) => {
      const stats = this.statsForArea(areaId);
      if (!stats.total) return;
      offline += stats.offline;
      anomaly += stats.anomaly;
      rooms.push({ areaId, ...stats });
    });

    return { offline, anomaly, rooms };
  }

  /**
   * Ниже — только фолбэк-режим (старое ядро). В push-режиме таймеров нет.
   * При скрытой вкладке таймер останавливаем, при возврате берём свежий снимок.
   */
  startPolling(intervalMs) {
    if (this.mode !== "poll" || this.available === false) return;

    this._intervalMs = intervalMs;
    this.bindVisibility();

    this.stopTimer();
    if (document.visibilityState === "hidden") return;

    this._timer = window.setInterval(() => this.refresh(), this._intervalMs);
  }

  stopTimer() {
    if (this._timer) {
      window.clearInterval(this._timer);
      this._timer = null;
    }
  }

  stopPolling() {
    this.stopTimer();
  }

  bindVisibility() {
    if (this._visibilityBound) return;
    this._visibilityBound = true;

    document.addEventListener("visibilitychange", () => {
      if (this.mode !== "poll") return;

      if (document.visibilityState === "hidden") {
        this.stopTimer();
        return;
      }

      this.refresh();
      this.startPolling(this._intervalMs);
    });
  }
}

window.ArvidHealth = ArvidHealth;
