const shaders = require('../../utils/shaders.js');
const { createRenderer } = require('../../utils/lut-renderer.js');
const { loadCanvasImage, preparePhoto } = require('../../utils/photo.js');
const Adjustments = require('../../utils/adjust.js');
const Effects = require('../../utils/effects.js');
const ui = require('../../utils/ui-state.js');
const thumbnails = require('../../utils/thumbnail.js');
const appInfo = require('../../utils/app-info.js');

const DEFAULT_ADJUSTMENTS = ui.ADJUSTMENT_DEFAULTS;
// The spatial effects are approximate. They are on by default at their
// physical-ish level; see docs/EFFECTS.md for the measured differences.
const APP_EFFECT_DEFAULTS = Object.freeze({ grain: 1, halation: 1, vignette: 0 });

Page({
  data: {
    ready: false,
    hasPhoto: false,
    busy: false,
    busyText: '',
    error: '',
    phase: ui.PHASES.EMPTY,
    categories: [],
    selectedStock: '',
    selectedStockName: '',
    adjustOpen: true,
    postOpen: false,
    effectsOpen: true,
    aboutOpen: false,
    comparing: false,
    extendedLoading: false,
    canvasStyle: 'width: 1px; height: 1px;',
    adjustments: {
      ev: 0,
      temperature: 0,
      tint: 0,
      intensity: 1,
      contrast: 0,
      saturation: 1,
    },
    readouts: {
      ev: '0.0 EV',
      temperature: '0',
      tint: '0',
      intensity: '100%',
      contrast: '0.00',
      saturation: '100%',
    },
    effects: {
      grain: 1,
      halation: 1,
      vignette: 0,
    },
    effectReadouts: {
      grain: '100%',
      halation: '100%',
      vignette: '0%',
    },
    resetEnabled: false,
    version: appInfo.version,
    sourceUrl: appInfo.sourceUrl,
  },

  onLoad() {
    this.canvas = null;
    this.renderer = null;
    this.lutManifest = null;
    this.lutCache = Object.create(null);
    this.operationId = 0;
    this.stockRequestId = 0;
    this.photoSize = null;
    this.photoId = 0;
    this.adjustments = Object.assign({}, DEFAULT_ADJUSTMENTS);
    this.effects = Effects.normalize(APP_EFFECT_DEFAULTS);
    this.comparing = false;
    this.activeStock = null;
    this.thumbs = Object.create(null);
    this.thumbQueue = [];
    this.thumbRunning = false;
    this.thumbTimer = null;
    this.readoutTimer = null;
    this.lastReadoutAt = 0;
    this.extendedPromise = null;
    this.observer = null;
    this.visibleStockIds = Object.create(null);
    try {
      const system = wx.getSystemInfoSync();
      this.devicePixelRatio = system.pixelRatio || 1;
    } catch (error) {
      this.devicePixelRatio = 1;
    }
  },

  onReady() {
    this.initialiseRenderer();
  },

  onResize() {
    if (this.photoSize) {
      this.fitCanvas(this.photoSize.width, this.photoSize.height);
    }
  },

  onUnload() {
    this.operationId += 1;
    this.stockRequestId += 1;
    this.clearTimers();
    if (this.observer && this.observer.disconnect) {
      try {
        this.observer.disconnect();
      } catch (error) {
        // The observer is already gone; nothing to clean up.
      }
      this.observer = null;
    }
    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }
    Object.keys(this.lutCache).forEach((key) => {
      const entry = this.lutCache[key];
      if (entry && entry.base) {
        entry.base.src = '';
      }
      if (entry && entry.extended) {
        entry.extended.src = '';
      }
    });
    this.lutCache = Object.create(null);
  },

  clearTimers() {
    if (this.thumbTimer) {
      clearTimeout(this.thumbTimer);
      this.thumbTimer = null;
    }
    if (this.readoutTimer) {
      clearTimeout(this.readoutTimer);
      this.readoutTimer = null;
    }
  },

  initialiseRenderer() {
    wx.createSelectorQuery()
      .select('#previewCanvas')
      .fields({ node: true, size: true })
      .exec((result) => {
        try {
          if (!result || !result[0] || !result[0].node) {
            throw new Error('Preview canvas node was not found');
          }
          this.canvas = result[0].node;
          this.renderer = createRenderer(this.canvas, {
            vertexSource: shaders.lutVertex,
            fragmentSource: shaders.lutFragment,
            haloFragmentSource: shaders.haloFragment,
          });
          this.renderer.resize(1, 1);
          this.renderer.setEffects(this.effects);
          this.setData({ ready: true, error: '' });
        } catch (error) {
          if (error.code === 'WEBGL_UNAVAILABLE') {
            try {
              require('../../renderer/fallback2d.js').createFallback2D(this.canvas);
            } catch (fallbackError) {
              this.showError('此设备无法创建 WebGL 预览；Canvas 2D 回退尚未实现。');
            }
          } else {
            this.showError(`WebGL 初始化失败：${error.message}`);
          }
        }
      });
  },

  // --- phase machine -------------------------------------------------------

  transition(event) {
    let phase = this.data.phase;
    try {
      phase = ui.nextPhase(phase, event);
    } catch (error) {
      phase = this.data.phase;
    }
    this.setData({
      phase,
      busy: ui.isBusyPhase(phase),
      busyText: ui.phaseText(phase),
    });
  },

  // --- photo picking -------------------------------------------------------

  chooseMedia(sourceType) {
    return new Promise((resolve, reject) => {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: [sourceType],
        sizeType: ['compressed', 'original'],
        success: resolve,
        fail: reject,
      });
    });
  },

  async onChoosePhoto(event) {
    if (!this.data.ready || this.data.busy) {
      return;
    }
    const sourceType = event.currentTarget.dataset.source === 'camera' ? 'camera' : 'album';
    this.setData({ error: '' });
    try {
      const result = await this.chooseMedia(sourceType);
      const file = result.tempFiles && result.tempFiles[0];
      if (!file || !file.tempFilePath) {
        const error = new Error('No image returned');
        error.code = 'DECODE_FAILED';
        throw error;
      }
      if (file.fileType && file.fileType !== 'image') {
        const error = new Error('Selected media is not an image');
        error.code = 'UNSUPPORTED_TYPE';
        throw error;
      }
      await this.loadPhoto(file.tempFilePath);
    } catch (error) {
      if (/cancel/i.test(String((error && (error.errMsg || error.message)) || ''))) {
        this.setData({ error: '已取消选择。' });
        return;
      }
      this.showError(this.describeError(error));
    }
  },

  async loadPhoto(src) {
    const operation = ++this.operationId;
    this.stockRequestId += 1;
    this.transition('pick');
    this.setData({ error: '', comparing: false });
    this.comparing = false;
    try {
      const prepared = await preparePhoto({
        canvas: this.canvas,
        src,
        devicePixelRatio: this.devicePixelRatio,
        maxTextureSize: this.renderer.maxTextureSize,
      });
      if (operation !== this.operationId) {
        return;
      }
      this.photoSize = { width: prepared.width, height: prepared.height };
      await new Promise((resolve) => {
        this.setData({ hasPhoto: true }, resolve);
      });
      if (operation !== this.operationId) {
        return;
      }
      await this.fitCanvas(prepared.width, prepared.height);
      if (operation !== this.operationId) {
        return;
      }
      this.renderer.resize(prepared.width, prepared.height);
      this.renderer.setPhoto(prepared.canvas);
      this.renderer.render(0);

      this.transition('decoded');
      const stocks = await this.ensureLuts();
      if (operation !== this.operationId) {
        return;
      }
      if (!stocks.length) {
        throw new Error('LUT manifest is empty');
      }
      this.photoId += 1;
      this.resetThumbnails();
      this.setData({ categories: ui.groupStocks(stocks) });
      await this.activateStock(stocks[0].id, operation);
      if (operation !== this.operationId) {
        return;
      }
      this.transition('luts-ready');
      this.startThumbnails();
    } catch (error) {
      if (operation === this.operationId) {
        this.transition('failed');
        this.showError(this.describeError(error));
      }
    } finally {
      if (operation === this.operationId) {
        this.setData({ busy: false, busyText: '' });
      }
    }
  },

  ensureLuts() {
    if (this.lutManifest) {
      return Promise.resolve(this.lutManifest);
    }
    return new Promise((resolve, reject) => {
      wx.loadSubpackage({
        name: 'luts',
        success: () => {
          try {
            const manifest = require('../../subpackages/luts/luts.json');
            if (!Array.isArray(manifest)) {
              throw new Error('Invalid LUT manifest');
            }
            this.lutManifest = manifest;
            resolve(manifest);
          } catch (error) {
            reject(error);
          }
        },
        fail: reject,
      });
    });
  },

  /**
   * Load and cache the LUT images of one stock. The base cube is always
   * needed; the extended (two-stop headroom) cube is only fetched when the
   * current adjustments actually require it, and it is cached afterwards.
   */
  async getLutImage(stock, options) {
    const needExtended = !!(options && options.needExtended);
    let entry = this.lutCache[stock.id];
    if (!entry) {
      const base = await loadCanvasImage(this.canvas, `/subpackages/luts/${stock.file}`);
      entry = { base, extended: null, extendedPromise: null };
      this.lutCache[stock.id] = entry;
    }
    if (needExtended && stock.extended && !entry.extended) {
      if (!entry.extendedPromise) {
        entry.extendedPromise = loadCanvasImage(
          this.canvas, `/subpackages/luts/${stock.extended.file}`
        ).then((image) => {
          entry.extended = image;
          entry.extendedPromise = null;
          return image;
        }).catch((error) => {
          entry.extendedPromise = null;
          throw error;
        });
      }
      await entry.extendedPromise;
    }
    return entry;
  },

  async activateStock(id, operation) {
    const request = ++this.stockRequestId;
    const stocks = await this.ensureLuts();
    const stock = stocks.find((item) => item.id === id);
    if (!stock) {
      throw new Error(`Unknown stock: ${id}`);
    }
    const needExtended = ui.needsExtendedLut(this.adjustments);
    const images = await this.getLutImage(stock, { needExtended });
    if (operation !== this.operationId || request !== this.stockRequestId) {
      return;
    }
    this.renderer.setLut(images.base, stock, images.extended);
    this.activeStock = stock;
    this.setData({ selectedStock: stock.id, selectedStockName: stock.name });
    this.renderPreview();
  },

  async onStockTap(event) {
    if (!this.data.hasPhoto) {
      return;
    }
    const operation = this.operationId;
    try {
      await this.activateStock(event.currentTarget.dataset.id, operation);
    } catch (error) {
      if (operation === this.operationId) {
        this.showError('胶片 LUT 加载失败，请检查网络后重试。');
      }
    }
  },

  // --- adjustments ---------------------------------------------------------

  onAdjustChanging(event) {
    this.applyAdjustment(event.currentTarget.dataset.key, event.detail.value, false);
  },

  onAdjustChange(event) {
    this.applyAdjustment(event.currentTarget.dataset.key, event.detail.value, true);
  },

  applyAdjustment(key, rawValue, commit) {
    let next = null;
    try {
      next = ui.applyAdjustment(this.adjustments, key, rawValue);
    } catch (error) {
      return;
    }
    this.adjustments = next;
    if (this.renderer) {
      this.renderer.setAdjustments(next);
    }
    this.renderPreview();
    if (commit) {
      this.setData({ adjustments: Object.assign({}, next) });
      this.flushReadouts();
    } else {
      this.scheduleReadouts();
    }
  },

  // The single reset restores every adjustment and every spatial effect to
  // the shipped defaults. It does not touch the photo or the selected stock.
  onResetAdjustments() {
    this.adjustments = ui.resetAdjustments();
    this.effects = Effects.normalize(APP_EFFECT_DEFAULTS);
    if (this.renderer) {
      this.renderer.setAdjustments(this.adjustments);
      this.renderer.setEffects(this.effects);
    }
    this.renderPreview();
    this.setData({
      adjustments: Object.assign({}, this.adjustments),
      effects: Object.assign({}, this.effects),
    });
    this.flushReadouts();
  },

  // --- spatial effects -----------------------------------------------------

  onEffectChanging(event) {
    this.applyEffect(event.currentTarget.dataset.key, event.detail.value, false);
  },

  onEffectChange(event) {
    this.applyEffect(event.currentTarget.dataset.key, event.detail.value, true);
  },

  applyEffect(key, rawValue, commit) {
    let next = null;
    try {
      next = Effects.merge(this.effects, { [key]: rawValue });
    } catch (error) {
      return;
    }
    this.effects = next;
    if (this.renderer) {
      this.renderer.setEffects(next);
    }
    this.renderPreview();
    if (commit) {
      this.setData({ effects: Object.assign({}, next) });
      this.flushReadouts();
    } else {
      this.scheduleReadouts();
    }
  },

  // The global reset restores the adjustments and the spatial effects.
  onResetEffects() {
    this.effects = Effects.normalize(APP_EFFECT_DEFAULTS);
    if (this.renderer) {
      this.renderer.setEffects(this.effects);
    }
    this.renderPreview();
    this.setData({ effects: Object.assign({}, this.effects) });
    this.flushReadouts();
  },

  isResetState() {
    return ui.isDefaultState(this.adjustments) && Effects.EFFECT_KEYS.every(
      (key) => Number(this.effects[key]) === Number(APP_EFFECT_DEFAULTS[key])
    );
  },

  scheduleReadouts() {
    const now = Date.now();
    if (ui.shouldEmit(now, this.lastReadoutAt, ui.READOUT_INTERVAL_MS)) {
      this.flushReadouts();
      return;
    }
    if (this.readoutTimer) {
      return;
    }
    const delay = Math.max(16, ui.READOUT_INTERVAL_MS - (now - this.lastReadoutAt));
    this.readoutTimer = setTimeout(() => {
      this.readoutTimer = null;
      this.flushReadouts();
    }, delay);
  },

  flushReadouts() {
    this.lastReadoutAt = Date.now();
    this.setData({
      readouts: ui.readouts(this.adjustments),
      effectReadouts: Effects.readouts(this.effects),
      resetEnabled: !this.isResetState(),
    });
  },

  renderPreview() {
    if (!this.renderer || !this.data.hasPhoto) {
      return;
    }
    const intensity = this.comparing ? 0 : this.adjustments.intensity;
    if (ui.needsExtendedLut(this.adjustments) &&
      this.activeStock && this.activeStock.extended &&
      !this.renderer.hasExtendedLut()) {
      // The extended cube is still being fetched; the preview is redrawn as
      // soon as it is resident.
      this.ensureActiveExtended();
      return;
    }
    try {
      this.renderer.render(intensity);
    } catch (error) {
      this.showError(error.message);
    }
  },

  ensureActiveExtended() {
    if (this.extendedPromise) {
      return this.extendedPromise;
    }
    const stock = this.activeStock;
    if (!stock || !stock.extended) {
      return Promise.resolve(null);
    }
    this.setData({ extendedLoading: true });
    this.extendedPromise = this.getLutImage(stock, { needExtended: true })
      .then((images) => {
        if (this.activeStock === stock && images.extended) {
          this.renderer.setExtendedLut(images.extended, stock.extended);
        }
        return images;
      })
      .catch((error) => {
        this.showError('扩展 LUT 加载失败，请重试。');
        return null;
      })
      .then((images) => {
        this.extendedPromise = null;
        this.setData({ extendedLoading: false });
        if (images && images.extended) {
          this.renderPreview();
        }
        return images;
      });
    return this.extendedPromise;
  },

  // --- press and hold compare ---------------------------------------------

  onPreviewTouchStart() {
    if (!this.data.hasPhoto || !this.renderer) {
      return;
    }
    this.comparing = true;
    this.setData({ comparing: true });
    if (this.renderer) {
      this.renderer.render(0);
    }
  },

  onPreviewTouchEnd() {
    if (!this.comparing) {
      return;
    }
    this.comparing = false;
    this.setData({ comparing: false });
    if (this.renderer) {
      this.renderer.render(this.adjustments.intensity);
    }
  },

  onPreviewTouchCancel() {
    this.onPreviewTouchEnd();
  },

  // --- preset thumbnails ---------------------------------------------------

  resetThumbnails() {
    this.thumbQueue = [];
    this.thumbRunning = false;
    this.thumbs = Object.create(null);
    this.visibleStockIds = Object.create(null);
    if (this.thumbTimer) {
      clearTimeout(this.thumbTimer);
      this.thumbTimer = null;
    }
    if (this.observer && this.observer.disconnect) {
      try {
        this.observer.disconnect();
      } catch (error) {
        // Nothing to clean up.
      }
      this.observer = null;
    }
  },

  startThumbnails() {
    if (!this.lutManifest || !this.photoSize || !this.renderer) {
      return;
    }
    const ids = this.lutManifest.map((stock) => stock.id);
    const visible = Object.keys(this.visibleStockIds);
    const order = ui.thumbnailOrder(ids, this.data.selectedStock, visible);
    this.thumbQueue = order
      .filter((id) => !this.thumbs[id])
      .map((id) => ({ id }));
    this.pumpThumbnails();
    this.observeThumbnails();
  },

  pumpThumbnails() {
    if (this.thumbRunning || !this.thumbQueue.length) {
      return;
    }
    const item = this.thumbQueue.shift();
    this.thumbRunning = true;
    const operation = this.operationId;
    this.generateThumbnail(item.id, operation)
      .catch(() => null)
      .then(() => {
        this.thumbRunning = false;
        if (operation !== this.operationId) {
          return;
        }
        if (this.thumbQueue.length) {
          this.thumbTimer = setTimeout(() => {
            this.thumbTimer = null;
            this.pumpThumbnails();
          }, 32);
        }
      });
  },

  async generateThumbnail(stockId, operation) {
    const stock = this.lutManifest.find((item) => item.id === stockId);
    if (!stock || !this.photoSize || !this.renderer) {
      return;
    }
    // Only the base cube is needed: thumbnails are rendered with the default
    // (identity) adjustments.
    const images = await this.getLutImage(stock);
    if (operation !== this.operationId) {
      return;
    }
    const size = ui.thumbnailSize(this.photoSize.width, this.photoSize.height);
    this.renderer.setLut(images.base, stock, images.extended);
    const result = this.renderer.renderToPixels({
      width: size.width,
      height: size.height,
      intensity: 1,
      adjustments: Adjustments.DEFAULTS,
      // The preset thumbnails never include the spatial effects.
      effects: Effects.EFFECT_DEFAULTS,
    });
    await this.restoreActiveLut(operation);
    if (operation !== this.operationId) {
      return;
    }
    const exported = await thumbnails.exportPixels({
      pixels: result.pixels,
      width: size.width,
      height: size.height,
      fileName: `thumb-${stockId}`,
    });
    if (operation !== this.operationId) {
      return;
    }
    this.setThumbnail(stockId, exported ? exported.src : '');
  },

  async restoreActiveLut(operation) {
    const stock = this.activeStock;
    if (!stock || !this.renderer) {
      return;
    }
    const images = await this.getLutImage(stock, {
      needExtended: ui.needsExtendedLut(this.adjustments),
    });
    if (operation !== this.operationId) {
      return;
    }
    this.renderer.setLut(images.base, stock, images.extended);
    this.renderer.render(this.comparing ? 0 : this.adjustments.intensity);
  },

  setThumbnail(stockId, src) {
    const location = this.findStockLocation(stockId);
    if (!location) {
      return;
    }
    const thumb = {
      status: src ? 'ready' : 'failed',
      src: src || '',
      color: ui.placeholderColor(stockId),
    };
    this.thumbs[stockId] = thumb;
    this.setData({
      [`categories[${location.category}].stocks[${location.stock}].thumb`]: thumb,
    });
  },

  findStockLocation(stockId) {
    const categories = this.data.categories || [];
    for (let category = 0; category < categories.length; category += 1) {
      const stocks = categories[category].stocks || [];
      for (let stock = 0; stock < stocks.length; stock += 1) {
        if (stocks[stock].id === stockId) {
          return { category, stock };
        }
      }
    }
    return null;
  },

  observeThumbnails() {
    if (typeof wx.createIntersectionObserver !== 'function') {
      return;
    }
    try {
      if (this.observer && this.observer.disconnect) {
        this.observer.disconnect();
      }
      this.observer = wx.createIntersectionObserver({
        thresholds: [0, 0.01],
        observeAll: true,
      });
      this.observer.relativeToViewport({ bottom: 240 }).observe('.stock-card', (result) => {
        if (!result || !result.id) {
          return;
        }
        this.prioritiseThumbnail(String(result.id).replace(/^stock-/, ''));
      });
    } catch (error) {
      this.observer = null;
    }
  },

  prioritiseThumbnail(stockId) {
    if (!stockId || this.thumbs[stockId]) {
      return;
    }
    this.visibleStockIds[stockId] = true;
    const index = this.thumbQueue.findIndex((item) => item.id === stockId);
    if (index > 0) {
      const item = this.thumbQueue.splice(index, 1)[0];
      this.thumbQueue.unshift(item);
    }
  },

  // --- panel toggles and about --------------------------------------------

  onToggleAdjustments() {
    this.setData({ adjustOpen: !this.data.adjustOpen });
  },

  onTogglePost() {
    this.setData({ postOpen: !this.data.postOpen });
  },

  onToggleEffects() {
    this.setData({ effectsOpen: !this.data.effectsOpen });
  },

  onToggleAbout() {
    this.setData({ aboutOpen: !this.data.aboutOpen });
  },

  onCopySourceUrl() {
    wx.setClipboardData({
      data: this.data.sourceUrl,
      success: () => {
        wx.showToast({ title: '链接已复制', icon: 'none' });
      },
      fail: () => {
        wx.showToast({ title: '复制失败，请手动记录', icon: 'none' });
      },
    });
  },

  // --- misc ----------------------------------------------------------------

  onClearPhoto() {
    this.operationId += 1;
    this.stockRequestId += 1;
    this.photoSize = null;
    this.activeStock = null;
    this.comparing = false;
    this.resetThumbnails();
    if (this.renderer) {
      this.renderer.clearPhoto();
      this.renderer.resize(1, 1);
    }
    this.transition('clear');
    this.setData({
      hasPhoto: false,
      busy: false,
      busyText: '',
      error: '',
      selectedStock: '',
      selectedStockName: '',
      comparing: false,
      canvasStyle: 'width: 1px; height: 1px;',
      categories: [],
    });
  },

  fitCanvas(width, height) {
    return new Promise((resolve) => {
      wx.createSelectorQuery()
        .select('#previewStage')
        .boundingClientRect()
        .exec((result) => {
          const rect = result && result[0];
          if (rect && rect.width && rect.height) {
            const scale = Math.min(rect.width / width, rect.height / height);
            this.setData({
              canvasStyle: `width: ${(width * scale).toFixed(3)}px; height: ${(height * scale).toFixed(3)}px;`,
            });
          }
          resolve();
        });
    });
  },

  describeError(error) {
    const message = String((error && (error.errMsg || error.message)) || '');
    if (/cancel/i.test(message)) {
      return '已取消选择。';
    }
    if (/auth|deny|permission|authorize/i.test(message)) {
      return '无法访问照片或相机，请在设置中允许相应权限。';
    }
    if (error && error.code === 'UNSUPPORTED_TYPE') {
      return '不支持此照片格式，请选择 JPG 或 PNG。';
    }
    if (/loadSubpackage/i.test(message)) {
      return '胶片资源下载失败，请检查网络后重试。';
    }
    if ((error && error.code === 'DECODE_FAILED') || /getImageInfo|decode/i.test(message)) {
      return '照片解码失败，请尝试另一张 JPG 或 PNG。';
    }
    return '处理照片失败，请重试。';
  },

  showError(message) {
    this.setData({ error: message, busy: false, busyText: '', comparing: false });
    this.comparing = false;
  },
});
