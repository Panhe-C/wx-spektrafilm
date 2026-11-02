const shaders = require('../../utils/shaders.js');
const { createRenderer } = require('../../utils/lut-renderer.js');
const { loadCanvasImage, preparePhoto } = require('../../utils/photo.js');

Page({
  data: {
    ready: false,
    hasPhoto: false,
    busy: false,
    busyText: '',
    error: '',
    stocks: [],
    selectedStock: '',
    intensity: 1,
    intensityText: '100%',
    comparing: false,
    canvasStyle: 'width: 1px; height: 1px;',
  },

  onLoad() {
    this.canvas = null;
    this.renderer = null;
    this.lutManifest = null;
    this.lutCache = Object.create(null);
    this.operationId = 0;
    this.stockRequestId = 0;
    this.photoSize = null;
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
    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }
    Object.keys(this.lutCache).forEach((key) => {
      this.lutCache[key].src = '';
    });
    this.lutCache = Object.create(null);
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
          });
          this.renderer.resize(1, 1);
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
      this.showError(this.describeError(error));
    }
  },

  async loadPhoto(src) {
    const operation = ++this.operationId;
    this.stockRequestId += 1;
    this.setData({
      busy: true,
      busyText: '正在解码、校正方向并缩放…',
      error: '',
      comparing: false,
    });
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
        this.setData({
          hasPhoto: true,
          busyText: '正在加载胶片 LUT…',
        }, resolve);
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

      const stocks = await this.ensureLuts();
      if (operation !== this.operationId) {
        return;
      }
      this.setData({ stocks });
      if (!stocks.length) {
        throw new Error('LUT manifest is empty');
      }
      await this.activateStock(stocks[0].id, operation);
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

  async getLutImage(stock) {
    if (this.lutCache[stock.id]) {
      return this.lutCache[stock.id];
    }
    const image = await loadCanvasImage(this.canvas, `/subpackages/luts/${stock.file}`);
    this.lutCache[stock.id] = image;
    return image;
  },

  async activateStock(id, operation) {
    const request = ++this.stockRequestId;
    const stocks = await this.ensureLuts();
    const stock = stocks.find((item) => item.id === id);
    if (!stock) {
      throw new Error(`Unknown stock: ${id}`);
    }
    this.setData({
      selectedStock: id,
      busy: true,
      busyText: `正在载入 ${stock.name}…`,
      error: '',
    });
    const image = await this.getLutImage(stock);
    if (operation !== this.operationId || request !== this.stockRequestId) {
      return;
    }
    this.renderer.setLut(image, stock);
    this.renderer.render(this.data.comparing ? 0 : this.data.intensity);
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
    } finally {
      if (operation === this.operationId) {
        this.setData({ busy: false, busyText: '' });
      }
    }
  },

  setIntensity(value) {
    const intensity = Math.max(0, Math.min(1, Number(value)));
    this.setData({
      intensity,
      intensityText: `${Math.round(intensity * 100)}%`,
    });
    if (this.data.hasPhoto) {
      this.renderer.render(this.data.comparing ? 0 : intensity);
    }
  },

  onIntensityChanging(event) {
    this.setIntensity(event.detail.value);
  },

  onIntensityChange(event) {
    this.setIntensity(event.detail.value);
  },

  onPreviewTouchStart() {
    if (!this.data.hasPhoto) {
      return;
    }
    this.setData({ comparing: true });
    this.renderer.render(0);
  },

  onPreviewTouchEnd() {
    if (!this.data.comparing) {
      return;
    }
    this.setData({ comparing: false });
    this.renderer.render(this.data.intensity);
  },

  onPreviewTouchCancel() {
    this.onPreviewTouchEnd();
  },

  onClearPhoto() {
    this.operationId += 1;
    this.stockRequestId += 1;
    this.photoSize = null;
    if (this.renderer) {
      this.renderer.clearPhoto();
      this.renderer.resize(1, 1);
    }
    this.setData({
      hasPhoto: false,
      busy: false,
      busyText: '',
      error: '',
      selectedStock: '',
      intensity: 1,
      intensityText: '100%',
      comparing: false,
      canvasStyle: 'width: 1px; height: 1px;',
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
  },
});
