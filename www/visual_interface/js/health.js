/**
 * Клиент здоровья устройств — данные берём у ядра DALI, свою логику не изобретаем.
 *
 * Источник: WS-команда `arvid_dali_center/health_data` (read-only, без require_admin).
 * Ядро само следит за устройствами (подписки на связь + периодический оценщик) и отдаёт
 * снимок активных ошибок. Мы только раскладываем их по помещениям и красим зоны.
 *
 * ВАЖНО про поведение ядра (docs ядра HEALTH.md, health/evaluator.py):
 *  - Ответ не опрашивает шину DALI: читаются состояния сущностей HA + снимок устройств в RAM.
 *  - «Плохое» состояние попадает в active только если держится дольше грейса
 *    (grace = interval_min, по умолчанию 5 минут) — защита от транзиентов при рестарте.
 *    Поэтому опрашивать чаще, чем раз в минуту, бессмысленно: раньше грейса ошибки не будет.
 *  - Push-канала для здоровья нет (`events_subscribe` — про события устройств), только снимок.
 *
 * Записи active: {key, kind, kindLabel, name, devType, gw_sn, area, floor, since}.
 * `area` — это ИМЯ помещения, а не area_id (ядро кладёт area.name). Зоны плана живут
 * по area_id, поэтому резолвим имя → id через реестр HA. Когда ядро начнёт отдавать
 * `area_id`, код подхватит его без правок (см. resolveAreaId), а фолбэк по имени останется.
 */
class ArvidHealth {
  constructor(ha, registry) {
    this.ha = ha;
    this.registry = registry;
    this.logArea = "health";

    // null — ещё не спрашивали; false — ядра нет (интеграция не установлена/команда не та).
    this.available = null;
    this.active = [];
    this.byAreaId = new Map();   // area_id → [запись, …]
    this.gatewayIssues = [];     // gw_offline — к помещению не привязан
    this.unmappedCount = 0;      // записи, чью область не удалось сопоставить
    this.lastFetchAt = null;

    this._inflight = null;
    this._timer = null;
    this._intervalMs = ArvidHealth.IDLE_INTERVAL_MS;
    this._onUpdate = null;
    this._visibilityBound = false;
  }

  /** Фоновый интервал: совпадает с периодом оценщика ядра (interval_min = 5 мин). */
  static get IDLE_INTERVAL_MS() {
    return 300000;
  }

  /** В режиме «Диагностика»: ошибки появляются не быстрее грейса, но исчезают сразу после починки. */
  static get ACTIVE_INTERVAL_MS() {
    return 30000;
  }

  /**
   * Классификация видов ошибок ядра:
   *   offline — устройство не на связи / без состояния (красный пульс на карте);
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

  /** Кого звать после каждого снимка (успешного или отключившего модуль). */
  setUpdateHandler(handler) {
    this._onUpdate = handler;
  }

  /**
   * Снимок здоровья. Ошибки не бросаем: интерфейс должен жить и без ядра DALI
   * (тогда режим «Диагностика» показывает «нет данных», остальные режимы работают).
   */
  async refresh() {
    if (this._inflight) return this._inflight;
    if (this.available === false) return null;

    this._inflight = this.ha.send({ type: "arvid_dali_center/health_data" })
      .then((result) => {
        this.available = true;
        this.lastFetchAt = Date.now();
        this.indexActive(result?.active || []);

        ARVID_LOG.debug(this.logArea, "Health snapshot loaded", {
          active: this.active.length,
          rooms: this.byAreaId.size,
          gateways: this.gatewayIssues.length,
          unmapped: this.unmappedCount,
        });

        if (this._onUpdate) this._onUpdate(this);
        return this;
      })
      .catch((error) => {
        // Различаем «команды не существует» и «сейчас не дозвонились».
        // unknown_command — ядра DALI нет: выключаем модуль совсем, чтобы не долбить WS.
        // Обрыв соединения / not_found (стор ещё не поднят) — временно: снимок оставляем,
        // поллинг продолжается и подхватит данные, когда ядро ответит.
        if (error?.code === "unknown_command") {
          this.available = false;
          this.stopPolling();
          this.active = [];
          this.byAreaId.clear();
          this.gatewayIssues = [];

          ARVID_LOG.warn(this.logArea, "Ядро arvid_dali_center не отвечает на health_data — Диагностика без данных", error);
          if (this._onUpdate) this._onUpdate(this);
          return null;
        }

        ARVID_LOG.warn(this.logArea, "Снимок health не получен, повторим по таймеру", error);
        return null;
      })
      .finally(() => {
        this._inflight = null;
      });

    return this._inflight;
  }

  /**
   * Карта «имя помещения → area_id». Строим на каждый снимок: помещения могли
   * переименовать. Дубли имён исключаем — сопоставить их однозначно нельзя.
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

  /** area_id записи: из ядра напрямую, если оно его отдаёт; иначе — резолв по имени. */
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
    this.gatewayIssues = [];
    this.unmappedCount = 0;

    this.active.forEach((record) => {
      if (record.severity === "gateway") {
        this.gatewayIssues.push(record);
        return;
      }

      const areaId = this.resolveAreaId(record, nameIndex);
      if (!areaId) {
        this.unmappedCount += 1;
        return;
      }

      if (!this.byAreaId.has(areaId)) this.byAreaId.set(areaId, []);
      this.byAreaId.get(areaId).push(record);
    });

    if (this.unmappedCount) {
      ARVID_LOG.debug(this.logArea, "Записи health без помещения", this.unmappedCount);
    }
  }

  /** Сводка по помещению: сколько устройств не на связи и сколько с аномалией. */
  statsForArea(areaId) {
    const records = this.byAreaId.get(areaId) || [];
    let offline = 0;
    let anomaly = 0;

    records.forEach((record) => {
      if (record.severity === "offline") offline += 1;
      else anomaly += 1;
    });

    return { offline, anomaly, total: records.length, records };
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
   * Поллинг снимка. Частота зависит от режима карты: в «Диагностике» чаще.
   * При скрытой вкладке таймер останавливаем (браузер его всё равно душит),
   * при возврате — сразу берём свежий снимок.
   */
  startPolling(intervalMs) {
    if (this.available === false) return;

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
