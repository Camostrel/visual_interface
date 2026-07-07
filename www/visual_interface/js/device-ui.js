/**
 * Вспомогательные функции для отображения сущностей Home Assistant.
 * Скоуп visual_interface: свет (light.*), движение/освещённость (sensor.*),
 * кнопочные и поворотные панели (event.*). Другие типы устройств не поддерживаем.
 */
class ArvidDeviceUi {
  static domain(entityId) {
    return entityId.split(".")[0];
  }

  static friendlyName(state) {
    return state?.attributes?.friendly_name || state?.entity_id || "Устройство";
  }

  /**
   * Проверяем, является ли сущность датчиком движения.
   * В этом проекте датчики движения могут быть именно sensor.*, а не только binary_sensor.*.
   */
  static isMotion(state) {
    const entityId = state?.entity_id || "";
    const domain = ArvidDeviceUi.domain(entityId);
    const deviceClass = state?.attributes?.device_class;
    const lowerId = entityId.toLowerCase();
    const lowerName = String(state?.attributes?.friendly_name || "").toLowerCase();

    if (domain === "sensor") {
      if (["motion", "occupancy", "presence"].includes(deviceClass)) return true;
      return (
        lowerId.includes("motion")
        || lowerId.includes("occupancy")
        || lowerId.includes("presence")
        || lowerId.includes("dvizhen")
        || lowerId.includes("движ")
        || lowerName.includes("motion")
        || lowerName.includes("occupancy")
        || lowerName.includes("движ")
      );
    }

    // Оставляем совместимость, если часть объектов всё же будет binary_sensor.*.
    if (domain === "binary_sensor") {
      return ["motion", "occupancy", "presence"].includes(deviceClass);
    }

    return false;
  }

  /**
   * Состояния движения по текущей договорённости:
   * активно: motion, occupancy;
   * неактивно: no_motion, vacant.
   */
  static isMotionActive(state) {
    const value = String(state?.state || "").trim().toLowerCase();
    if (["motion", "occupancy"].includes(value)) return true;
    if (["no_motion", "vacant"].includes(value)) return false;

    // Дополнительная совместимость с возможными HA-состояниями.
    if (["on", "detected", "occupied", "presence", "present", "1", "true"].includes(value)) return true;
    return false;
  }

  static isIlluminance(state) {
    return state?.entity_id?.startsWith("sensor.") && state?.attributes?.device_class === "illuminance";
  }

  /**
   * Кнопочные и поворотные панели приходят как event.* (DaliPanelEvent):
   * состояние — время последнего события, атрибуты — event_type и key_no.
   */
  static isPanelEvent(state) {
    return ArvidDeviceUi.domain(state?.entity_id || "") === "event";
  }

  /**
   * Человекочитаемое описание последнего события панели.
   */
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

  static markerKind(state) {
    const domain = ArvidDeviceUi.domain(state.entity_id);
    if (domain === "light") return "light";
    if (ArvidDeviceUi.isPanelEvent(state)) return "panel";
    if (ArvidDeviceUi.isMotion(state)) return "motion";
    if (ArvidDeviceUi.isIlluminance(state)) return "illuminance";
    return domain;
  }

  static iconText(kind) {
    const icons = {
      light: "💡",
      motion: "◌",
      illuminance: "☀",
      panel: "▦",
      sensor: "S",
      binary_sensor: "B",
    };
    return icons[kind] || "•";
  }

  static iconAssetUrl(kind) {
    // Полный комплект иконок скоупа в едином стиле (панель-градиент + гравировка).
    const icons = {
      light: "assets/icons/light.svg",
      motion: "assets/icons/motion.svg",
      illuminance: "assets/icons/illuminance.svg",
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
   * Единая активность для визуальной подсветки маркеров.
   * Для датчиков движения используем специальные состояния проекта,
   * для остальных устройств — стандартные HA-состояния.
   */
  static isActive(state) {
    if (!state) return false;
    if (ArvidDeviceUi.isMotion(state)) return ArvidDeviceUi.isMotionActive(state);
    return ArvidDeviceUi.isOn(state);
  }

  static isReadableSensor(state) {
    return ArvidDeviceUi.isMotion(state) || ArvidDeviceUi.isIlluminance(state);
  }
}

window.ArvidDeviceUi = ArvidDeviceUi;
