/**
 * Small frontend logger.
 * Keeps logs readable and allows us to quickly locate failure points.
 */
(function initLogger() {
  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

  function getConfiguredLevel() {
    const fromStorage = localStorage.getItem("arvid.logLevel");
    const fromConfig = window.ARVID_CONFIG?.LOG_LEVEL;
    return fromStorage || fromConfig || "info";
  }

  function shouldLog(level) {
    const activeLevel = getConfiguredLevel();
    return LEVELS[level] >= (LEVELS[activeLevel] || LEVELS.info);
  }

  function write(level, area, message, details) {
    if (!shouldLog(level)) return;

    const prefix = `[ARVID][${area}] ${message}`;
    const payload = details === undefined ? "" : details;

    if (level === "error") console.error(prefix, payload);
    else if (level === "warn") console.warn(prefix, payload);
    else if (level === "info") console.info(prefix, payload);
    else console.debug(prefix, payload);
  }

  window.ARVID_LOG = {
    debug: (area, message, details) => write("debug", area, message, details),
    info: (area, message, details) => write("info", area, message, details),
    warn: (area, message, details) => write("warn", area, message, details),
    error: (area, message, details) => write("error", area, message, details),
  };
})();
