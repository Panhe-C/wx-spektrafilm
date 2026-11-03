// Pure UI policy for the presets/adjustments page.
//
// Everything in this module is side-effect free so that the Mini Program page
// and the Node unit suite (harness/test-ui-state.mjs) share one implementation
// of the slider ranges, the readouts, the category grouping, the thumbnail
// ordering, the phase machine, and the setData throttle policy.
(function registerUiState(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SpektrafilmUiState = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function uiStateFactory() {
  const ADJUSTMENT_DEFAULTS = Object.freeze({
    ev: 0,
    temperature: 0,
    tint: 0,
    intensity: 1,
    contrast: 0,
    saturation: 1,
  });
  const ADJUSTMENT_LIMITS = Object.freeze({
    ev: [-2, 2],
    temperature: [-100, 100],
    tint: [-100, 100],
    intensity: [0, 1],
    contrast: [-1, 1],
    saturation: [0, 2],
  });
  const ADJUSTMENT_STEPS = Object.freeze({
    ev: 0.1,
    temperature: 1,
    tint: 1,
    intensity: 0.01,
    contrast: 0.01,
    saturation: 0.05,
  });
  const ADJUSTMENT_KEYS = Object.keys(ADJUSTMENT_DEFAULTS);

  // Readout updates are throttled to this interval while a slider is dragged.
  const READOUT_INTERVAL_MS = 120;

  // The post-LUT contrast slider (-1 .. 1) is mapped onto a multiplier of
  // 0.7 .. 1.4 around the 0.5 pivot; the mapping itself lives in
  // utils/adjust.js (contrastMultiplier), this is the range for the UI.
  const CONTRAST_MULTIPLIER_RANGE = Object.freeze([0.7, 1.4]);

  // Fixed-aspect thumbnail crop geometry lives in utils/thumbnail.js so the
  // renderer, image mode, WXSS and diagnostics share one policy.

  const CATEGORY_TITLES = Object.freeze({
    'colour negative': '彩色负片',
    'slide (direct scan)': '反转片（幻灯片）',
    'cinema negative': '电影胶片',
  });
  const CATEGORY_ORDER = Object.freeze([
    'colour negative',
    'slide (direct scan)',
    'cinema negative',
  ]);

  // One-line Chinese characterisations. They describe the stock's published
  // character, not a measured claim about the shipped cube.
  const STOCK_DESCRIPTIONS = Object.freeze({
    portra400: '低反差、肤色柔和的经典负片，人像与日常都稳妥。',
    portra160: '颗粒更细、层次更柔的低速负片，适合明亮光线。',
    gold200: '色彩明快、反差适中的消费级负片，日常快照的典型味道。',
    ultramax400: '高感负片，颗粒更明显、色彩略浓，适合光线不足。',
    ektar100: '饱和度高、反差偏硬的中低感负片，风景细节突出。',
    velvia100: '反转片，色彩浓烈、反差强烈，正片直扫没有打印环节。',
    provia100f: '反转片，色彩均衡干净，反差比 Velvia 柔和。',
    kodachrome64: '反转片，低感细颗粒、强反差，色彩饱和偏暖。',
    pro400h: '冷调肤色、阴影层次完整的中速富士负片。',
    vision3_250d: '电影负片，标称日光平衡，宽容度好、颗粒细腻。',
    vision3_500t: '电影负片，标称钨丝灯平衡，肤色偏暖，适合夜景。',
  });
  const DEFAULT_DESCRIPTION = '基于 spektrafilm 物理流程烘焙的胶片色彩。';

  const PHASES = Object.freeze({
    EMPTY: 'empty',
    DECODING: 'decoding',
    LOADING_LUTS: 'loading-luts',
    READY: 'ready',
    ERROR: 'error',
  });
  const EVENTS = Object.freeze({
    PICK: 'pick',
    DECODED: 'decoded',
    LUTS_READY: 'luts-ready',
    FAILED: 'failed',
    CLEAR: 'clear',
  });
  const PHASE_TEXTS = Object.freeze({
    empty: '',
    decoding: '正在解码、校正方向并缩放…',
    'loading-luts': '正在加载胶片 LUT…',
    ready: '',
    error: '',
  });
  const TRANSITIONS = Object.freeze({
    empty: { pick: PHASES.DECODING, failed: PHASES.ERROR, clear: PHASES.EMPTY },
    decoding: { decoded: PHASES.LOADING_LUTS, failed: PHASES.ERROR, clear: PHASES.EMPTY },
    'loading-luts': { 'luts-ready': PHASES.READY, failed: PHASES.ERROR, clear: PHASES.EMPTY },
    ready: { pick: PHASES.DECODING, failed: PHASES.ERROR, clear: PHASES.EMPTY },
    error: { pick: PHASES.DECODING, failed: PHASES.ERROR, clear: PHASES.EMPTY },
  });

  function clamp(value, range) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new Error(`Non-finite value: ${value}`);
    }
    return Math.max(range[0], Math.min(range[1], number));
  }

  function roundToStep(value, step) {
    const scaled = Math.round(value / step) * step;
    // Kill binary noise such as 0.30000000000000004 without losing the step.
    return Number(scaled.toFixed(6));
  }

  function applyAdjustment(state, key, rawValue) {
    if (!Object.prototype.hasOwnProperty.call(ADJUSTMENT_LIMITS, key)) {
      throw new Error(`Unknown adjustment: ${key}`);
    }
    const limits = ADJUSTMENT_LIMITS[key];
    const step = ADJUSTMENT_STEPS[key];
    const number = Number(rawValue);
    if (!Number.isFinite(number)) {
      throw new Error(`Non-finite adjustment: ${rawValue}`);
    }
    const stepped = roundToStep(clamp(number, limits), step);
    const value = clamp(stepped, limits);
    const next = Object.assign({}, state);
    next[key] = value;
    return next;
  }

  function resetAdjustments() {
    return Object.assign({}, ADJUSTMENT_DEFAULTS);
  }

  function isDefaultState(state) {
    return ADJUSTMENT_KEYS.every((key) => Number(state[key]) === ADJUSTMENT_DEFAULTS[key]);
  }

  function formatSigned(value, digits) {
    const rounded = Number(Number(value).toFixed(digits));
    const sign = rounded > 0 ? '+' : (rounded < 0 ? '-' : '');
    return `${sign}${Math.abs(rounded).toFixed(digits)}`;
  }

  function readouts(state) {
    return {
      ev: `${formatSigned(state.ev, 1)} EV`,
      temperature: formatSigned(state.temperature, 0),
      tint: formatSigned(state.tint, 0),
      intensity: `${Math.round(Number(state.intensity) * 100)}%`,
      contrast: formatSigned(state.contrast, 2),
      saturation: `${Math.round(Number(state.saturation) * 100)}%`,
    };
  }

  // A positive EV or any white-balance change needs the extended-range cube.
  function needsExtendedLut(state) {
    return Number(state.ev) > 0 ||
      Number(state.temperature) !== 0 ||
      Number(state.tint) !== 0;
  }

  function stockDescription(stock) {
    const id = stock && stock.id;
    return STOCK_DESCRIPTIONS[id] || DEFAULT_DESCRIPTION;
  }

  function categoryTitle(key) {
    return CATEGORY_TITLES[key] || key;
  }

  function categoryRank(key) {
    const index = CATEGORY_ORDER.indexOf(key);
    return index === -1 ? CATEGORY_ORDER.length : index;
  }

  function placeholderColor(seed) {
    const text = String(seed || '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const hue = Math.abs(hash) % 360;
    const saturation = 18 + (Math.abs(hash >> 8) % 14);
    const lightness = 20 + (Math.abs(hash >> 16) % 10);
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  }

  function groupStocks(stocks) {
    const groups = [];
    const index = Object.create(null);
    (stocks || []).forEach((stock) => {
      const key = stock.category || 'other';
      if (!index[key]) {
        index[key] = { key, title: categoryTitle(key), stocks: [] };
        groups.push(index[key]);
      }
      index[key].stocks.push({
        id: stock.id,
        name: stock.name,
        iso: stock.iso,
        category: stock.category,
        description: stockDescription(stock),
        thumb: { status: 'idle', src: '', color: placeholderColor(stock.id) },
      });
    });
    groups.sort((left, right) => categoryRank(left.key) - categoryRank(right.key));
    return groups;
  }

  // Thumbnail order: the selected stock first, then the visible/near cards,
  // then the remaining stocks in manifest order. Every id appears exactly once.
  function thumbnailOrder(stockIds, selectedId, visibleIds) {
    const ids = stockIds || [];
    const known = Object.create(null);
    ids.forEach((id) => { known[id] = true; });
    const seen = Object.create(null);
    const order = [];
    const push = (id) => {
      if (!id || seen[id] || !known[id]) {
        return;
      }
      seen[id] = true;
      order.push(id);
    };
    push(selectedId);
    (visibleIds || []).forEach(push);
    ids.forEach(push);
    return order;
  }

  // setData throttle policy for the numeric readouts.
  function shouldEmit(now, lastEmit, interval) {
    if (!Number.isFinite(now) || !Number.isFinite(lastEmit)) {
      return true;
    }
    return now - lastEmit >= (interval || 0);
  }

  function nextPhase(phase, event) {
    const table = TRANSITIONS[phase];
    if (!table) {
      throw new Error(`Unknown phase: ${phase}`);
    }
    const next = table[event];
    if (!next) {
      throw new Error(`Invalid transition: ${phase} -> ${event}`);
    }
    return next;
  }

  function phaseText(phase) {
    return PHASE_TEXTS[phase] || '';
  }

  function isBusyPhase(phase) {
    return phase === PHASES.DECODING || phase === PHASES.LOADING_LUTS;
  }

  return {
    ADJUSTMENT_DEFAULTS,
    ADJUSTMENT_LIMITS,
    ADJUSTMENT_STEPS,
    ADJUSTMENT_KEYS,
    CONTRAST_MULTIPLIER_RANGE,
    READOUT_INTERVAL_MS,
    CATEGORY_TITLES,
    CATEGORY_ORDER,
    STOCK_DESCRIPTIONS,
    PHASES,
    EVENTS,
    PHASE_TEXTS,
    TRANSITIONS,
    applyAdjustment,
    resetAdjustments,
    isDefaultState,
    readouts,
    needsExtendedLut,
    stockDescription,
    categoryTitle,
    placeholderColor,
    groupStocks,
    thumbnailOrder,
    shouldEmit,
    nextPhase,
    phaseText,
    isBusyPhase,
  };
}));
