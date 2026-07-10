/**
 * Вспомогательные функции для отображения сущностей Home Assistant.
 * Скоуп visual_interface: свет (light.), датчик движения+освещённости (sensor.ms_ и sensor.il_),
 * кнопочные и поворотные панели (event.).
 *
 * Нейминг DALI (см. WEB_INTERFACE_API.md): движение = sensor.ms_, освещённость = sensor.il_.
 * Пара ms_/il_ — это ОДНО физическое устройство (общий device_id в HA), поэтому на плане
 * и в списках это одна «точка-датчик» (kind = "sensor") с двумя показаниями.
 */
class ArvidDeviceUi {
  static domain(entityId) {
    return entityId.split(".")[0];
  }

  // Часть entity_id после домена: "sensor.ms_hir23_w" -> "ms_hir23_w".
  static objectId(entityId) {
    return (entityId || "").split(".")[1] || "";
  }

  static friendlyName(state) {
    return state?.attributes?.friendly_name || state?.entity_id || "Устройство";
  }

  /**
   * Датчик движения. У DALI-датчиков device_class часто пустой,
   * поэтому основной признак — префикс объекта `ms_` (нейминг ядра).
   */
  static isMotion(state) {
    const entityId = state?.entity_id || "";
    const domain = ArvidDeviceUi.domain(entityId);
    const objectId = ArvidDeviceUi.objectId(entityId).toLowerCase();
    const deviceClass = state?.attributes?.device_class;
    const lowerName = String(state?.attributes?.friendly_name || "").toLowerCase();

    if (domain === "sensor") {
      if (objectId.startsWith("ms_")) return true;
      if (["motion", "occupancy", "presence"].includes(deviceClass)) return true;
      return (
        objectId.includes("motion")
        || objectId.includes("occupancy")
        || objectId.includes("presence")
        || objectId.includes("dvizhen")
        || objectId.includes("движ")
        || lowerName.includes("motion")
        || lowerName.includes("движ")
      );
    }

    // Совместимость, если часть датчиков всё же придёт как binary_sensor.*.
    if (domain === "binary_sensor") {
      return ["motion", "occupancy", "presence"].includes(deviceClass);
    }

    return false;
  }

  /**
   * Состояния движения по договорённости ядра:
   * активно: motion, occupancy; неактивно: no_motion, vacant.
   */
  static isMotionActive(state) {
    const value = String(state?.state || "").trim().toLowerCase();
    if (["motion", "occupancy"].includes(value)) return true;
    if (["no_motion", "vacant"].includes(value)) return false;

    // Совместимость с возможными HA-состояниями.
    if (["on", "detected", "occupied", "presence", "present", "1", "true"].includes(value)) return true;
    return false;
  }

  /**
   * Датчик освещённости. Признак — device_class=illuminance или префикс объекта `il_`.
   */
  static isIlluminance(state) {
    const entityId = state?.entity_id || "";
    if (!entityId.startsWith("sensor.")) return false;
    return state?.attributes?.device_class === "illuminance"
      || ArvidDeviceUi.objectId(entityId).toLowerCase().startsWith("il_");
  }

  /** Любая из двух сущностей единого датчика (движение или освещённость). */
  static isSensor(state) {
    return ArvidDeviceUi.isMotion(state) || ArvidDeviceUi.isIlluminance(state);
  }

  /**
   * Кнопочные и поворотные панели приходят как event.* (DaliPanelEvent):
   * состояние — время последнего события, атрибуты — event_type и key_no.
   */
  static isPanelEvent(state) {
    return ArvidDeviceUi.domain(state?.entity_id || "") === "event";
  }

  /** Человекочитаемое описание последнего события панели. */
  static panelEventText(state) {
    const eventType = state?.attributes?.event_type;
    if (!eventType) return "событий не было";

    const types = {
      click: "клик",
      double: "двойной клик",
      hold: "удержание",
      hold_end: "конец удержания",
      rotate: "поворот",
    };
    const typeText = types[eventType] || eventType;
    const keyNo = state?.attributes?.key_no;
    return keyNo !== undefined && keyNo !== null ? `${typeText} · кнопка ${keyNo}` : typeText;
  }

  /**
   * Тип точки на плане. Датчик движения+освещённости — единый тип "sensor".
   */
  static markerKind(state) {
    const domain = ArvidDeviceUi.domain(state.entity_id);
    if (domain === "light") return "light";
    if (ArvidDeviceUi.isPanelEvent(state)) return "panel";
    if (ArvidDeviceUi.isSensor(state)) return "sensor";
    return domain;
  }

  /** Сущность входит в скоуп интерфейса (свет / датчик / панель). */
  static isScoped(state) {
    return ["light", "sensor", "panel"].includes(ArvidDeviceUi.markerKind(state));
  }

  static iconText(kind) {
    const icons = {
      light: "💡",
      sensor: "◌",
      panel: "▦",
    };
    return icons[kind] || "•";
  }

  static iconAssetUrl(kind) {
    // Единый комплект иконок скоупа (панель-градиент + гравировка).
    // Датчик (движение+освещённость) — одна иконка-радар.
    const icons = {
      light: "assets/icons/light.svg",
      sensor: "assets/icons/motion.svg",
      panel: "assets/icons/panel.svg",
    };
    const relativePath = icons[kind];
    if (!relativePath || !window.ARVID_CONFIG?.localAsset) return null;
    return window.ARVID_CONFIG.localAsset(relativePath);
  }

  static isOn(state) {
    return state?.state === "on";
  }

  /**
   * Активность для подсветки маркеров.
   * Для датчика — активность движения, для остального — стандартное «включено».
   */
  static isActive(state) {
    if (!state) return false;
    if (ArvidDeviceUi.isMotion(state)) return ArvidDeviceUi.isMotionActive(state);
    return ArvidDeviceUi.isOn(state);
  }

  static isReadableSensor(state) {
    return ArvidDeviceUi.isSensor(state);
  }
}

window.ArvidDeviceUi = ArvidDeviceUi;
