// The WeChat privacy authorisation guard.
//
// Why this module exists
// ----------------------
// Since 2023-10-17 the privacy check of the platform is enabled for every
// Mini Program, with or without the legacy `__usePrivacyCheck__` flag in
// app.json (see the official 《小程序隐私协议开发指南》:
// https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/PrivacyAuthorize.html).
// Every privacy scoped interface — and `wx.authorize({scope:'scope.writePhotosAlbum'})`
// and `wx.saveImageToPhotosAlbum` are both scoped to 「相册（仅写入）」 — stays
// *pending* until the user agrees with the privacy guide. Without a
// `wx.onNeedPrivacyAuthorization` listener the platform shows its own popup,
// and a pending call that nobody answers never calls back: the export then
// hangs forever on 「检查相册权限…」.
//
// The guard therefore
//   * registers `wx.onNeedPrivacyAuthorization` once, as early as possible
//     (app.js onLaunch), and remembers the `resolve` callback plus the
//     event info;
//   * asks the page to show its own privacy popup, whose 「同意」 button is a
//     real `<button open-type="agreePrivacyAuthorization">`, so the platform
//     can verify that the user really tapped it;
//   * resolves the pending callback with {buttonId, event:'agree'} or
//     {event:'disagree'} — it always resolves, because a registered
//     listener that never resolves would create the very hang it prevents;
//   * offers a pre-flight (`wx.getPrivacySetting`) so that the popup is
//     shown *before* the first privacy scoped call.
(function registerPrivacy(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SpektrafilmPrivacy = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function privacyFactory() {
  const PREFIX = '[wx-spektrafilm][privacy]';
  // The id of the 「同意」 button. The platform checks that the button with
  // this id was really tapped before it accepts the agreement.
  const AGREE_BUTTON_ID = 'agree-btn';
  const DEFAULT_TIMEOUT_MS = 8000;
  // The popup waits for a human: after this time the request is refused, so
  // that a pending interface can never stay pending forever.
  const DEFAULT_CONSENT_TIMEOUT_MS = 30000;

  const STATES = Object.freeze({
    HIDDEN: 'hidden',
    NEED_CONSENT: 'need-consent',
    AGREED: 'agreed',
    REFUSED: 'refused',
    UNAVAILABLE: 'unavailable',
    ERROR: 'error',
  });

  function errorText(error) {
    return String((error && (error.errMsg || error.message)) || error || 'unknown');
  }

  /**
   * The privacy guard.
   *
   * options.api        the wx-like API object (the real `wx` by default);
   * options.timeoutMs  the timeout of `wx.getPrivacySetting` (8 s);
   * options.log        the console-like logger.
   */
  function createPrivacyGuard(options) {
    const settings = options || {};
    const api = settings.api !== undefined
      ? settings.api
      : (typeof wx !== 'undefined' ? wx : null);
    const timeoutMs = Number(settings.timeoutMs) > 0
      ? Number(settings.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
    const consentTimeoutMs = Number(settings.consentTimeoutMs) > 0
      ? Number(settings.consentTimeoutMs)
      : DEFAULT_CONSENT_TIMEOUT_MS;
    const logger = settings.log || (typeof console !== 'undefined' ? console : null);

    let installed = false;
    let ui = null;
    // The observers of the popup state (the export pauses its timeouts while
    // the popup waits for the user).
    const subscribers = [];
    // The resolve callbacks of the pending privacy interfaces.
    const pending = [];
    let pendingEvent = null;
    let needPrivacyFired = false;
    let needPrivacyCount = 0;
    let lastDecision = '';
    let lastError = '';
    let popupVisible = false;
    let setting = {
      available: false,
      needAuthorization: false,
      privacyContractName: '',
      error: '',
    };
    // The resolvers of the pending requestConsent() calls.
    const waiters = [];

    function write(level, message, detail) {
      if (!logger) {
        return;
      }
      const text = `${PREFIX} ${message}`;
      const method = level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'log');
      if (typeof logger[method] === 'function') {
        if (detail === undefined) {
          logger[method](text);
        } else {
          logger[method](text, detail);
        }
      }
    }

    // The view the page renders: the popup and its texts.
    function view() {
      return {
        visible: popupVisible,
        state: popupVisible ? STATES.NEED_CONSENT : STATES.HIDDEN,
        name: setting.privacyContractName || '',
        title: '隐私保护指引',
        body: '本应用需要访问你选择的照片，并把导出的照片写入你的相册。'
          + '我们不会上传、存储或分享任何数据。',
        note: setting.error
          ? `隐私状态读取失败（${setting.error}），已跳过隐私检查。`
          : '',
      };
    }

    function notify() {
      const current = view();
      if (ui && typeof ui.onChange === 'function') {
        try {
          ui.onChange(current);
        } catch (error) {
          write('error', 'the privacy view could not be updated', error);
        }
      }
      subscribers.slice().forEach((listener) => {
        try {
          listener(current);
        } catch (error) {
          write('error', 'a privacy observer failed', error);
        }
      });
    }

    /** Observe the popup state. The returned function unsubscribes. */
    function subscribe(listener) {
      if (typeof listener !== 'function') {
        return () => {};
      }
      subscribers.push(listener);
      return () => {
        const index = subscribers.indexOf(listener);
        if (index !== -1) {
          subscribers.splice(index, 1);
        }
      };
    }

    function showPopup() {
      popupVisible = true;
      write('log', 'the privacy popup is shown');
      notify();
      if (!setting.available && !setting.error) {
        // The name of the guide is only known after the setting was read.
        getSetting().then(() => notify(), () => null);
      }
    }

    function hidePopup() {
      popupVisible = false;
      notify();
    }

    // Every pending privacy interface is answered with the same decision.
    function settlePending(result) {
      const list = pending.splice(0, pending.length);
      list.forEach((resolve) => {
        try {
          resolve(result);
        } catch (error) {
          write('error', 'the privacy resolve failed', error);
        }
      });
    }

    function resolveWaiters(result) {
      const list = waiters.splice(0, waiters.length);
      list.forEach((waiter) => {
        if (waiter.timer) {
          clearTimeout(waiter.timer);
        }
        waiter.resolve(result);
      });
    }

    /**
     * The `wx.onNeedPrivacyAuthorization` listener.
     *
     * The interfaces that triggered the event stay pending until `resolve`
     * is called, so the decision of the user is forwarded immediately.
     */
    function handleNeedPrivacy(resolve, eventInfo) {
      needPrivacyFired = true;
      needPrivacyCount += 1;
      pendingEvent = eventInfo || null;
      write('log', 'onNeedPrivacyAuthorization', eventInfo ? eventInfo.referrer : '');
      if (typeof resolve === 'function') {
        pending.push(resolve);
      }
      if (!ui) {
        // Nobody can show the popup: refuse instead of leaving the
        // interface pending forever.
        write('warn', 'no page is attached; the privacy request is refused');
        settlePending({ event: 'disagree' });
        return;
      }
      showPopup();
    }

    /** Register the listener. It is registered only once. */
    function install() {
      if (installed) {
        return true;
      }
      if (!api || typeof api.onNeedPrivacyAuthorization !== 'function') {
        write('warn', 'wx.onNeedPrivacyAuthorization is not available (base library < 2.32.3)');
        return false;
      }
      try {
        api.onNeedPrivacyAuthorization(handleNeedPrivacy);
        installed = true;
        write('log', 'wx.onNeedPrivacyAuthorization registered');
      } catch (error) {
        lastError = errorText(error);
        write('error', 'wx.onNeedPrivacyAuthorization could not be registered', error);
      }
      return installed;
    }

    /** The page attaches its view: { onChange(view) }. */
    function attach(view) {
      ui = view || null;
      if (ui && pending.length) {
        // A privacy interface is already waiting for the user.
        showPopup();
      }
      notify();
      return ui;
    }

    function detach() {
      ui = null;
    }

    /**
     * `wx.getPrivacySetting` with a timeout.
     *
     * The result is {available, needAuthorization, privacyContractName, error}.
     * `available` is false when the base library does not know the interface
     * or when the call did not answer in time: the caller then skips the
     * privacy pre-flight instead of blocking the export.
     */
    function getSetting() {
      return new Promise((resolve) => {
        if (!api || typeof api.getPrivacySetting !== 'function') {
          setting = {
            available: false,
            needAuthorization: false,
            privacyContractName: '',
            error: 'unsupported',
          };
          write('warn', 'wx.getPrivacySetting is not available (base library < 2.32.3)');
          resolve(setting);
          return;
        }
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          lastError = 'getPrivacySetting timeout';
          setting = {
            available: false,
            needAuthorization: false,
            privacyContractName: '',
            error: 'timeout',
          };
          write('error', 'wx.getPrivacySetting did not answer in time');
          resolve(setting);
        }, timeoutMs);
        const finish = (result) => {
          if (settled) {
            write('warn', 'a late getPrivacySetting answer was ignored', result);
            return;
          }
          settled = true;
          clearTimeout(timer);
          setting = result;
          resolve(result);
        };
        try {
          api.getPrivacySetting({
            success: (res) => finish({
              available: true,
              needAuthorization: !!(res && res.needAuthorization),
              privacyContractName: (res && res.privacyContractName) || '',
              error: '',
            }),
            fail: (error) => {
              lastError = errorText(error);
              finish({
                available: false,
                needAuthorization: false,
                privacyContractName: '',
                error: lastError,
              });
            },
          });
        } catch (error) {
          lastError = errorText(error);
          finish({
            available: false,
            needAuthorization: false,
            privacyContractName: '',
            error: lastError,
          });
        }
      });
    }

    /**
     * The pre-flight: make sure the user agreed with the privacy guide.
     *
     * The result is {granted, reason, state}:
     *   granted=true, reason='unsupported'  the base library is too old;
     *   granted=true, reason='agreed'       the user agreed earlier;
     *   granted=true, reason='agreed'       the user agreed just now;
     *   granted=false, reason='refused'     the user refused;
     *   granted=false, reason='timeout'     nobody answered the popup.
     */
    function requestConsent(options) {
      const requestOptions = options || {};
      return getSetting().then((result) => {
        if (!result.available) {
          return {
            granted: true,
            reason: 'unsupported',
            state: STATES.UNAVAILABLE,
            detail: result.error || '',
          };
        }
        if (!result.needAuthorization) {
          return {
            granted: true,
            reason: 'already-agreed',
            state: STATES.AGREED,
            detail: '',
          };
        }
        if (!ui) {
          write('warn', 'no page is attached; the privacy pre-flight is skipped');
          return {
            granted: true,
            reason: 'unsupported',
            state: STATES.UNAVAILABLE,
            detail: 'no page',
          };
        }
        showPopup();
        return new Promise((resolve) => {
          const waiter = { resolve, timer: null };
          waiter.timer = setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) {
              waiters.splice(index, 1);
            }
            write('error', 'the privacy popup was not answered in time');
            resolve({
              granted: false,
              reason: 'timeout',
              state: STATES.ERROR,
              detail: `${consentTimeoutMs}ms`,
            });
          }, consentTimeoutMs);
          waiters.push(waiter);
          write('log', 'the privacy popup is waiting for the user', requestOptions.reason || '');
        });
      });
    }

    /** The 「同意」 button was tapped: the platform expects this id. */
    function agree(buttonId) {
      const id = buttonId || AGREE_BUTTON_ID;
      lastDecision = 'agree';
      write('log', 'the user agreed with the privacy guide', id);
      settlePending({ buttonId: id, event: 'agree' });
      hidePopup();
      resolveWaiters({ granted: true, reason: 'agreed', state: STATES.AGREED, detail: id });
      return true;
    }

    /** The 「拒绝」 button was tapped. */
    function refuse() {
      lastDecision = 'disagree';
      write('log', 'the user refused the privacy guide');
      settlePending({ event: 'disagree' });
      hidePopup();
      resolveWaiters({ granted: false, reason: 'refused', state: STATES.REFUSED, detail: '' });
      return true;
    }

    /** The diagnostics snapshot. */
    function state() {
      return {
        installed,
        needPrivacyFired,
        needPrivacyCount,
        pendingCount: pending.length,
        popupVisible,
        lastDecision,
        lastError,
        referrer: pendingEvent && pendingEvent.referrer ? pendingEvent.referrer : '',
        setting: {
          available: setting.available,
          needAuthorization: setting.needAuthorization,
          privacyContractName: setting.privacyContractName,
          error: setting.error,
        },
      };
    }

    return {
      STATES,
      AGREE_BUTTON_ID,
      install,
      attach,
      detach,
      subscribe,
      getSetting,
      requestConsent,
      agree,
      refuse,
      state,
      view,
      handleNeedPrivacy,
    };
  }

  let singleton = null;

  /** The application wide guard (app.js installs it, the page renders it). */
  function getPrivacyGuard(options) {
    if (!singleton) {
      singleton = createPrivacyGuard(options || {});
    }
    return singleton;
  }

  function resetPrivacyGuard() {
    singleton = null;
  }

  return {
    PREFIX,
    STATES,
    AGREE_BUTTON_ID,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_CONSENT_TIMEOUT_MS,
    createPrivacyGuard,
    getPrivacyGuard,
    resetPrivacyGuard,
  };
}));
