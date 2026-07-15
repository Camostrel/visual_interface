/**
 * Утилиты SVG.
 * Важное правило проекта: координаты храним в системе viewBox SVG,
 * а не в пикселях экрана. Это защищает план от смещений на разных экранах.
 */
class ArvidSvgUtils {
  static async loadSvgInto(container, svgUrl, options = {}) {
    const fallbackUrl = options.fallbackUrl || null;
    const isFallbackAttempt = Boolean(options.isFallbackAttempt);

    ARVID_LOG.info("svg", "Loading SVG", {
      svgUrl,
      fallbackUrl,
      isFallbackAttempt,
    });

    container.innerHTML = "<div class='arvid-loading'>Загрузка плана...</div>";

    try {
      const text = await ArvidSvgUtils.fetchSvgText(svgUrl);
      container.innerHTML = text;

      const svg = container.querySelector("svg");
      if (!svg) throw new Error("Loaded file does not contain <svg>");

      svg.classList.add("arvid-svg-plan");
      ARVID_LOG.info("svg", "SVG loaded successfully", {
        svgUrl,
        viewBox: svg.getAttribute("viewBox"),
      });
      return svg;
    } catch (error) {
      ARVID_LOG.error("svg", "Failed to load SVG", { svgUrl, error });

      if (fallbackUrl && fallbackUrl !== svgUrl && !isFallbackAttempt) {
        ARVID_LOG.warn("svg", "Trying fallback SVG", {
          failedSvgUrl: svgUrl,
          fallbackUrl,
        });
        return ArvidSvgUtils.loadSvgInto(container, fallbackUrl, {
          isFallbackAttempt: true,
        });
      }

      container.innerHTML = `
        <div class='arvid-error'>
          <strong>Не удалось загрузить SVG-план</strong>
          <span>${svgUrl}</span>
          <small>Проверь путь к файлу или укажи SVG в layout.</small>
        </div>
      `;
      throw error;
    }
  }


  static async fetchSvgText(svgUrl) {
    // v0.11.3: убран force-cache — именно он держал план старым (браузер брал из кеша без
    // ревалидации). Свежесть теперь обеспечивает ?v=версия в URL (config.localAsset): сменилась
    // версия — сменился URL — план перезагрузится. В пределах версии работает HTTP-кэш браузера.
    const response = await fetch(svgUrl);
    if (!response.ok) throw new Error(`SVG HTTP ${response.status}`);
    return response.text();
  }

  static clientPointToSvg(svg, clientX, clientY) {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;

    const matrix = svg.getScreenCTM();
    if (!matrix) {
      ARVID_LOG.error("svg", "getScreenCTM returned null");
      return null;
    }

    const svgPoint = point.matrixTransform(matrix.inverse());
    return { x: svgPoint.x, y: svgPoint.y };
  }

  static createSvgElement(tagName, attrs = {}) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tagName);
    Object.entries(attrs).forEach(([key, value]) => {
      el.setAttribute(key, String(value));
    });
    return el;
  }

  static ensureOverlayLayer(svg, layerId = "arvid-overlay-layer") {
    let layer = svg.querySelector(`#${layerId}`);
    if (!layer) {
      layer = ArvidSvgUtils.createSvgElement("g", { id: layerId });
      svg.appendChild(layer);
      ARVID_LOG.debug("svg", "Created overlay layer", layerId);
    }
    return layer;
  }

  static clearLayer(layer) {
    while (layer.firstChild) layer.removeChild(layer.firstChild);
  }


  static getViewBoxMetrics(svg) {
    if (!svg) return null;

    const rawViewBox = svg.getAttribute("viewBox");
    if (rawViewBox) {
      const parts = rawViewBox.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every((value) => Number.isFinite(value))) {
        return {
          x: parts[0],
          y: parts[1],
          width: parts[2],
          height: parts[3],
          ratio: parts[2] ? parts[3] / parts[2] : 1,
        };
      }
    }

    const width = Number(svg.getAttribute("width")) || svg.clientWidth || 1;
    const height = Number(svg.getAttribute("height")) || svg.clientHeight || 1;
    return {
      x: 0,
      y: 0,
      width,
      height,
      ratio: width ? height / width : 1,
    };
  }

  static setupPanZoom(container, svg, options = {}) {
    if (!container || !svg) {
      ARVID_LOG.warn("svg-panzoom", "Pan/zoom setup skipped: container or svg is missing");
      return null;
    }

    if (container._arvidPanZoom) {
      container._arvidPanZoom.destroy();
    }

    const controller = new ArvidSvgPanZoom(container, svg, options);
    container._arvidPanZoom = controller;
    controller.init();
    return controller;
  }
}

/**
 * Нативное управление планом без внешних библиотек.
 * Поддерживает колесо мыши, перетаскивание, кнопки +/- и pinch двумя пальцами.
 */
class ArvidSvgPanZoom {
  constructor(container, svg, options = {}) {
    this.container = container;
    this.svg = svg;
    this.logArea = options.logArea || "svg-panzoom";
    this.maxZoom = options.maxZoom || 18;
    this.minZoom = options.minZoom || 0.45;
    this.zoomStep = options.zoomStep || 1.22;
    this.abortController = new AbortController();
    this.activePointers = new Map();
    this.lastPointerPoint = null;
    this.lastPinchDistance = null;
    // Тап или перетаскивание: сбрасывается на нажатии, взводится при сдвиге дальше порога.
    this.tapStart = null;
    this.gestureMoved = false;
    // Колбэк смены масштаба: по нему план этажа показывает устройства при зуме (Фаза 3.5).
    // Зовётся только при изменении масштаба, не при панорамировании.
    this.onZoom = typeof options.onZoom === "function" ? options.onZoom : null;
    this.baseViewBox = this.readInitialViewBox();
    this.currentViewBox = { ...this.baseViewBox };
  }

  init() {
    this.applyViewBox();
    this.bindPointerEvents();
    this.bindWheel();
    this.bindToolbar();
    this.updateZoomLabel();
    ARVID_LOG.info(this.logArea, "Pan/zoom initialized", {
      baseViewBox: this.baseViewBox,
      maxZoom: this.maxZoom,
      minZoom: this.minZoom,
    });
  }

  destroy() {
    this.abortController.abort();
    this.container.classList.remove("is-pan-active");
    ARVID_LOG.debug(this.logArea, "Pan/zoom destroyed");
  }

  readInitialViewBox() {
    const rawViewBox = this.svg.getAttribute("viewBox");
    if (rawViewBox) {
      const parts = rawViewBox.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every((value) => Number.isFinite(value))) {
        return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
      }
    }

    // Если SVG пришёл без viewBox, создаём его из размеров элемента.
    const fallbackWidth = Number(this.svg.getAttribute("width")) || this.container.clientWidth || 1000;
    const fallbackHeight = Number(this.svg.getAttribute("height")) || this.container.clientHeight || 700;
    const fallback = { x: 0, y: 0, width: fallbackWidth, height: fallbackHeight };
    this.svg.setAttribute("viewBox", `${fallback.x} ${fallback.y} ${fallback.width} ${fallback.height}`);
    ARVID_LOG.warn(this.logArea, "SVG had no valid viewBox, fallback viewBox created", fallback);
    return fallback;
  }

  bindPointerEvents() {
    const signal = this.abortController.signal;

    this.svg.addEventListener("pointerdown", (event) => this.onPointerDown(event), { signal });
    window.addEventListener("pointermove", (event) => this.onPointerMove(event), { signal });
    window.addEventListener("pointerup", (event) => this.onPointerUp(event), { signal });
    window.addEventListener("pointercancel", (event) => this.onPointerUp(event), { signal });

    // Различение «тап vs перетаскивание» (v0.11.1). Раньше pan НЕ запускался, если палец попал
    // на зону или маркер — а зоны на объекте покрывают почти весь план, и перетащить его было
    // нельзя. Теперь pan запускается всегда, а «случайный» клик по зоне/лампе ПОСЛЕ перетаскивания
    // гасим здесь: если жест сдвинулся дальше порога, это была панорама, а не тап.
    this.container.addEventListener("click", (event) => {
      if (!this.gestureMoved) return;
      event.stopPropagation();
      event.preventDefault();
    }, { capture: true, signal });
  }

  bindWheel() {
    this.container.addEventListener("wheel", (event) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? this.zoomStep : 1 / this.zoomStep;
      this.zoomAt(factor, event.clientX, event.clientY);
    }, { passive: false, signal: this.abortController.signal });
  }

  bindToolbar() {
    const viewRoot = this.container.closest("[data-spa-view]") || document;
    const root = this.container.closest(".workspace, .room-plan-area, .room-layout, .main-panel") || viewRoot;
    // В SPA на странице есть несколько наборов кнопок масштаба.
    // Поэтому сначала ищем кнопки внутри текущего view, а не во всём document.
    const zoomIn = root.querySelector("[data-plan-zoom-in]") || viewRoot.querySelector("[data-plan-zoom-in]");
    const zoomOut = root.querySelector("[data-plan-zoom-out]") || viewRoot.querySelector("[data-plan-zoom-out]");
    const reset = root.querySelector("[data-plan-reset]") || viewRoot.querySelector("[data-plan-reset]");

    zoomIn?.addEventListener("click", () => this.zoomAt(this.zoomStep), { signal: this.abortController.signal });
    zoomOut?.addEventListener("click", () => this.zoomAt(1 / this.zoomStep), { signal: this.abortController.signal });
    reset?.addEventListener("click", () => this.reset(), { signal: this.abortController.signal });
  }

  onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;

    // Панораму больше НЕ блокируем по цели (зона/маркер): иначе план, покрытый зонами, не
    // перетащить. Маркеры расстановки сами гасят pan через stopPropagation в своём pointerdown;
    // зоны и лампы плана становятся и тапабельными, и «перетаскиваемыми» — различаем по сдвигу.
    // Захват указателя (setPointerCapture) убран: pan слушает window, а захват мог перенаправить
    // последующий click мимо зоны, сломав тап по помещению.
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.lastPointerPoint = { x: event.clientX, y: event.clientY };

    if (this.activePointers.size === 1) {
      this.tapStart = { x: event.clientX, y: event.clientY };
      this.gestureMoved = false;
    }

    if (this.activePointers.size === 2) {
      this.lastPinchDistance = this.getPointerDistance();
      this.gestureMoved = true;   // два пальца — заведомо жест (зум), а не тап
    }

    this.container.classList.add("is-pan-active");
  }

  onPointerMove(event) {
    if (!this.activePointers.has(event.pointerId)) return;

    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.activePointers.size >= 2) {
      this.handlePinchZoom();
      return;
    }

    if (!this.lastPointerPoint) return;

    // Ушли дальше порога от точки нажатия — это перетаскивание, а не тап (порог 8px, как везде).
    if (this.tapStart
        && (Math.abs(event.clientX - this.tapStart.x) > 8 || Math.abs(event.clientY - this.tapStart.y) > 8)) {
      this.gestureMoved = true;
    }

    const dx = event.clientX - this.lastPointerPoint.x;
    const dy = event.clientY - this.lastPointerPoint.y;
    this.panByScreenDelta(dx, dy);
    this.lastPointerPoint = { x: event.clientX, y: event.clientY };
  }

  onPointerUp(event) {
    this.activePointers.delete(event.pointerId);
    this.lastPinchDistance = null;

    if (this.activePointers.size === 1) {
      const onlyPointer = Array.from(this.activePointers.values())[0];
      this.lastPointerPoint = { ...onlyPointer };
    } else {
      this.lastPointerPoint = null;
      this.container.classList.remove("is-pan-active");
    }
  }

  handlePinchZoom() {
    const distance = this.getPointerDistance();
    if (!distance || !this.lastPinchDistance) {
      this.lastPinchDistance = distance;
      return;
    }

    const center = this.getPointerCenter();
    const factor = distance / this.lastPinchDistance;
    this.zoomAt(factor, center.x, center.y);
    this.lastPinchDistance = distance;
  }

  getPointerDistance() {
    const points = Array.from(this.activePointers.values());
    if (points.length < 2) return null;
    const [a, b] = points;
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  getPointerCenter() {
    const points = Array.from(this.activePointers.values());
    const [a, b] = points;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  panByScreenDelta(dx, dy) {
    const rect = this.svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    // Сдвиг экрана переводим в сдвиг viewBox, чтобы панорамирование не зависело от масштаба окна.
    this.currentViewBox.x -= dx * (this.currentViewBox.width / rect.width);
    this.currentViewBox.y -= dy * (this.currentViewBox.height / rect.height);
    this.applyViewBox();
  }

  zoomAt(factor, clientX = null, clientY = null) {
    const currentZoom = this.getZoomValue();
    const targetZoom = this.clamp(currentZoom * factor, this.minZoom, this.maxZoom);
    const normalizedFactor = targetZoom / currentZoom;
    if (!Number.isFinite(normalizedFactor) || normalizedFactor <= 0) return;

    const anchor = clientX !== null && clientY !== null
      ? ArvidSvgUtils.clientPointToSvg(this.svg, clientX, clientY)
      : this.getViewBoxCenter();

    if (!anchor) return;

    const newWidth = this.currentViewBox.width / normalizedFactor;
    const newHeight = this.currentViewBox.height / normalizedFactor;
    const anchorRatioX = (anchor.x - this.currentViewBox.x) / this.currentViewBox.width;
    const anchorRatioY = (anchor.y - this.currentViewBox.y) / this.currentViewBox.height;

    this.currentViewBox = {
      x: anchor.x - newWidth * anchorRatioX,
      y: anchor.y - newHeight * anchorRatioY,
      width: newWidth,
      height: newHeight,
    };

    this.applyViewBox();
    this.updateZoomLabel();
  }

  reset() {
    this.currentViewBox = { ...this.baseViewBox };
    this.applyViewBox();
    this.updateZoomLabel();
    ARVID_LOG.info(this.logArea, "Plan zoom reset");
  }

  applyViewBox() {
    const box = this.currentViewBox;
    this.svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
  }

  getViewBoxCenter() {
    return {
      x: this.currentViewBox.x + this.currentViewBox.width / 2,
      y: this.currentViewBox.y + this.currentViewBox.height / 2,
    };
  }

  getZoomValue() {
    return this.baseViewBox.width / this.currentViewBox.width;
  }

  updateZoomLabel() {
    const viewRoot = this.container.closest("[data-spa-view]") || document;
    const root = this.container.closest(".workspace, .room-plan-area, .room-layout, .main-panel") || viewRoot;
    const label = root.querySelector("[data-plan-zoom-value]") || viewRoot.querySelector("[data-plan-zoom-value]");
    if (label) label.textContent = `${Math.round(this.getZoomValue() * 100)}%`;

    // Единая точка «масштаб изменился»: сюда сходятся колесо, кнопки, pinch и сброс.
    if (this.onZoom) this.onZoom(this.getZoomValue());
  }

  clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
}

window.ArvidSvgUtils = ArvidSvgUtils;
window.ArvidSvgPanZoom = ArvidSvgPanZoom;
