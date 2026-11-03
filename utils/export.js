// Full-resolution export: a pure planner and an orchestrator with injected
// host adapters.
//
// The planner decides the export size and the tile geometry. It is pure, so
// the Node unit suite (harness/test-export.mjs) can check the coverage, the
// margins and the size caps without a browser.
//
// The orchestrator drives the decode -> render -> encode -> save pipeline
// through the host adapters and never touches a global. The Mini Program
// page injects the WeChat adapters (utils/export-wechat.js); the unit suite
// injects a mock host, which is how the permission flow (privacy consent,
// auth-deny recovery, cancellation, timeouts) is verified.
//
// Every step that talks to the platform runs inside a timeout wrapper: a
// WeChat call that never calls back must not freeze the export. The wrapper
// reports the step name, the elapsed time and the last raw callback, and a
// late callback is ignored, so a step can never complete twice.
(function registerExport(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./effects.js'), require('./step-log.js'));
  } else {
    root.SpektrafilmExport = factory(root.SpektrafilmEffects, root.SpektrafilmStepLog);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function exportFactory(Effects, StepLog) {
  // The export never exceeds 4096 px on the long edge, and never exceeds the
  // GPU limits of the device.
  const EXPORT_MAX_LONG_EDGE = 4096;
  // Tiles are rendered in rectangles of at most this size, plus the halation
  // margin, so that the framebuffer stays small enough for a phone GPU.
  const EXPORT_TILE_SIZE = 2048;
  const EXPORT_JPEG_QUALITY = 0.92;
  const ALBUM_SCOPE = 'scope.writePhotosAlbum';
  const EXPORT_STAGES = Object.freeze(['permission', 'decode', 'render', 'encode', 'save']);

  // The timeout of every platform call. The encode step gets a larger budget
  // because it writes a full resolution JPEG.
  const DEFAULT_TIMEOUTS = Object.freeze({
    default: 8000,
    hint: 2500,
    getSetting: 2500,
    permission: 8000,
    privacy: 8000,
    imageInfo: 8000,
    decode: 20000,
    encode: 30000,
    save: 15000,
  });

  // The WeChat errors that mean "the album scope is not granted".
  const PRIVACY_NOT_DECLARED_PATTERN = /not declared in the privacy agreement|privacy api banned/i;
  const PRIVACY_PATTERN = /privacy/i;
  const AUTH_DENY_PATTERN = /auth|deny|permission|authorize no response/i;
  const CANCEL_PATTERN = /cancel/i;

  function positiveInteger(value, fallback) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number) || number < 1) {
      return fallback;
    }
    return number;
  }

  /**
   * The export size: the long edge of the original, capped by the 4096 px
   * budget and by the GPU limits. The aspect ratio is kept.
   */
  function computeExportSize(sourceWidth, sourceHeight, limits) {
    const width = Math.round(Number(sourceWidth));
    const height = Math.round(Number(sourceHeight));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      throw new Error('Invalid source dimensions');
    }
    const options = limits || {};
    const longEdge = Math.max(width, height);
    const cap = Math.min(
      positiveInteger(options.maxLongEdge, EXPORT_MAX_LONG_EDGE),
      positiveInteger(options.maxTextureSize, EXPORT_MAX_LONG_EDGE),
      longEdge
    );
    const target = Math.max(1, Math.floor(cap));
    const scale = target / longEdge;
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      longEdge: target,
      scale,
      sourceWidth: width,
      sourceHeight: height,
    };
  }

  /**
   * The margin a tile needs so that the halation kernel never reaches
   * outside the rendered rectangle. It is zero when the halation is off.
   */
  function exportMargin(stockId, longEdgePx, halationStrength) {
    if (!halationStrength) {
      return 0;
    }
    const stock = Effects.forStock(stockId);
    return Effects.halationMarginPixels(stock.halation.sigmaUm, longEdgePx);
  }

  /**
   * The tile rectangles. They cover the picture exactly: no gap, no overlap.
   */
  function planTiles(options) {
    const width = Math.round(Number(options.width));
    const height = Math.round(Number(options.height));
    const tileSize = positiveInteger(options.tileSize, EXPORT_TILE_SIZE);
    const margin = Math.max(0, Math.round(Number(options.margin) || 0));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      throw new Error('Invalid export dimensions');
    }
    const tiles = [];
    for (let y = 0; y < height; y += tileSize) {
      for (let x = 0; x < width; x += tileSize) {
        tiles.push({
          index: tiles.length,
          x,
          y,
          width: Math.min(tileSize, width - x),
          height: Math.min(tileSize, height - y),
          margin,
        });
      }
    }
    return tiles;
  }

  /**
   * The renderer target of one tile.
   *
   * The frame space is normalised to the long edge of the exported picture,
   * so the grain and the vignette are continuous with a single-pass render.
   * The uv mappings place the tile and its padded halo rectangle on the
   * full-resolution picture.
   */
  function buildTileTarget(plan, tile) {
    const margin = tile.margin || 0;
    const paddedWidth = tile.width + 2 * margin;
    const paddedHeight = tile.height + 2 * margin;
    const longEdge = plan.longEdgePx;
    return {
      width: tile.width,
      height: tile.height,
      haloWidth: paddedWidth,
      haloHeight: paddedHeight,
      regionOrigin: [tile.x / longEdge, tile.y / longEdge],
      regionSize: [tile.width / longEdge, tile.height / longEdge],
      imageFrameOrigin: [0, 0],
      imageFrameSize: [plan.width / longEdge, plan.height / longEdge],
      imageUvOffset: [tile.x / plan.width, tile.y / plan.height],
      imageUvScale: [tile.width / plan.width, tile.height / plan.height],
      haloImageUvOffset: [
        (tile.x - margin) / plan.width,
        (tile.y - margin) / plan.height,
      ],
      haloImageUvScale: [
        paddedWidth / plan.width,
        paddedHeight / plan.height,
      ],
      haloUvScale: [tile.width / paddedWidth, tile.height / paddedHeight],
      haloUvOffset: [margin / paddedWidth, margin / paddedHeight],
      longEdgePx: longEdge,
    };
  }

  /**
   * The whole export plan: the size, the margin, the tile size and the
   * tiles with their renderer targets.
   */
  function planExport(options) {
    const settings = options || {};
    const size = computeExportSize(settings.sourceWidth, settings.sourceHeight, {
      maxLongEdge: settings.maxLongEdge,
      maxTextureSize: settings.maxTextureSize,
    });
    const longEdgePx = Math.max(size.width, size.height);
    const margin = exportMargin(
      settings.stockId,
      longEdgePx,
      settings.halationStrength
    );
    const maxTextureSize = positiveInteger(settings.maxTextureSize, EXPORT_MAX_LONG_EDGE);
    // The padded halo buffer must still fit into a texture.
    const usable = Math.max(64, maxTextureSize - 2 * margin);
    const tileSize = Math.max(
      64,
      Math.min(positiveInteger(settings.tileSize, EXPORT_TILE_SIZE), usable)
    );
    const plan = {
      width: size.width,
      height: size.height,
      longEdgePx,
      scale: size.scale,
      sourceWidth: size.sourceWidth,
      sourceHeight: size.sourceHeight,
      margin,
      tileSize,
      tiles: [],
    };
    plan.tiles = planTiles({
      width: plan.width,
      height: plan.height,
      tileSize,
      margin,
    }).map((tile) => Object.assign({}, tile, { target: buildTileTarget(plan, tile) }));
    return plan;
  }

  // --- the timeout wrapper -------------------------------------------------

  function errorText(error) {
    return String((error && (error.errMsg || error.message)) || error || 'unknown error');
  }

  function toError(payload) {
    if (payload instanceof Error) {
      return payload;
    }
    const error = new Error(errorText(payload));
    if (payload && payload.errno !== undefined) {
      error.errno = payload.errno;
    }
    if (payload && payload.errMsg) {
      error.errMsg = payload.errMsg;
    }
    return error;
  }

  function timeoutError(step, elapsed, limit, raw) {
    const error = new Error(
      `「${step}」超时：${(elapsed / 1000).toFixed(1)} 秒没有收到回调（上限 ${(limit / 1000).toFixed(1)} 秒）`
    );
    error.code = 'EXPORT_TIMEOUT';
    error.step = step;
    error.elapsed = elapsed;
    error.timeoutMs = limit;
    error.raw = (raw === null || raw === undefined) ? 'no callback' : raw;
    return error;
  }

  function cancelError(step, elapsed) {
    const error = new Error(`「${step}」已取消`);
    error.code = 'EXPORT_CANCELLED';
    error.step = step;
    error.elapsed = elapsed;
    return error;
  }

  function isTimeoutError(error) {
    return !!(error && error.code === 'EXPORT_TIMEOUT');
  }

  function isCancelError(error) {
    return !!(error && error.code === 'EXPORT_CANCELLED');
  }

  /**
   * The cancellation signal of the export.
   *
   * The page owns one of them, so that 「取消」 also works while a WeChat
   * call is pending: the pending call is abandoned (its late answer is
   * ignored) and the export stops.
   */
  function createCancelSignal() {
    const listeners = [];
    const signal = {
      cancelled: false,
      isCancelled() {
        return signal.cancelled;
      },
      cancel() {
        if (signal.cancelled) {
          return;
        }
        signal.cancelled = true;
        listeners.slice().forEach((listener) => {
          try {
            listener();
          } catch (error) {
            // A broken listener must not stop the cancellation.
          }
        });
      },
      onCancel(listener) {
        if (typeof listener !== 'function') {
          return () => {};
        }
        if (signal.cancelled) {
          try {
            listener();
          } catch (error) {
            // Nothing to do.
          }
          return () => {};
        }
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index !== -1) {
            listeners.splice(index, 1);
          }
        };
      },
    };
    return signal;
  }

  function resolveTimeouts(settings, host) {
    const map = Object.assign({}, DEFAULT_TIMEOUTS);
    const apply = (source) => {
      if (!source || typeof source !== 'object') {
        return;
      }
      Object.keys(source).forEach((key) => {
        const value = Number(source[key]);
        if (Number.isFinite(value) && value > 0) {
          map[key] = value;
        }
      });
    };
    apply(settings && settings.timeouts);
    apply(host && host.timeouts);
    return map;
  }

  function timeoutFor(map, step, override) {
    const explicit = Number(override);
    if (Number.isFinite(explicit) && explicit > 0) {
      return explicit;
    }
    if (map[step] !== undefined) {
      return map[step];
    }
    return map.default;
  }

  /**
   * The context of one export: the timeouts, the step log and the
   * cancellation signal.
   */
  function createContext(options) {
    const settings = options || {};
    const host = settings.host || null;
    const timeouts = resolveTimeouts(settings, host);
    const log = StepLog.createStepLog(settings.stepLogLimit);
    const cancel = settings.cancelSignal || null;
    const isCancelled = typeof settings.isCancelled === 'function'
      ? settings.isCancelled
      : () => !!(cancel && cancel.isCancelled && cancel.isCancelled());
    const state = { stage: 'permission', lastPayload: null, authSetting: null };
    // The running steps and the privacy popup: a step that waits for the
    // user (the popup) does not spend its timeout budget.
    const active = [];
    let popupVisible = false;
    let popupSince = 0;
    let unsubscribeGuard = null;

    function record(step, phase, elapsed, detail) {
      const entry = {
        step: step || state.stage,
        phase,
        elapsed: elapsed === undefined || elapsed === null ? null : Math.round(elapsed),
        detail: detail === undefined ? '' : detail,
      };
      log.push(entry);
      if (typeof settings.onStep === 'function') {
        try {
          settings.onStep(entry);
        } catch (error) {
          // The observer must not break the export.
        }
      }
      if (typeof console !== 'undefined') {
        const text = `${StepLog.PREFIX} ${StepLog.formatEntry(entry)}`;
        if (phase === StepLog.PHASES.ERROR ||
          phase === StepLog.PHASES.TIMEOUT ||
          phase === StepLog.PHASES.CANCELLED) {
          console.error(text);
        } else {
          console.log(text);
        }
      }
      return entry;
    }

    /**
     * Run one platform call with a timeout.
     *
     * `invoke` receives {success, fail}. A late answer after the timeout (or
     * after a cancellation) is ignored: the step completes exactly once.
     */
    function runStep(step, invoke, stepOptions) {
      const options = stepOptions || {};
      const limit = timeoutFor(timeouts, step, options.timeoutMs);
      const started = Date.now();
      let settled = false;
      let lastPayload = null;
      let unsubscribe = null;
      const handle = {
        deadline: started + limit,
        timer: null,
        check: null,
      };
      return new Promise((resolve, reject) => {
        const finish = (kind, payload) => {
          if (settled) {
            record(step, StepLog.PHASES.INFO, Date.now() - started,
              `late ${kind} answer ignored: ${StepLog.detailText(payload)}`);
            return;
          }
          settled = true;
          if (handle.timer) {
            clearTimeout(handle.timer);
          }
          const index = active.indexOf(handle);
          if (index !== -1) {
            active.splice(index, 1);
          }
          if (unsubscribe) {
            try {
              unsubscribe();
            } catch (error) {
              // Nothing to do.
            }
          }
          const elapsed = Date.now() - started;
          if (kind === 'ok') {
            record(step, StepLog.PHASES.OK, elapsed, payload);
            resolve(payload);
            return;
          }
          if (kind === 'timeout') {
            record(step, StepLog.PHASES.TIMEOUT, elapsed, `no answer after ${limit}ms`);
            reject(timeoutError(step, elapsed, limit, lastPayload));
            return;
          }
          if (kind === 'cancel') {
            record(step, StepLog.PHASES.CANCELLED, elapsed, 'cancelled by the user');
            reject(cancelError(step, elapsed));
            return;
          }
          record(step, StepLog.PHASES.ERROR, elapsed, payload);
          reject(toError(payload));
        };
        // The deadline is checked in small steps: the privacy popup pauses
        // it, so a step that waits for the user is never timed out.
        handle.check = () => {
          if (settled) {
            return;
          }
          if (popupVisible) {
            handle.timer = setTimeout(handle.check, 200);
            return;
          }
          const remaining = handle.deadline - Date.now();
          if (remaining <= 0) {
            finish('timeout');
            return;
          }
          handle.timer = setTimeout(handle.check, Math.min(200, remaining));
        };
        handle.timer = setTimeout(handle.check, Math.min(200, limit));
        active.push(handle);
        if (cancel && typeof cancel.onCancel === 'function') {
          unsubscribe = cancel.onCancel(() => finish('cancel'));
        }
        try {
          invoke({
            success: (value) => {
              lastPayload = value;
              finish('ok', value);
            },
            fail: (value) => {
              lastPayload = value;
              finish('fail', value);
            },
          });
        } catch (error) {
          lastPayload = error;
          finish('fail', error);
        }
      });
    }

    /**
     * The privacy popup pauses the timeouts: the user has to read the guide
     * and to tap a button, and that time must not be charged to the step.
     */
    function attachPrivacy(privacy) {
      if (!privacy || typeof privacy.subscribe !== 'function') {
        return;
      }
      unsubscribeGuard = privacy.subscribe((current) => {
        const visible = !!(current && current.visible);
        if (visible && !popupVisible) {
          popupVisible = true;
          popupSince = Date.now();
          return;
        }
        if (!visible && popupVisible) {
          popupVisible = false;
          const paused = Date.now() - popupSince;
          active.forEach((handle) => {
            handle.deadline += paused;
          });
        }
      });
    }

    /** Release the observers of the export. */
    function dispose() {
      if (unsubscribeGuard) {
        try {
          unsubscribeGuard();
        } catch (error) {
          // Nothing to do.
        }
        unsubscribeGuard = null;
      }
    }

    return {
      settings,
      host,
      timeouts,
      log,
      cancel,
      isCancelled,
      record,
      runStep,
      attachPrivacy,
      dispose,
      setStage(stage) {
        state.stage = stage;
      },
      setAuthSetting(authSetting) {
        state.authSetting = authSetting || null;
      },
      get authSetting() {
        return state.authSetting;
      },
      get stage() {
        return state.stage;
      },
    };
  }

  // --- the save errors -----------------------------------------------------

  /**
   * The classification of a failed save.
   *
   * kind: 'cancelled' | 'privacy-not-declared' | 'privacy-denied' |
   *       'auth-denied' | 'failed'
   */
  function classifySaveError(error) {
    const raw = errorText(error);
    const errno = error && Number(error.errno);
    if (CANCEL_PATTERN.test(raw)) {
      return { kind: 'cancelled', raw };
    }
    if (PRIVACY_NOT_DECLARED_PATTERN.test(raw) || errno === 112) {
      return { kind: 'privacy-not-declared', raw };
    }
    if (PRIVACY_PATTERN.test(raw)) {
      return { kind: 'privacy-denied', raw };
    }
    if (AUTH_DENY_PATTERN.test(raw)) {
      return { kind: 'auth-denied', raw };
    }
    return { kind: 'failed', raw };
  }

  function saveMessage(kind) {
    switch (kind) {
      case 'cancelled':
        return '已取消保存。';
      case 'privacy-not-declared':
        return '相册接口未声明：请在 mp 后台「设置 → 服务内容声明 → 用户隐私保护指引」中声明「相册（仅写入）」后重试。';
      case 'privacy-denied':
        return '未同意隐私协议，无法保存到相册。';
      case 'auth-denied':
        return '没有相册权限，请在设置中允许保存到相册。';
      default:
        return '保存失败，请稍后重试。';
    }
  }

  function timeoutMessage(stage, error) {
    const elapsed = error && Number.isFinite(Number(error.elapsed))
      ? `${(Number(error.elapsed) / 1000).toFixed(1)} 秒`
      : '未知时间';
    switch (stage) {
      case 'permission':
      case 'privacy':
      case 'getSetting':
      case 'showModal':
      case 'openSetting':
        return `权限步骤超时（${elapsed} 未收到回调）。请重试；若仍失败，请在设置中允许「保存到相册」。`;
      case 'encode':
        return `编码图片超时（${elapsed} 未收到回调）。请重试。`;
      case 'save':
      case 'saveImageToPhotosAlbum':
        return `保存到相册超时（${elapsed} 未收到回调）。请重试；若仍失败，请在设置中允许「保存到相册」。`;
      default:
        return `导出超时（${elapsed} 未收到回调）。请重试。`;
    }
  }

  function normaliseSaveResult(result) {
    if (!result || result.ok !== false) {
      return { ok: true, kind: 'ok', message: '', raw: result || '' };
    }
    if (result.cancelled) {
      return { ok: false, kind: 'cancelled', message: result.message || saveMessage('cancelled'), raw: result.raw || '' };
    }
    if (result.privacyDenied) {
      return { ok: false, kind: 'privacy-denied', message: result.message || saveMessage('privacy-denied'), raw: result.raw || '' };
    }
    if (result.privacyNotDeclared) {
      return { ok: false, kind: 'privacy-not-declared', message: result.message || saveMessage('privacy-not-declared'), raw: result.raw || '' };
    }
    if (result.authDenied) {
      return { ok: false, kind: 'auth-denied', message: result.message || saveMessage('auth-denied'), raw: result.raw || '' };
    }
    return { ok: false, kind: 'failed', message: result.message || saveMessage('failed'), raw: result.raw || '' };
  }

  // --- permissions ---------------------------------------------------------

  /**
   * The privacy pre-flight.
   *
   * The host may provide a privacy adapter (the WeChat host binds it to
   * utils/privacy.js). It asks the platform whether the user still has to
   * agree with the privacy guide and, if so, shows the in-app popup. The
   * pre-flight never blocks forever: it has its own timeout.
   */
  async function runPrivacyPreFlight(context, adapter) {
    const privacy = adapter && adapter.privacy;
    if (!privacy || typeof privacy.ensureAuthorized !== 'function') {
      context.record('privacy', StepLog.PHASES.INFO, 0, 'no privacy adapter; the check is skipped');
      return { granted: true, reason: 'not-configured' };
    }
    try {
      const result = await context.runStep('privacy', (callbacks) => {
        const promise = privacy.ensureAuthorized({ reason: 'export' });
        if (promise && typeof promise.then === 'function') {
          promise.then(
            (value) => callbacks.success(value === undefined ? {} : value),
            (error) => callbacks.fail(error)
          );
        }
      });
      const value = result || {};
      const granted = value.granted !== false;
      context.record('privacy', StepLog.PHASES.OK, 0,
        `granted=${granted} reason=${value.reason || ''}`);
      return { granted, reason: value.reason || '', state: value.state || '' };
    } catch (error) {
      if (isCancelError(error)) {
        throw error;
      }
      if (isTimeoutError(error)) {
        return {
          granted: false,
          reason: 'timeout',
          error,
          message: timeoutMessage('privacy', error),
        };
      }
      context.record('privacy', StepLog.PHASES.ERROR, 0, errorText(error));
      return {
        granted: false,
        reason: 'error',
        error,
        message: `隐私授权检查失败：${errorText(error)}`,
      };
    }
  }

  /**
   * The album permission flow.
   *
   *   privacy   -> the privacy guide must be accepted (see utils/privacy.js);
   *   hint      -> `wx.getSetting` is only a hint: it never blocks the
   *                export and it never asks for the permission;
   *   denied    -> a modal explains the need, then `wx.openSetting` opens the
   *                settings; the export continues when the scope is granted.
   *
   * `wx.authorize` is deliberately **not** called: it is a privacy scoped
   * interface itself («相册（仅写入）»), and the platform recommends to call
   * the target interface and to handle its authorisation error.
   */
  async function ensureAlbumPermission(host, options) {
    const settings = options || {};
    const adapter = host || {};
    const context = settings.context || createContext(Object.assign({}, settings, { host: adapter }));
    const privacy = await runPrivacyPreFlight(context, adapter);
    if (!privacy.granted) {
      return {
        granted: false,
        state: privacy.reason === 'timeout' ? 'timeout' : 'privacy-denied',
        message: privacy.message || '未同意隐私协议，无法保存到相册。',
      };
    }

    // The hint: it may be slow or may never answer, and it must not block.
    let scope = undefined;
    try {
      const result = await context.runStep('getSetting', (callbacks) => {
        adapter.getSetting({
          success: callbacks.success,
          fail: callbacks.fail,
        });
      }, { timeoutMs: settings.hintTimeoutMs });
      const authSetting = result && result.authSetting ? result.authSetting : {};
      scope = authSetting[ALBUM_SCOPE];
      context.setAuthSetting(authSetting);
      context.record('getSetting', StepLog.PHASES.OK, 0, `scope=${String(scope)}`);
    } catch (error) {
      if (isCancelError(error)) {
        throw error;
      }
      scope = undefined;
      context.record('getSetting', StepLog.PHASES.INFO, 0,
        `the hint was ignored: ${errorText(error)}`);
    }

    if (scope === false) {
      // The album scope was refused before: explain it and offer the settings.
      const recovered = await openAlbumSettings(context, adapter);
      if (!recovered.granted) {
        return {
          granted: false,
          state: recovered.state,
          message: recovered.message,
        };
      }
      return { granted: true, state: 'authorized', message: '' };
    }

    return {
      granted: true,
      state: scope === true ? 'authorized' : 'unknown',
      message: '',
    };
  }

  /**
   * The modal plus `wx.openSetting`: the recovery of a refused album scope.
   */
  async function openAlbumSettings(context, adapter) {
    const settings = adapter || {};
    let confirmed = false;
    try {
      const modal = await context.runStep('showModal', (callbacks) => {
        settings.showModal({
          title: '需要相册权限',
          content: '保存到相册需要「保存到相册」权限。是否前往设置开启？',
          confirmText: '去设置',
          cancelText: '取消',
          showCancel: true,
          success: callbacks.success,
          fail: callbacks.fail,
        });
      });
      confirmed = !!(modal && modal.confirm);
    } catch (error) {
      if (isCancelError(error)) {
        throw error;
      }
      confirmed = false;
      context.record('showModal', StepLog.PHASES.INFO, 0,
        `the modal failed: ${errorText(error)}`);
    }
    if (!confirmed) {
      return { granted: false, state: 'cancelled', message: '已取消保存。' };
    }
    let after = undefined;
    try {
      const opened = await context.runStep('openSetting', (callbacks) => {
        settings.openSetting({
          success: callbacks.success,
          fail: callbacks.fail,
        });
      });
      const authSetting = opened && opened.authSetting ? opened.authSetting : {};
      after = authSetting[ALBUM_SCOPE];
    } catch (error) {
      if (isCancelError(error)) {
        throw error;
      }
      after = undefined;
      context.record('openSetting', StepLog.PHASES.ERROR, 0, errorText(error));
    }
    if (after === true) {
      return { granted: true, state: 'authorized', message: '' };
    }
    return {
      granted: false,
      state: 'denied',
      message: '请在设置中开启「保存到相册」权限后再试。',
    };
  }

  /**
   * The save step of the plain helper: it maps the WeChat errors to the
   * Chinese messages and never throws.
   */
  async function saveToAlbum(host, filePath, options) {
    const settings = options || {};
    const adapter = host || {};
    const context = settings.context || createContext(Object.assign({}, settings, { host: adapter }));
    try {
      await context.runStep('saveImageToPhotosAlbum', (callbacks) => {
        adapter.saveImageToPhotosAlbum({
          filePath,
          success: callbacks.success,
          fail: callbacks.fail,
        });
      });
      return { ok: true, message: '' };
    } catch (error) {
      if (isCancelError(error)) {
        throw error;
      }
      if (isTimeoutError(error)) {
        return {
          ok: false,
          timeout: true,
          message: timeoutMessage('saveImageToPhotosAlbum', error),
          raw: error.raw,
        };
      }
      const kind = classifySaveError(error);
      return {
        ok: false,
        cancelled: kind.kind === 'cancelled',
        authDenied: kind.kind === 'auth-denied',
        privacyDenied: kind.kind === 'privacy-denied',
        privacyNotDeclared: kind.kind === 'privacy-not-declared',
        message: saveMessage(kind.kind),
        raw: kind.raw,
      };
    }
  }

  // --- progress ------------------------------------------------------------

  function stageText(stage, detail) {
    const info = detail || {};
    switch (stage) {
      case 'permission':
        return '检查相册权限…';
      case 'decode':
        return `解码原图 ${info.width}×${info.height}…`;
      case 'render':
        return `渲染 ${info.index}/${info.total}…`;
      case 'encode':
        return '编码 JPEG…';
      case 'save':
        return '保存到相册…';
      default:
        return '';
    }
  }

  function progressFraction(stage, detail) {
    const info = detail || {};
    switch (stage) {
      case 'permission':
        return 2;
      case 'decode':
        return 10;
      case 'render':
        return 10 + Math.round((info.index / Math.max(1, info.total)) * 70);
      case 'encode':
        return 88;
      case 'save':
        return 96;
      default:
        return 0;
    }
  }

  // --- the orchestrator -----------------------------------------------------

  /**
   * The export pipeline.
   *
   * The host adapters are:
   *   getImageInfo(src)                       -> { width, height, orientation }
   *        (the host must report the ORIENTED size of the decoded Image, so
   *         the plan matches the pixels that will be rendered)
   *   decodeImage({src, width, height})       -> { canvas }
   *   createRenderer({...})                   -> renderer
   *   createAssemblyCanvas(width, height)     -> 2D canvas
   *   drawTile(canvas, tile, pixels)          -> void
   *   encode(canvas, {quality})               -> file path
   *   save(filePath)                          -> { ok, ... }
   *   yield()                                 -> a macrotask
   *   permission                              -> the wx-like permission host
   *        (getSetting, openSetting, showModal, saveImageToPhotosAlbum and
   *         the optional privacy adapter)
   */
  async function exportImage(options) {
    const settings = options || {};
    const host = settings.host;
    if (!host) {
      throw new Error('An export host is required');
    }
    const context = createContext(settings);
    const isCancelled = context.isCancelled;
    // The privacy popup pauses the timeouts of the running steps.
    const privacyAdapter = host.permission && host.permission.privacy;
    if (privacyAdapter && typeof privacyAdapter.subscribe === 'function') {
      context.attachPrivacy(privacyAdapter);
    }
    const report = (stage, detail) => {
      context.setStage(stage);
      if (typeof settings.onProgress !== 'function') {
        return;
      }
      const info = detail || {};
      settings.onProgress({
        stage,
        text: stageText(stage, info),
        progress: progressFraction(stage, info),
        detail: info,
      });
    };
    const cleanup = async (state) => {
      if (state && typeof state.release === 'function') {
        try {
          await state.release();
        } catch (error) {
          // Releasing the buffers must never mask the real result.
        }
      }
    };
    const fail = (message, stage, extra) => {
      const result = Object.assign({
        ok: false,
        cancelled: false,
        message,
        stage: stage || context.stage,
        authSetting: context.authSetting,
        steps: context.log.entries(),
      }, extra || {});
      return result;
    };

    try {
      report('permission', {});
      const permission = await ensureAlbumPermission(host.permission || host, {
        context,
        host,
        timeouts: settings.timeouts,
        hintTimeoutMs: settings.hintTimeoutMs,
      });
      if (!permission.granted) {
        return fail(permission.message, 'permission', {
          cancelled: permission.state === 'cancelled',
          timeout: permission.state === 'timeout',
        });
      }

      const info = await context.runStep('getImageInfo', (callbacks) => {
        const promise = host.getImageInfo(settings.src);
        if (promise && typeof promise.then === 'function') {
          promise.then(callbacks.success, callbacks.fail);
        }
      });

      const plan = planExport({
        sourceWidth: info.width,
        sourceHeight: info.height,
        maxTextureSize: settings.maxTextureSize,
        maxLongEdge: settings.maxLongEdge,
        tileSize: settings.tileSize,
        stockId: settings.stockId,
        halationStrength: settings.halationStrength,
      });

      report('decode', { width: plan.width, height: plan.height });
      const decoded = await context.runStep('decode', (callbacks) => {
        const promise = host.decodeImage({
          src: settings.src,
          width: plan.width,
          height: plan.height,
          orientation: info.orientation,
        });
        if (promise && typeof promise.then === 'function') {
          promise.then(callbacks.success, callbacks.fail);
        }
      });

      const renderer = await context.runStep('createRenderer', (callbacks) => {
        const promise = host.createRenderer({
          photo: decoded,
          stockId: settings.stockId,
          adjustments: settings.adjustments,
          effects: settings.effects,
        });
        if (promise && typeof promise.then === 'function') {
          promise.then(callbacks.success, callbacks.fail);
        }
      });
      const assembly = host.createAssemblyCanvas(plan.width, plan.height);
      try {
        for (let index = 0; index < plan.tiles.length; index += 1) {
          if (isCancelled()) {
            await cleanup(renderer);
            return fail('已取消保存。', 'render', { cancelled: true });
          }
          const tile = plan.tiles[index];
          const result = renderer.renderRegionToPixels({
            width: tile.width,
            height: tile.height,
            target: tile.target,
            intensity: settings.intensity,
            adjustments: settings.adjustments,
            effects: settings.effects,
          });
          host.drawTile(assembly, tile, result.pixels);
          report('render', { index: index + 1, total: plan.tiles.length });
          if (typeof host.yield === 'function') {
            await host.yield();
          }
        }

        if (isCancelled()) {
          await cleanup(renderer);
          return fail('已取消保存。', 'render', { cancelled: true });
        }

        report('encode', {});
        const filePath = await context.runStep('encode', (callbacks) => {
          const promise = host.encode(assembly, {
            quality: settings.quality || EXPORT_JPEG_QUALITY,
          });
          if (promise && typeof promise.then === 'function') {
            promise.then(callbacks.success, callbacks.fail);
          }
        });

        report('save', {});
        let outcome = await performSave(context, host, filePath);
        if (!outcome.ok && outcome.kind === 'auth-denied') {
          // The album scope is not granted: the modal opens the settings and
          // the save is retried exactly once.
          const recovered = await openAlbumSettings(context, host.permission || {});
          if (recovered.granted) {
            outcome = await performSave(context, host, filePath);
          } else {
            outcome = {
              ok: false,
              kind: 'denied',
              message: recovered.message,
              raw: outcome.raw,
            };
          }
        }
        await cleanup(renderer);
        if (!outcome.ok) {
          return fail(outcome.message || '保存失败，请稍后重试。', 'save', {
            cancelled: outcome.kind === 'cancelled',
            timeout: outcome.kind === 'timeout',
            filePath,
            raw: outcome.raw,
          });
        }
        return {
          ok: true,
          filePath,
          plan,
          message: '',
          authSetting: context.authSetting,
          steps: context.log.entries(),
        };
      } catch (error) {
        await cleanup(renderer);
        throw error;
      }
    } catch (error) {
      if (isCancelError(error)) {
        return fail('已取消保存。', context.stage, { cancelled: true });
      }
      if (isTimeoutError(error)) {
        return fail(timeoutMessage(error.step || context.stage, error), error.step || context.stage, {
          timeout: true,
          raw: error.raw,
          elapsed: error.elapsed,
        });
      }
      throw error;
    } finally {
      context.dispose();
    }
  }

  /**
   * The save of one file: the host call, its timeout and the classification
   * of the WeChat errors.
   */
  async function performSave(context, host, filePath) {
    try {
      const result = await context.runStep('save', (callbacks) => {
        const promise = host.save(filePath);
        if (promise && typeof promise.then === 'function') {
          promise.then(
            (value) => callbacks.success(value === undefined ? {} : value),
            (error) => callbacks.fail(error)
          );
        }
      });
      return normaliseSaveResult(result);
    } catch (error) {
      if (isCancelError(error)) {
        throw error;
      }
      if (isTimeoutError(error)) {
        return {
          ok: false,
          kind: 'timeout',
          message: timeoutMessage('save', error),
          raw: error.raw,
        };
      }
      const kind = classifySaveError(error);
      return {
        ok: false,
        kind: kind.kind,
        message: saveMessage(kind.kind),
        raw: kind.raw,
      };
    }
  }

  return {
    EXPORT_MAX_LONG_EDGE,
    EXPORT_TILE_SIZE,
    EXPORT_JPEG_QUALITY,
    ALBUM_SCOPE,
    EXPORT_STAGES,
    DEFAULT_TIMEOUTS,
    computeExportSize,
    exportMargin,
    planTiles,
    buildTileTarget,
    planExport,
    createCancelSignal,
    createContext,
    classifySaveError,
    saveMessage,
    timeoutMessage,
    ensureAlbumPermission,
    openAlbumSettings,
    saveToAlbum,
    stageText,
    progressFraction,
    exportImage,
  };
}));
