/**
 * ARVID Visual Interface frontend config.
 *
 * - frontend path is detected automatically from this file location;
 * - legacy /local/web_interface asset links are rewritten to the current path;
 * - missing user SVG plans can fall back to bundled default SVGs.
 */
(function initArvidConfig() {
  const scriptUrl = document.currentScript?.src || new URL("js/config.js", window.location.href).href;
  const scriptPath = new URL(scriptUrl, window.location.href).pathname;

  // Example:
  // /local/NickSha/visual_interface/js/config.js -> /local/NickSha/visual_interface
  const detectedLocalBasePath = scriptPath.replace(/\/js\/config\.js$/, "");

  // Leave empty for auto-detect. Set manually only if the page is served in a non-standard way.
  const manualLocalBasePath = "";
  const localBasePath = (manualLocalBasePath || detectedLocalBasePath).replace(/\/$/, "");

  function localAsset(relativePath) {
    return `${localBasePath}/${String(relativePath).replace(/^\/+/, "")}`;
  }

  function resolveAssetUrl(value, fallbackRelativePath) {
    const fallbackUrl = localAsset(fallbackRelativePath);

    if (!value) return fallbackUrl;

    // Compatibility with v0.1 defaults if they were already saved in HA storage.
    if (typeof value === "string" && value.startsWith("/local/web_interface/")) {
      return value.replace("/local/web_interface", localBasePath);
    }

    // Allow storage values like "assets/floors/1_etazh.svg".
    if (typeof value === "string" && !value.startsWith("/") && !value.startsWith("http")) {
      return localAsset(value);
    }

    return value;
  }

  window.ARVID_CONFIG = {
    VERSION: "v0.8.0",

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
    LOG_LEVEL: "debug",
  };
})();
