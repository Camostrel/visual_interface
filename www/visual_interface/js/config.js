/**
 * ARVID Visual Interface frontend config.
 *
 * - frontend path is detected automatically from this file location;
 * - legacy /local/web_interface asset links are rewritten to the current path;
 * - missing user SVG plans can fall back to bundled default SVGs.
 */
(function initArvidConfig() {
  // Единственный источник версии. Деплой правит ЭТУ строку (и такую же метку ?v= в index.html).
  const APP_VERSION = "v0.13.9";

  const scriptUrl = document.currentScript?.src || new URL("js/config.js", window.location.href).href;
  const scriptPath = new URL(scriptUrl, window.location.href).pathname;

  // Example:
  // /local/NickSha/visual_interface/js/config.js -> /local/NickSha/visual_interface
  const detectedLocalBasePath = scriptPath.replace(/\/js\/config\.js$/, "");

  // Leave empty for auto-detect. Set manually only if the page is served in a non-standard way.
  const manualLocalBasePath = "";
  const localBasePath = (manualLocalBasePath || detectedLocalBasePath).replace(/\/$/, "");

  /**
   * Разбиватель кеша (v0.11.3). HA отдаёт /local/ с `Cache-Control: max-age=2678400` (31 день),
   * поэтому браузер держит старые JS/CSS/SVG месяц. Меняем URL при каждом деплое (?v=версия) —
   * для браузера это новый файл, тянет свежий. В пределах версии кеш работает (быстро), при
   * смене версии — обновляется. Планы больше НЕ грузятся с force-cache (см. svg-utils.js).
   */
  function withVersion(url) {
    if (!url || /[?&]v=/.test(url)) return url;   // не двоим метку
    return `${url}${url.includes("?") ? "&" : "?"}v=${APP_VERSION}`;
  }

  function localAsset(relativePath) {
    return withVersion(`${localBasePath}/${String(relativePath).replace(/^\/+/, "")}`);
  }

  function resolveAssetUrl(value, fallbackRelativePath) {
    const fallbackUrl = localAsset(fallbackRelativePath);

    if (!value) return fallbackUrl;

    // Compatibility with v0.1 defaults if they were already saved in HA storage.
    if (typeof value === "string" && value.startsWith("/local/web_interface/")) {
      return withVersion(value.replace("/local/web_interface", localBasePath));
    }

    // Allow storage values like "assets/floors/1_etazh.svg".
    if (typeof value === "string" && !value.startsWith("/") && !value.startsWith("http")) {
      return localAsset(value);
    }

    // Абсолютный локальный путь из стора — тоже версионируем; внешние http(s) не трогаем.
    if (typeof value === "string" && value.startsWith("/")) return withVersion(value);

    return value;
  }

  window.ARVID_CONFIG = {
    VERSION: APP_VERSION,

    // If empty, current browser origin is used, for example http://homeassistant.local:8123
    HA_BASE_URL: "",

    // Insert your Home Assistant long-lived access token here.
    HA_TOKEN: "PASTE_LONG_LIVED_ACCESS_TOKEN_HERE",

    // Detected public folder, for example /local/NickSha/visual_interface
    LOCAL_BASE_PATH: localBasePath,

    // Default local paths. They can be overridden by layout from HA storage.
    DEFAULT_FLOOR_SVG: localAsset("assets/floors/default-floor.svg"),
    DEFAULT_ROOM_SVG: localAsset("assets/rooms/default-room.svg"),
    DEFAULT_LOGO: localAsset("assets/logo/arvid-logo.svg"),

    localAsset,
    resolveAssetUrl,

    // Logging: debug | info | warn | error
    // На объекте — "warn": уровень debug логировал КАЖДОЕ событие HA (включая поток люксов)
    // в самом горячем пути. Для отладки поднимается без правки файла:
    //   localStorage.setItem("arvid.logLevel", "debug")
    LOG_LEVEL: "warn",
  };
})();
