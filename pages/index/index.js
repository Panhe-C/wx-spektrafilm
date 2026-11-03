const shaders = require('../../utils/shaders.js');
const { createRenderer } = require('../../utils/lut-renderer.js');
const {
  getImageInfo,
  loadCanvasImage,
  preparePhoto,
  runOrientedSelfTest,
} = require('../../utils/photo.js');
const Adjustments = require('../../utils/adjust.js');
const Effects = require('../../utils/effects.js');
const ui = require('../../utils/ui-state.js');
const thumbnails = require('../../utils/thumbnail.js');
const appInfo = require('../../utils/app-info.js');
const { createExportHost } = require('../../utils/export-wechat.js');
const Export = require('../../utils/export.js');
const Privacy = require('../../utils/privacy.js');
const StepLog = require('../../utils/step-log.js');
const Diagnostics = require('../../utils/diagnostics.js');

const DEFAULT_ADJUSTMENTS = ui.ADJUSTMENT_DEFAULTS;
// The spatial effects are approximate. They are on by default at their
// physical-ish level; see docs/EFFECTS.md for the measured differences.
const APP_EFFECT_DEFAULTS = Object.freeze({ grain: 1, halation: 1, vignette: 0 });

const WARM_COLOR = '#d6b98a';
const WARM_BLOCK = '#f2dfc0';
const COOL_COLOR = '#8fb0d6';
const COOL_BLOCK = '#cfe0f5';

// The slider definitions of the bottom sheet. The ranges come from the pure
// UI modules, so the sheet can never disagree with the clamping policy.
function buildSliders(limits, steps, specs) {
  return specs.map((spec) => ({
    key: spec.key,
    label: spec.label,
    min: limits[spec.key][0],
    max: limits[spec.key][1],
    step: steps[spec.key],
    color: spec.post ? COOL_COLOR : WARM_COLOR,
    blockColor: spec.post ? COOL_BLOCK : WARM_BLOCK,
    groupTitle: spec.groupTitle || '',
  }));
}

const ADJUST_SLIDERS = buildSliders(ui.ADJUSTMENT_LIMITS, ui.ADJUSTMENT_STEPS, [
  { key: 'ev', label: '曝光 EV' },
  { key: 'temperature', label: '色温' },
  { key: 'tint', label: '色调' },
  { key: 'intensity', label: '强度' },
  { key: 'contrast', label: '对比度', post: true, groupTitle: '后期微调（非胶片物理）' },
  { key: 'saturation', label: '饱和度', post: true },
]);

const EFFECT_SLIDERS = buildSliders(Effects.EFFECT_LIMITS, Effects.EFFECT_STEPS, [
  { key: 'grain', label: '颗粒' },
  { key: 'halation', label: '光晕' },
  { key: 'vignette', label: '暗角', post: true },
]);

const TOOLBAR_GLYPHS = { film: '◧', adjust: '◐', effects: '✦' };
const TOOLBAR_TABS = [ui.TABS.FILM, ui.TABS.ADJUST, ui.TABS.EFFECTS].map((key) => ({
  key,
  label: ui.TAB_LABELS[key],
  glyph: TOOLBAR_GLYPHS[key],
}));

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
    tabs: TOOLBAR_TABS,
    adjustSliders: ADJUST_SLIDERS,
    effectSliders: EFFECT_SLIDERS,
    panel: ui.PANELS.NONE,
    activeTab: ui.TABS.FILM,
    sheetTitle: '',
    sheetResetEnabled: false,
    aboutOpen: false,
    comparing: false,
    extendedLoading: false,
    canvasStyle: 'width: 100%; height: 100%;',
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
    exporting: false,
    exportText: '',
    exportProgress: 0,
    exportStatus: ui.EXPORT_STATUS.IDLE,
    exportError: '',
    exportCanRetry: false,
    exportCanOpenSetting: false,
    privacyVisible: false,
    privacyTitle: '隐私保护指引',
    privacyBody: '',
    privacyNote: '',
    privacyName: '',
    version: appInfo.version,
    sourceUrl: appInfo.sourceUrl,
    diagnosticsOpen: false,
    diagnosticsRunning: false,
    diagnosticsText: '',
    diagnosticsAvailable: false,
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
    this.photoSrc = '';
    this.exporting = false;
    this.exportCancel = null;
    // The export pipeline and the host factory are seams, so that the page
    // wiring can be unit-tested with a mock host.
    this.exportRunner = Export.exportImage;
    this.exportHostFactory = createExportHost;
    this.exportSteps = StepLog.createStepLog();
    this.exportAuthSetting = null;
    // The privacy guard is installed as early as possible (app.js onLaunch)
    // and the page renders its popup.
    this.privacyGuard = Privacy.getPrivacyGuard();
    this.privacyGuard.install();
    this.privacyGuard.attach({
      onChange: (view) => this.applyPrivacyView(view),
    });
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
    this.diagnosticsRunning = false;
    this.photoSourceInfo = { type: 'none' };
    this.lastThumbnailGeometry = null;
    this.previewScheduled = false;
    this.previewFrames = 0;
    this.previewTimer = null;
    this.canvasNodeSize = null;
    this.canvasRect = null;
    this.stageRect = null;
    this.lastBufferGeometry = null;
    this.insetRequestId = 0;
    this.sheetCoverage = 0;
    try {
      const system = wx.getSystemInfoSync();
      this.devicePixelRatio = system.pixelRatio || 1;
      this.sdkVersion = system.SDKVersion || '';
    } catch (error) {
      this.devicePixelRatio = 1;
      this.sdkVersion = '';
    }
    this.enableShareMenu();
  },

  // The share entries are only reachable when the platform menu offers them.
  enableShareMenu() {
    if (typeof wx.showShareMenu !== 'function') {
      return;
    }
    try {
      wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    } catch (error) {
      // Older base libraries do not know the menus option; the default menu
      // (shareAppMessage) still works.
      try {
        wx.showShareMenu();
      } catch (fallbackError) {
        // Nothing else to do: the share entries are optional.
      }
    }
  },

  onShareAppMessage() {
    return {
      title: '胶片模拟：基于 spektrafilm 物理流程的照片调色',
      path: '/pages/index/index',
    };
  },

  onShareTimeline() {
    return {
      title: '胶片模拟：基于 spektrafilm 物理流程的照片调色',
      query: '',
    };
  },

  onReady() {
    this.initialiseRenderer();
  },

  onResize() {
    // Re-query both native canvas and stage on rotation/resizing; never infer
    // the surface from the photo's dimensions.
    this.fitCanvas().then(() => this.schedulePreviewRender(true));
  },

  onUnload() {
    this.operationId += 1;
    this.stockRequestId += 1;
    this.clearTimers();
    if (this.privacyGuard) {
      this.privacyGuard.detach();
    }
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
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.previewScheduled = false;
    this.previewFrames = 0;
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
          this.canvasNodeSize = {
            width: Number(result[0].width) || 1,
            height: Number(result[0].height) || 1,
          };
          this.renderer = createRenderer(this.canvas, {
            vertexSource: shaders.lutVertex,
            fragmentSource: shaders.lutFragment,
            haloFragmentSource: shaders.haloFragment,
          });
          // The native node always fills the stage. Its buffer is based only
          // on stage CSS geometry × DPR and actual GL implementation limits.
          this.renderer.resizeToCssSize(
            this.canvasNodeSize.width,
            this.canvasNodeSize.height,
            this.devicePixelRatio
          );
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
    // 'original' keeps the picked file untouched: a compressed copy would
    // change the decoded pixels and the aspect the user sees.
    const sizeType = ['original'];
    this.chooseMediaSizeType = sizeType;
    return new Promise((resolve, reject) => {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: [sourceType],
        sizeType,
        success: resolve,
        fail: reject,
      });
    });
  },

  describeChosenFile(file) {
    const path = String((file && file.tempFilePath) || '');
    const name = path.split('/').pop() || '';
    const originalPath = String(
      (file && (file.originalTempFilePath || file.originalPath)) || ''
    );
    return {
      fileName: name,
      extension: name.indexOf('.') === -1 ? '' : name.split('.').pop().toLowerCase(),
      sizeBytes: file && Number.isFinite(Number(file.size)) ? Number(file.size) : null,
      fileType: (file && file.fileType) || '',
      pickerWidth: file && Number.isFinite(Number(file.width)) ? Number(file.width) : null,
      pickerHeight: file && Number.isFinite(Number(file.height)) ? Number(file.height) : null,
      hasThumbTempFilePath: !!(file && file.thumbTempFilePath),
      originalPathPresent: originalPath.length > 0,
      sizeType: (this.chooseMediaSizeType || []).join(','),
    };
  },

  async onChoosePhoto(event) {
    if (!this.data.ready || this.data.busy) {
      return;
    }
    const sourceType = event.currentTarget.dataset.source === 'camera' ? 'camera' : 'album';
    this.setData({ error: '' });
    try {
      // The photo picker is a privacy scoped interface («选中的照片或视频信息»
      // and, for the camera, «访问你的摄像头»): the consent is asked before
      // the picker opens. If the user refuses, the import is aborted with a
      // clear message — it never hangs.
      const consent = await this.requestPrivacyConsent('pick');
      if (!consent.granted) {
        this.setData({ error: consent.message });
        return;
      }
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
      const mediaInfo = this.describeChosenFile(file);
      if (mediaInfo.originalPathPresent) {
        const originalPath = file.originalTempFilePath || file.originalPath;
        try {
          const originalInfo = await getImageInfo(originalPath);
          mediaInfo.originalInfo = {
            width: Number(originalInfo.width) || null,
            height: Number(originalInfo.height) || null,
            orientation: originalInfo.orientation === undefined
              ? null : originalInfo.orientation,
            type: originalInfo.type || '',
          };
        } catch (error) {
          mediaInfo.originalInfoError = String((error && error.errMsg) || error.message || error);
        }
      }
      await this.loadPhoto(file.tempFilePath, mediaInfo);
    } catch (error) {
      if (/cancel/i.test(String((error && (error.errMsg || error.message)) || ''))) {
        this.setData({ error: '已取消选择。' });
        return;
      }
      this.showError(this.describeError(error));
    }
  },

  async loadPhoto(src, mediaInfo) {
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
        prepared.release();
        return;
      }
      this.photoSize = { width: prepared.width, height: prepared.height };
      this.photoSrc = src;
      // Content-level check: does the decode canvas hold the WHOLE image?
      // It must run while the original Image is still alive.
      let wholeImageCheck = null;
      try {
        wholeImageCheck = prepared.checkWholeImage();
      } catch (error) {
        wholeImageCheck = {
          available: false,
          error: String((error && error.errMsg) || error.message || error),
        };
        console.error('[wx-spektrafilm][diag][geometry] whole-image check failed', error);
      }
      this.photoSourceInfo = {
        type: 'offscreen-2d-canvas',
        decodedType: 'canvas.createImage-onload',
        chooseMedia: mediaInfo || null,
        width: prepared.width,
        height: prepared.height,
        sourceWidth: prepared.sourceWidth,
        sourceHeight: prepared.sourceHeight,
        infoWidth: prepared.infoWidth,
        infoHeight: prepared.infoHeight,
        infoOrientation: prepared.infoOrientation === undefined
          ? null : prepared.infoOrientation,
        infoType: prepared.infoType || '',
        decodeCanvasWidth: prepared.decodeCanvasWidth,
        decodeCanvasHeight: prepared.decodeCanvasHeight,
        orientation: prepared.orientation,
        engineApplied: prepared.engineApplied,
        decisionRow: prepared.decisionRow,
        decisionReason: prepared.decisionReason,
        decisionMode: prepared.decisionMode,
        transformOrientation: prepared.transformOrientation,
        ambiguousDecision: prepared.ambiguousDecision,
        draw: prepared.drawInfo,
        scaleX: prepared.scaleX,
        scaleY: prepared.scaleY,
        relativeAspectError: prepared.relativeAspectError,
        bytesPerPixel: mediaInfo && mediaInfo.sizeBytes && prepared.sourceWidth
          ? mediaInfo.sizeBytes / (prepared.sourceWidth * prepared.sourceHeight)
          : null,
        wholeImageCheck,
      };
      await new Promise((resolve) => {
        this.setData({ hasPhoto: true }, resolve);
      });
      if (operation !== this.operationId) {
        prepared.release();
        return;
      }
      await this.fitCanvas();
      if (operation !== this.operationId) {
        prepared.release();
        return;
      }
      // The stage-sized native surface was already settled by fitCanvas().
      // Upload the photo without changing canvas.width/height.
      let photoUpload;
      try {
        photoUpload = this.renderer.setPhoto(
          prepared.canvas, this.photoSourceInfo, prepared.retryDecode
        );
      } finally {
        prepared.release();
      }
      Object.assign(this.photoSourceInfo, {
        uploadStrategy: photoUpload.strategy,
        cpuDecodeSuspect: photoUpload.cpuDecodeSuspect,
        photoAllBlack: photoUpload.photoAllBlack,
        decodeRetried: photoUpload.decodeRetried,
      });
      // The texture, the decode canvas and the prepared size must agree, and
      // the texture aspect must match the prepared aspect.
      const textureState = typeof this.renderer.getDiagnostics === 'function'
        ? (this.renderer.getDiagnostics().textures || [])
          .find((texture) => texture.name === 'photo')
        : null;
      const textureWidth = textureState ? textureState.width : null;
      const textureHeight = textureState ? textureState.height : null;
      const preparedAspect = prepared.width / prepared.height;
      const textureAspect = textureWidth && textureHeight
        ? textureWidth / textureHeight : null;
      const aspectRelativeError = textureAspect === null
        ? null
        : Math.abs(textureAspect - preparedAspect) / preparedAspect;
      const dimensionsMatch = textureWidth === null
        ? null
        : textureWidth === prepared.width && textureHeight === prepared.height &&
          prepared.decodeCanvasWidth === prepared.width &&
          prepared.decodeCanvasHeight === prepared.height;
      const geometryCheck = {
        preparedWidth: prepared.width,
        preparedHeight: prepared.height,
        decodeCanvasWidth: prepared.decodeCanvasWidth,
        decodeCanvasHeight: prepared.decodeCanvasHeight,
        textureWidth,
        textureHeight,
        dimensionsMatch,
        preparedAspect,
        textureAspect,
        aspectRelativeError,
        aspectConsistent: aspectRelativeError === null ? null : aspectRelativeError < 0.01,
      };
      this.photoSourceInfo.geometryCheck = geometryCheck;
      if (dimensionsMatch === false || geometryCheck.aspectConsistent === false) {
        console.error(
          '[wx-spektrafilm][diag][geometry] decode/texture geometry mismatch',
          geometryCheck
        );
      }
      if (photoUpload.photoAllBlack) {
        this.setData({ error: '照片读取为全黑，可在 关于 → 诊断 查看' });
      }
      this.schedulePreviewRender(true);

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
    try {
      const manifest = require('../../subpackages/luts/luts.js');
      if (!Array.isArray(manifest)) {
        throw new Error('Invalid LUT manifest');
      }
      this.lutManifest = manifest;
      return Promise.resolve(manifest);
    } catch (error) {
      return Promise.reject(error);
    }
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

  // The effect panel's own reset restores the three effect sliders.
  onResetEffects() {
    this.effects = Effects.normalize(APP_EFFECT_DEFAULTS);
    if (this.renderer) {
      this.renderer.setEffects(this.effects);
    }
    this.renderPreview();
    this.setData({ effects: Object.assign({}, this.effects) });
    this.flushReadouts();
  },

  // The reset of the open bottom sheet: it only restores the controls that
  // the sheet shows.
  onSheetReset() {
    if (this.data.panel === ui.PANELS.EFFECTS) {
      this.onResetEffects();
      return;
    }
    this.adjustments = ui.resetAdjustments();
    if (this.renderer) {
      this.renderer.setAdjustments(this.adjustments);
    }
    this.renderPreview();
    this.setData({ adjustments: Object.assign({}, this.adjustments) });
    this.flushReadouts();
  },

  isAdjustmentsDefault() {
    return ui.isDefaultState(this.adjustments);
  },

  isEffectsDefault() {
    return Effects.EFFECT_KEYS.every(
      (key) => Number(this.effects[key]) === Number(APP_EFFECT_DEFAULTS[key])
    );
  },

  sheetResetState(panel) {
    const current = panel === undefined ? this.data.panel : panel;
    if (current === ui.PANELS.ADJUST) {
      return !this.isAdjustmentsDefault();
    }
    if (current === ui.PANELS.EFFECTS) {
      return !this.isEffectsDefault();
    }
    return false;
  },

  isResetState() {
    return ui.isDefaultState(this.adjustments) && Effects.EFFECT_KEYS.every(
      (key) => Number(this.effects[key]) === Number(APP_EFFECT_DEFAULTS[key])
    );
  },

  // --- the privacy popup ----------------------------------------------------

  /**
   * Ask for the privacy consent.
   *
   * The guard shows the in-app popup; the result is always decided (the
   * popup has its own timeout), so the caller never waits forever.
   */
  async requestPrivacyConsent(reason) {
    if (!this.privacyGuard) {
      return { granted: true, reason: 'no-guard' };
    }
    let result;
    try {
      result = await this.privacyGuard.requestConsent({ reason });
    } catch (error) {
      console.error('[wx-spektrafilm][privacy] the consent failed', error);
      return {
        granted: false,
        reason: 'error',
        message: '隐私授权失败，请重试。',
      };
    }
    if (result && result.granted) {
      return result;
    }
    const reason_ = (result && result.reason) || 'refused';
    const message = reason_ === 'timeout'
      ? '隐私授权等待超时，请重试。'
      : '未同意隐私协议，无法继续。';
    return { granted: false, reason: reason_, message };
  },

  applyPrivacyView(view) {
    const popup = ui.privacyPopupView(view);
    this.setData({
      privacyVisible: popup.visible,
      privacyTitle: popup.title,
      privacyBody: popup.body,
      privacyNote: popup.note,
      privacyName: popup.name,
    });
  },

  // The 「同意」 button is a real <button open-type="agreePrivacyAuthorization">:
  // the platform checks that the user tapped it, so the id is passed to the
  // pending resolve.
  onPrivacyAgree() {
    if (!this.privacyGuard) {
      return;
    }
    this.privacyGuard.agree(Privacy.AGREE_BUTTON_ID);
  },

  onPrivacyRefuse() {
    if (!this.privacyGuard) {
      return;
    }
    this.privacyGuard.refuse();
  },

  onOpenPrivacyContract() {
    if (typeof wx.openPrivacyContract !== 'function') {
      this.setData({ privacyNote: '当前微信版本不支持打开隐私协议页面。' });
      return;
    }
    try {
      wx.openPrivacyContract({
        success: () => {},
        fail: (error) => {
          console.error('[wx-spektrafilm][privacy] openPrivacyContract failed', error);
          this.setData({
            privacyNote: '无法打开隐私协议页面：可能尚未在 mp 后台配置《用户隐私保护指引》。',
          });
        },
      });
    } catch (error) {
      console.error('[wx-spektrafilm][privacy] openPrivacyContract failed', error);
      this.setData({ privacyNote: '无法打开隐私协议页面。' });
    }
  },

  // --- full-resolution export ---------------------------------------------

  /**
   * Export the picture with the current look at the full resolution.
   *
   * The pipeline (utils/export.js) is host independent: the page only
   * supplies the WeChat adapters and the current state. The export renders
   * the picture in tiles, so the grain, the halation and the vignette stay
   * seamless and the preview looks like the saved file.
   */
  async onSaveTap() {
    if (this.exporting || !this.data.hasPhoto || !this.photoSrc || !this.activeStock) {
      return;
    }
    const stock = this.activeStock;
    this.exporting = true;
    // The cancel signal also aborts a pending WeChat call: the late answer
    // of an abandoned call is ignored.
    this.exportCancel = Export.createCancelSignal();
    this.exportSteps = StepLog.createStepLog();
    this.exportAuthSetting = null;
    this.setData({
      exporting: true,
      exportText: '准备中…',
      exportProgress: 0,
      exportStatus: ui.EXPORT_STATUS.RUNNING,
      exportError: '',
      exportCanRetry: false,
      exportCanOpenSetting: false,
    });
    try {
      const host = this.exportHostFactory({
        canvas: this.canvas,
        privacy: this.privacyGuard,
        getStockLut: async (stockId, needExtended) => {
          const entry = (this.lutManifest || []).find((item) => item.id === stockId);
          if (!entry) {
            throw new Error(`Unknown stock: ${stockId}`);
          }
          // A positive EV or a nonidentity white balance needs the extended
          // cube, exactly like the preview.
          const extended = needExtended === undefined
            ? ui.needsExtendedLut(this.adjustments)
            : needExtended;
          const images = await this.getLutImage(entry, { needExtended: extended });
          return { base: images.base, extended: images.extended, stock: entry };
        },
      });
      const result = await this.exportRunner({
        host,
        src: this.photoSrc,
        stockId: stock.id,
        adjustments: this.adjustments,
        effects: this.effects,
        intensity: this.adjustments.intensity,
        halationStrength: this.effects.halation,
        maxTextureSize: this.renderer ? this.renderer.maxTextureSize : undefined,
        onProgress: (progress) => {
          this.setData({
            exportText: progress.text,
            exportProgress: progress.progress,
          });
        },
        onStep: (entry) => {
          this.exportSteps.push(entry);
        },
        isCancelled: () => !!(this.exportCancel && this.exportCancel.isCancelled()),
        cancelSignal: this.exportCancel,
      });
      this.exportAuthSetting = result && result.authSetting ? result.authSetting : null;
      if (result.cancelled) {
        this.setData({
          exportStatus: ui.EXPORT_STATUS.CANCELLED,
          exportText: '',
          exportError: '',
        });
        wx.showToast({ title: '已取消保存', icon: 'none' });
      } else if (result.ok) {
        this.setData({
          exportStatus: ui.EXPORT_STATUS.DONE,
          exportText: '',
          exportError: '',
        });
        wx.showToast({ title: '已保存到相册', icon: 'success' });
      } else {
        const status = result.timeout
          ? ui.EXPORT_STATUS.TIMEOUT
          : ui.EXPORT_STATUS.FAILED;
        const message = ui.exportStatusText(status, { message: result.message });
        this.setData({
          exportStatus: status,
          exportText: '',
          exportError: message,
          exportCanRetry: true,
          exportCanOpenSetting: true,
        });
        wx.showToast({ title: message, icon: 'none' });
      }
    } catch (error) {
      console.error('[wx-spektrafilm][export] the export failed', error);
      const message = ui.exportStatusText(ui.EXPORT_STATUS.FAILED, {
        message: this.describeExportError(error),
      });
      this.setData({
        exportStatus: ui.EXPORT_STATUS.FAILED,
        exportText: '',
        exportError: message,
        exportCanRetry: true,
        exportCanOpenSetting: true,
      });
      wx.showToast({ title: message, icon: 'none' });
    } finally {
      this.exporting = false;
      this.exportCancel = null;
      this.setData({ exporting: false, exportProgress: 0 });
    }
  },

  onCancelExport() {
    if (!this.exportCancel) {
      return;
    }
    this.exportCancel.cancel();
    this.setData({ exportText: '正在取消…' });
  },

  // The export failed: the user can try again or open the settings.
  onRetryExport() {
    if (this.exporting) {
      return;
    }
    this.onSaveTap();
  },

  onOpenAlbumSetting() {
    if (typeof wx.openSetting !== 'function') {
      wx.showToast({ title: '当前微信版本不支持打开设置', icon: 'none' });
      return;
    }
    try {
      wx.openSetting({
        success: (result) => {
          const authSetting = result && result.authSetting ? result.authSetting : {};
          this.exportAuthSetting = authSetting;
          console.log('[wx-spektrafilm][export] the settings were opened', authSetting);
        },
        fail: (error) => {
          console.error('[wx-spektrafilm][export] openSetting failed', error);
        },
      });
    } catch (error) {
      console.error('[wx-spektrafilm][export] openSetting failed', error);
    }
  },

  describeExportError(error) {
    const message = String((error && (error.errMsg || error.message)) || '');
    if (error && error.code === 'EXPORT_TIMEOUT') {
      const elapsed = Number.isFinite(Number(error.elapsed))
        ? `${(Number(error.elapsed) / 1000).toFixed(1)} 秒`
        : '未知时间';
      return `导出超时（${elapsed} 未收到回调），请重试。`;
    }
    if (error && error.code === 'EXPORT_CANCELLED') {
      return '已取消保存。';
    }
    if (/privacy/i.test(message)) {
      return '隐私授权未完成，无法保存到相册。';
    }
    if (/offscreen/i.test(message)) {
      return '此设备不支持离屏渲染，无法导出。';
    }
    if (/memory|out of range|allocat/i.test(message)) {
      return '导出时内存不足，请关闭其他应用后重试。';
    }
    if (/auth|deny|permission/i.test(message)) {
      return '没有相册权限，请在设置中允许保存到相册。';
    }
    if (/encode|编码/i.test(message)) {
      return '导出图片编码失败，请重试。';
    }
    return '导出失败，请重试。';
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
      sheetResetEnabled: this.sheetResetState(),
    });
  },

  schedulePreviewRender(extraFrame) {
    if (!this.renderer || !this.data.hasPhoto) {
      this.previewFrames = 0;
      return;
    }
    this.previewFrames = Math.max(this.previewFrames || 0, extraFrame ? 2 : 1);
    if (this.previewScheduled) {
      return;
    }
    this.previewScheduled = true;
    const callback = () => {
      this.previewScheduled = false;
      this.previewTimer = null;
      if (!this.renderer || !this.data.hasPhoto) {
        this.previewFrames = 0;
        return;
      }
      if (ui.needsExtendedLut(this.adjustments) && this.activeStock &&
        this.activeStock.extended && !this.renderer.hasExtendedLut()) {
        this.previewFrames = 0;
        this.ensureActiveExtended();
        return;
      }
      try {
        this.renderer.render(this.comparing ? 0 : this.adjustments.intensity);
      } catch (error) {
        this.previewFrames = 0;
        this.showError(error.message);
        return;
      }
      this.previewFrames = Math.max(0, this.previewFrames - 1);
      if (this.previewFrames > 0) {
        this.schedulePreviewRender(false);
      }
    };
    if (this.canvas && typeof this.canvas.requestAnimationFrame === 'function') {
      this.canvas.requestAnimationFrame(callback);
    } else {
      this.previewTimer = setTimeout(callback, 16);
    }
  },

  renderPreview() {
    if (!this.renderer || !this.data.hasPhoto) {
      return;
    }
    if (ui.needsExtendedLut(this.adjustments) &&
      this.activeStock && this.activeStock.extended &&
      !this.renderer.hasExtendedLut()) {
      // The extended cube is still being fetched; the preview is redrawn as
      // soon as it is resident.
      this.ensureActiveExtended();
      return;
    }
    try {
      this.schedulePreviewRender(false);
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
    this.schedulePreviewRender(false);
  },

  onPreviewTouchEnd() {
    if (!this.comparing) {
      return;
    }
    this.comparing = false;
    this.setData({ comparing: false });
    this.schedulePreviewRender(false);
  },

  onPreviewTouchCancel() {
    this.onPreviewTouchEnd();
  },

  // --- preset thumbnails ---------------------------------------------------

  resetThumbnails() {
    this.thumbQueue = [];
    this.thumbRunning = false;
    this.thumbs = Object.create(null);
    this.lastThumbnailGeometry = null;
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
    const geometry = thumbnails.thumbnailGeometry(this.photoSize.width, this.photoSize.height);
    this.lastThumbnailGeometry = Object.assign({
      stockId,
      photoWidth: this.photoSize.width,
      photoHeight: this.photoSize.height,
    }, geometry);
    this.renderer.setLut(images.base, stock, images.extended);
    const result = this.renderer.renderToPixels({
      width: geometry.width,
      height: geometry.height,
      imageUvOffset: geometry.imageUvOffset,
      imageUvScale: geometry.imageUvScale,
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
      width: geometry.width,
      height: geometry.height,
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
    this.schedulePreviewRender(false);
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
      const onVisible = (result) => {
        if (!result || !result.id) {
          return;
        }
        this.prioritiseThumbnail(String(result.id).replace(/^stock-/, ''));
      };
      // The strip scrolls horizontally: items near the scroll-view edges are
      // generated first, the rest follow in manifest order.
      this.observer.relativeToViewport({ left: 240, right: 240 })
        .observe('.strip-item', onVisible);
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

  queryPresentationGeometry() {
    const readRect = (selector) => new Promise((resolve) => {
      wx.createSelectorQuery()
        .select(selector)
        .boundingClientRect()
        .exec((result) => resolve(result && result[0] ? result[0] : null));
    });
    return Promise.all([
      readRect('#previewCanvas'),
      readRect('#previewStage'),
    ]).then(([canvasRect, stageRect]) => ({ canvasRect, stageRect }));
  },

  async runDiagnosticSuite(options) {
    const settings = options || {};
    if (this.diagnosticsRunning) {
      return null;
    }
    this.diagnosticsRunning = true;
    if (!settings.fromError) {
      this.setData({ diagnosticsRunning: true });
    }
    try {
      const geometry = await this.queryPresentationGeometry();
      let photoSelfTest = null;
      try {
        photoSelfTest = runOrientedSelfTest();
      } catch (error) {
        photoSelfTest = {
          available: false,
          error: String((error && error.errMsg) || error.message || error),
        };
        console.error('[wx-spektrafilm][diag][geometry] self-test failed', error);
      }
      const canvasRect = geometry.canvasRect || this.canvasRect || this.canvasNodeSize;
      const stageRect = geometry.stageRect || this.stageRect || canvasRect;
      const nodeSize = canvasRect ? {
        width: canvasRect.width, height: canvasRect.height,
      } : this.canvasNodeSize;
      const outcome = Diagnostics.runDiagnostics({
        renderer: this.renderer,
        canvas: this.canvas,
        nodeSize,
        canvasRect,
        stageRect,
        thumbnail: this.lastThumbnailGeometry,
        pixelRatio: this.devicePixelRatio,
        photo: this.photoSourceInfo,
        photoSelfTest,
        exportSteps: this.exportSteps ? this.exportSteps.entries() : [],
        privacy: this.privacyState(),
        app: {
          name: appInfo.name,
          version: appInfo.version,
          appId: appInfo.appId,
          sdkVersion: this.sdkVersion || '',
        },
      });
      this.setData({
        diagnosticsText: outcome.text,
        diagnosticsAvailable: true,
      });
      if (settings.fromError && settings.bannerMessage &&
        this.data.error === settings.bannerMessage) {
        this.setData({
          error: `${settings.bannerMessage}\n已生成诊断，可在 关于 → 诊断 查看`,
        });
      }
      return outcome;
    } catch (error) {
      console.error('[wx-spektrafilm][diag] suite failed', error);
      return null;
    } finally {
      this.diagnosticsRunning = false;
      this.setData({ diagnosticsRunning: false });
    }
  },

  // The privacy state of the diagnostics: the setting of the platform, the
  // events of the guard and the raw authorisation of the album scope.
  privacyState() {
    if (!this.privacyGuard) {
      return null;
    }
    const state = this.privacyGuard.state();
    return Object.assign({}, state, {
      authSetting: this.exportAuthSetting || null,
    });
  },

  onOpenDiagnostics() {
    this.setData({ diagnosticsOpen: true });
    this.runDiagnosticSuite();
  },

  onRerunDiagnostics() {
    this.runDiagnosticSuite();
  },

  onCloseDiagnostics() {
    this.setData({ diagnosticsOpen: false });
  },

  onCopyDiagnostics() {
    const text = this.data.diagnosticsText || Diagnostics.getLastText();
    if (!text) {
      wx.showToast({ title: '诊断尚未生成', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '诊断已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' }),
    });
  },

  // --- toolbar, bottom sheet, about ---------------------------------------

  onNoop() {},

  onTabTap(event) {
    const tab = event.currentTarget.dataset.tab;
    return this.setPanel(ui.nextPanel(this.data.panel, tab, this.data.hasPhoto));
  },

  onCloseSheet() {
    return this.setPanel(ui.PANELS.NONE);
  },

  setPanel(panel) {
    if (panel === this.data.panel) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.setData({
        panel,
        activeTab: ui.activeTab(panel),
        sheetTitle: ui.SHEET_TITLES[panel] || '',
        sheetResetEnabled: this.sheetResetState(panel),
      }, () => {
        // The canvas keeps its size. Once the sheet is laid out the photo is
        // fitted into the part of the stage that stays visible.
        this.applySheetInset().then(resolve, resolve);
      });
    });
  },

  /**
   * Fit the photo into the visible part of the stage.
   *
   * The sheet covers the lower part of the stage. The native canvas is NOT
   * resized (resizing a WebGL surface on iOS is fragile); the renderer is told
   * how many CSS pixels at the bottom are covered and redraws the photo into
   * the remaining area.
   */
  applySheetInset() {
    const request = ++this.insetRequestId;
    const apply = (covered) => {
      if (request !== this.insetRequestId) {
        return;
      }
      this.sheetCoverage = covered;
      if (this.renderer && typeof this.renderer.setPresentationInset === 'function') {
        this.renderer.setPresentationInset({ bottom: covered });
      }
      this.schedulePreviewRender(true);
    };
    if (!this.data.panel) {
      apply(0);
      return Promise.resolve(0);
    }
    const read = (selector) => new Promise((resolve) => {
      wx.createSelectorQuery()
        .select(selector)
        .boundingClientRect()
        .exec((result) => resolve(result && result[0] ? result[0] : null));
    });
    return Promise.all([read('#previewStage'), read('#editSheet')]).then(([stage, sheet]) => {
      const covered = ui.sheetCoverage(stage, sheet);
      apply(covered);
      return covered;
    });
  },

  onOpenAbout() {
    this.setData({ aboutOpen: true });
  },

  onCloseAbout() {
    this.setData({ aboutOpen: false });
  },

  onDismissError() {
    this.setData({ error: '' });
  },

  onDismissExportError() {
    this.setData({
      exportError: '',
      exportCanRetry: false,
      exportCanOpenSetting: false,
      exportStatus: ui.EXPORT_STATUS.IDLE,
    });
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
    this.photoSrc = '';
    this.photoSourceInfo = { type: 'none' };
    this.activeStock = null;
    this.comparing = false;
    this.resetThumbnails();
    if (this.renderer) {
      if (this.canvasNodeSize) {
        this.renderer.resizeToCssSize(
          this.canvasNodeSize.width, this.canvasNodeSize.height, this.devicePixelRatio
        );
      }
      this.renderer.clearPhoto();
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
      canvasStyle: 'width: 100%; height: 100%;',
      categories: [],
      panel: ui.PANELS.NONE,
      activeTab: ui.TABS.FILM,
      sheetTitle: '',
      sheetResetEnabled: false,
    });
    this.sheetCoverage = 0;
    this.insetRequestId += 1;
    if (this.renderer && typeof this.renderer.setPresentationInset === 'function') {
      this.renderer.setPresentationInset({ bottom: 0 });
    }
  },

  fitCanvas() {
    return this.queryPresentationGeometry().then((geometry) => {
      const canvasRect = geometry.canvasRect || this.canvasRect || this.canvasNodeSize;
      const stageRect = geometry.stageRect || this.stageRect || canvasRect;
      this.canvasRect = canvasRect || null;
      this.stageRect = stageRect || null;
      if (canvasRect && canvasRect.width && canvasRect.height) {
        this.canvasNodeSize = { width: canvasRect.width, height: canvasRect.height };
      }
      if (this.renderer && stageRect && stageRect.width && stageRect.height) {
        this.lastBufferGeometry = this.renderer.resizeToCssSize(
          stageRect.width, stageRect.height, this.devicePixelRatio
        );
      }
      return {
        canvasRect: this.canvasRect,
        stageRect: this.stageRect,
        buffer: this.lastBufferGeometry || null,
      };
    });
  },

  describeError(error) {
    console.error('[wx-spektrafilm]', error);
    const message = String((error && (error.errMsg || error.message)) || '');
    const errMsg = String((error && (error.errMsg || error.message)) || '');
    let friendly = '处理照片失败，请重试。';
    if (/cancel/i.test(message)) {
      friendly = '已取消选择。';
    } else if (/privacy/i.test(message)) {
      friendly = '隐私接口未声明：请在 mp 后台「设置 → 服务内容声明 → 用户隐私保护指引」中声明「选中的照片或视频信息」后重试。';
    } else if (/auth|deny|permission|authorize/i.test(message)) {
      friendly = '无法访问照片或相机，请在设置中允许相应权限。';
    } else if (error && error.code === 'UNSUPPORTED_TYPE') {
      friendly = '不支持此照片格式，请选择 JPG 或 PNG。';
    } else if (/loadSubpackage|subpackages[\\/]luts|luts\.js|LUT manifest/i.test(message)) {
      friendly = '胶片资源加载失败，请重试。';
    } else if ((error && error.code === 'DECODE_FAILED') || /getImageInfo|decode/i.test(message)) {
      friendly = '照片解码失败，请尝试另一张 JPG 或 PNG。';
    }
    const debug = errMsg ? `（调试：${errMsg.slice(0, 80)}）` : '';
    return friendly + debug;
  },

  showError(message) {
    this.setData({ error: message, busy: false, busyText: '', comparing: false });
    this.comparing = false;
    this.runDiagnosticSuite({ fromError: true, bannerMessage: message });
  },
});
