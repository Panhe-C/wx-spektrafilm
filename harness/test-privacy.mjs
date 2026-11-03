// Unit tests for the privacy guard (utils/privacy.js).
//
// The guard is the part of the app that answers the privacy authorisation of
// the platform: it registers wx.onNeedPrivacyAuthorization once, shows the
// in-app popup and always resolves the pending interfaces, so that a privacy
// scoped call can never stay pending forever.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Privacy = require('../utils/privacy.js');

function createMockApi(options) {
  const settings = options || {};
  const api = {
    listener: null,
    calls: [],
    getPrivacySetting: (payload) => {
      api.calls.push('getPrivacySetting');
      if (settings.getPrivacySettingNeverAnswers) {
        return;
      }
      if (settings.getPrivacySettingFails) {
        setTimeout(() => payload.fail({ errMsg: 'getPrivacySetting:fail' }), 0);
        return;
      }
      setTimeout(() => payload.success({
        needAuthorization: settings.needAuthorization === true,
        privacyContractName: settings.privacyContractName || '《测试隐私保护指引》',
      }), 0);
    },
    onNeedPrivacyAuthorization: (listener) => {
      api.calls.push('onNeedPrivacyAuthorization');
      api.listener = listener;
    },
  };
  if (settings.supportsPrivacySetting === false) {
    delete api.getPrivacySetting;
  }
  if (settings.supportsListener === false) {
    delete api.onNeedPrivacyAuthorization;
  }
  return api;
}

// --- the listener is registered once ----------------------------------------

{
  const api = createMockApi({});
  const guard = Privacy.createPrivacyGuard({ api, timeoutMs: 50 });
  assert.equal(guard.install(), true);
  assert.equal(guard.install(), true, 'the listener must be registered only once');
  assert.deepEqual(api.calls, ['onNeedPrivacyAuthorization']);
  assert.equal(typeof api.listener, 'function');
  assert.equal(guard.state().installed, true);
}

{
  // An old base library has no privacy interface at all: the guard skips it.
  const api = createMockApi({ supportsPrivacySetting: false, supportsListener: false });
  const guard = Privacy.createPrivacyGuard({ api, timeoutMs: 50 });
  assert.equal(guard.install(), false);
  const setting = await guard.getSetting();
  assert.equal(setting.available, false);
  const consent = await guard.requestConsent({ reason: 'export' });
  assert.equal(consent.granted, true, 'the check must be skipped, not blocking');
  assert.equal(consent.reason, 'unsupported');
}

// --- the pending interface --------------------------------------------------

{
  // A privacy scoped interface stays pending until the guard resolves it.
  const api = createMockApi({ needAuthorization: true });
  const guard = Privacy.createPrivacyGuard({ api, timeoutMs: 50, consentTimeoutMs: 500 });
  guard.install();
  let view = null;
  guard.attach({ onChange: (next) => { view = next; } });

  let settled = null;
  const pending = new Promise((resolve) => { settled = resolve; });
  api.listener(settled, { referrer: 'saveImageToPhotosAlbum' });

  // The popup is shown and the interface is still pending.
  assert.ok(view);
  assert.equal(view.visible, true);
  // The name of the guide is read asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(view.name, '《测试隐私保护指引》');
  assert.equal(guard.state().needPrivacyFired, true);
  assert.equal(guard.state().referrer, 'saveImageToPhotosAlbum');
  let done = false;
  pending.then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(done, false, 'the interface must stay pending before the decision');

  // The 「同意」 button resolves it with the id of the button.
  guard.agree(Privacy.AGREE_BUTTON_ID);
  const result = await pending;
  assert.deepEqual(result, { buttonId: 'agree-btn', event: 'agree' });
  assert.equal(view.visible, false, 'the popup is closed again');
  assert.equal(guard.state().lastDecision, 'agree');
}

{
  // The refusal resolves the pending interface with "disagree".
  const api = createMockApi({ needAuthorization: true });
  const guard = Privacy.createPrivacyGuard({ api, timeoutMs: 50, consentTimeoutMs: 500 });
  guard.install();
  guard.attach({ onChange: () => {} });
  let settled = null;
  const pending = new Promise((resolve) => { settled = resolve; });
  api.listener(settled, { referrer: 'chooseMedia' });
  guard.refuse();
  assert.deepEqual(await pending, { event: 'disagree' });
  assert.equal(guard.state().lastDecision, 'disagree');
}

{
  // Without a page the pending interface is refused instead of hanging.
  const api = createMockApi({ needAuthorization: true });
  const guard = Privacy.createPrivacyGuard({ api, timeoutMs: 50, consentTimeoutMs: 500 });
  guard.install();
  let settled = null;
  const pending = new Promise((resolve) => { settled = resolve; });
  api.listener(settled, { referrer: 'chooseMedia' });
  assert.deepEqual(await pending, { event: 'disagree' });
}

// --- the pre-flight ---------------------------------------------------------

{
  // The user agrees: the export may continue.
  const api = createMockApi({ needAuthorization: true });
  const guard = Privacy.createPrivacyGuard({ api, timeoutMs: 50, consentTimeoutMs: 500 });
  guard.install();
  let view = null;
  guard.attach({ onChange: (next) => { view = next; } });
  const pending = guard.requestConsent({ reason: 'export' });
  // The setting is read first, then the popup is shown.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(view.visible, true, 'the popup is shown before the export continues');
  guard.agree(Privacy.AGREE_BUTTON_ID);
  const result = await pending;
  assert.equal(result.granted, true);
  assert.equal(result.reason, 'agreed');
}

{
  // The user refuses: the export stops with a clear reason.
  const api = createMockApi({ needAuthorization: true });
  const guard = Privacy.createPrivacyGuard({ api, timeoutMs: 50, consentTimeoutMs: 500 });
  guard.install();
  guard.attach({ onChange: () => {} });
  const pending = guard.requestConsent({ reason: 'export' });
  // The user can only refuse once the popup is visible.
  await new Promise((resolve) => setTimeout(resolve, 5));
  guard.refuse();
  const result = await pending;
  assert.equal(result.granted, false);
  assert.equal(result.reason, 'refused');
}

{
  // Nobody answers the popup: the pre-flight times out instead of hanging.
  const api = createMockApi({ needAuthorization: true });
  const guard = Privacy.createPrivacyGuard({ api, timeoutMs: 50, consentTimeoutMs: 40 });
  guard.install();
  guard.attach({ onChange: () => {} });
  const result = await guard.requestConsent({ reason: 'export' });
  assert.equal(result.granted, false);
  assert.equal(result.reason, 'timeout');
}

{
  // The guide was already accepted: the pre-flight does not show the popup.
  const api = createMockApi({ needAuthorization: false });
  const guard = Privacy.createPrivacyGuard({ api, timeoutMs: 50 });
  guard.install();
  let shown = false;
  guard.attach({ onChange: (view) => { shown = shown || view.visible; } });
  const result = await guard.requestConsent({ reason: 'export' });
  assert.equal(result.granted, true);
  assert.equal(result.reason, 'already-agreed');
  assert.equal(shown, false);
}

{
  // A getPrivacySetting that never answers is skipped, not waited for.
  const api = createMockApi({ getPrivacySettingNeverAnswers: true });
  const guard = Privacy.createPrivacyGuard({ api, timeoutMs: 40 });
  guard.install();
  guard.attach({ onChange: () => {} });
  const started = Date.now();
  const result = await guard.requestConsent({ reason: 'export' });
  const elapsed = Date.now() - started;
  assert.equal(result.granted, true);
  assert.equal(result.reason, 'unsupported');
  assert.ok(elapsed < 1000, `the pre-flight blocked for ${elapsed}ms`);
}

{
  // A failing getPrivacySetting is skipped as well.
  const api = createMockApi({ getPrivacySettingFails: true });
  const guard = Privacy.createPrivacyGuard({ api, timeoutMs: 40 });
  guard.install();
  guard.attach({ onChange: () => {} });
  const result = await guard.requestConsent({ reason: 'export' });
  assert.equal(result.granted, true);
  assert.equal(result.reason, 'unsupported');
  assert.ok(guard.state().lastError.length > 0);
}

// --- the state --------------------------------------------------------------

{
  const api = createMockApi({ needAuthorization: true, privacyContractName: '《隐私》' });
  const guard = Privacy.createPrivacyGuard({ api, timeoutMs: 50, consentTimeoutMs: 500 });
  guard.install();
  guard.attach({ onChange: () => {} });
  await guard.getSetting();
  const state = guard.state();
  assert.equal(state.setting.available, true);
  assert.equal(state.setting.needAuthorization, true);
  assert.equal(state.setting.privacyContractName, '《隐私》');
  assert.equal(state.installed, true);
  assert.equal(state.needPrivacyFired, false);
}

console.log(
  'Privacy guard tests: PASS (listener registered once, pending interfaces are ' +
  'always resolved, pre-flight (agree/refuse/timeout/already-agreed), old base ' +
  'library, no page attached)'
);
