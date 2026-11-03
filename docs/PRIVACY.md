# 隐私授权与相册保存（Privacy and the album write）

Film modeling powered by [spektrafilm](https://github.com/andreavolpato/spektrafilm).

This document explains why the export used to hang on 「检查相册权限…」, what
the platform actually requires, how the app implements it now, and what has
to be configured in the WeChat console before the app can be released.

## 1. The symptom

On a device (iPhone, WeChat, test AppID `wxa4be938db07a4bb4`) the export
stopped at the first step:

```text
保存到相册 → 检查相册权限…  (progress ≈ 1 %, forever)
```

Nothing after the `permission` stage ran: one of the `wx` permission calls
never called back, and the old code had no timeout around it, so the promise
of the step never settled. Only 「取消」 worked, because the cancel flag was
polled by the renderer loop — not by the pending call.

The old flow was:

```text
wx.getSetting → wx.authorize({scope:'scope.writePhotosAlbum'}) → wx.openSetting
```

`wx.authorize` is itself a **privacy scoped** interface: the official
mapping of the privacy types lists it under 「使用你的相册（仅写入）权限」
together with `wx.saveImageToPhotosAlbum`
(《小程序用户隐私保护指引内容介绍》,
<https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/miniprogram-intro.html>):

| 处理的信息 | 接口或组件 |
|---|---|
| 使用你的相册（仅写入）权限 | `wx.authorize({scope: 'scope.writePhotosAlbum'})`、`wx.saveImageToPhotosAlbum`、`wx.saveVideoToPhotosAlbum` |
| 收集你选中的照片或视频信息 | `wx.chooseImage`、`wx.chooseMedia`、`wx.chooseVideo` |
| 访问你的摄像头 | `wx.authorize({scope: 'scope.camera'})`、`<camera>`、`<live-pusher>`、`<voip-room>` |

## 2. What the platform does (official documentation)

All the statements below are taken from the official Mini Program
documentation; the links are the sources.

1. **The privacy check is always on.** Since 2023-10-17 the privacy
   functionality is enabled for every Mini Program, *with or without* the
   legacy `__usePrivacyCheck__` flag in `app.json`
   (《小程序隐私协议开发指南》,
   <https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/PrivacyAuthorize.html>):
   > 「在 2023年10月17日之后，不论 app.json 中是否有配置 `__usePrivacyCheck__`，
   > 隐私相关功能都会启用。」

2. **A privacy scoped call waits for the user.** `wx.onNeedPrivacyAuthorization`
   (<https://developers.weixin.qq.com/miniprogram/dev/api/open-api/privacy/wx.onNeedPrivacyAuthorization.html>):
   > 「当触发该事件时，触发该事件的隐私接口或组件会处于 pending 状态，
   > 等待用户授权后才会继续执行」

   and:
   > 「如果调用 resolve({ event: 'disagree' })，则触发当前
   > onNeedPrivacyAuthorization 事件的原隐私接口或组件会失败并返回
   > API:fail privacy permission is not authorized 的错误信息。」

   > 「wx.onNeedPrivacyAuthorization 是覆盖式注册监听，若重复注册监听，
   > 则只有最后一次注册会生效。」

   > 「但如果注册了 wx.onNeedPrivacyAuthorization 监听，则一定要调用 resolve 接口。」

3. **The consent must be a real tap.** The same page:
   > 「如果调用 resolve({ buttonId: 'agree-btn'， event:'agree' })，则触发当前
   > onNeedPrivacyAuthorization 事件的原隐私接口或组件会继续执行。其中 buttonId
   > 为隐私同意授权按钮的id，为确保用户有同意的操作，基础库会检查对应的同意按钮
   > 是否被点击过。」

   and the `<button>` component
   (<https://developers.weixin.qq.com/miniprogram/dev/component/button.html>):
   > `agreePrivacyAuthorization` — 用户同意隐私协议按钮。用户点击一次此按钮后，
   > 所有已声明过的隐私接口可以正常调用。（2.32.3 起）

   > `bind:agreeprivacyauthorization` — 用户同意隐私协议事件回调，
   > open-type=agreePrivacyAuthorization时有效（Tips: 如果使用
   > onNeedPrivacyAuthorization 接口，需要在 bind:agreeprivacyauthorization
   > 触发后再调用 `resolve({ event: "agree", buttonId })`）

4. **The pre-flight.** `wx.getPrivacySetting`
   (<https://developers.weixin.qq.com/miniprogram/dev/api/open-api/privacy/wx.getPrivacySetting.html>)
   returns `{ needAuthorization, privacyContractName }`:
   > 「如果开发者没有在「MP后台-设置-服务内容声明-用户隐私保护指引」中声明隐私收集类型
   > 则会返回false；如果开发者声明了隐私收集，且用户之前同意过隐私协议则会返回false；
   > 如果开发者声明了隐私收集，且用户还没同意过则返回true」

   The base library 2.32.3 is the minimum for `wx.getPrivacySetting`,
   `wx.onNeedPrivacyAuthorization`, `wx.requirePrivacyAuthorize` and
   `wx.openPrivacyContract`; below it the platform does not intercept the
   privacy interfaces at all.

5. **The contract page.** `wx.openPrivacyContract`
   (<https://developers.weixin.qq.com/miniprogram/dev/api/open-api/privacy/wx.openPrivacyContract.html>)
   opens the 《用户隐私保护指引》 page; it is optional, but recommended.

6. **Undeclared privacy types disable the interface.** Same guide:
   > 「仅有在指引中声明所处理的用户信息，才可以调用平台提供的对应接口或组件。
   > 若未声明，对应接口或组件将直接禁用。」

   and the error catalogue:
   > `{ "errMsg": "A:fail api scope is not declared in the privacy agreement", "errno": 112 }`
   > `{ "errMsg": "A:fail appid privacy api banned" }`

7. **The platform popup is only a fallback.** The guide describes the official
   privacy popup:
   > 「当开发者调用隐私相关接口时，微信会判断此次调用是否需要触发
   > wx.onNeedPrivacyAuthorization 事件，若触发后开发者未进行响应，微信将主动弹出官方弹窗。」

   The app must not rely on it: the popup can be suppressed (for example when
   the user refused it less than ten seconds ago, in which case the platform
   reports the refusal directly) and it never produces the *application's*
   own error message.

## 3. Root causes, ranked

| # | cause | evidence | fix |
|---|---|---|---|
| 1 | **The privacy authorisation was never handled.** `wx.authorize({scope:'scope.writePhotosAlbum'})` and `wx.saveImageToPhotosAlbum` are privacy scoped. Without a `wx.onNeedPrivacyAuthorization` listener the platform has to fall back to its own popup; when that popup does not answer, the call stays *pending* and the promise of the step never settles — exactly the observed hang. | `wx.onNeedPrivacyAuthorization`: 「触发该事件的隐私接口或组件会处于 pending 状态」; the privacy type table lists `wx.authorize({scope:'scope.writePhotosAlbum'})` and `wx.saveImageToPhotosAlbum` under 「相册（仅写入）」. | `utils/privacy.js` registers the listener in `app.js onLaunch`, shows the in-app popup and **always** resolves the pending callback. |
| 2 | **No timeout around the platform calls.** Any `wx` call that never calls back froze the whole export; the status text stayed on one step and only the polled cancel flag worked. | The old `callHost()` only knew `success`/`fail`; there was no timer and no `complete`. | Every call runs in a timeout wrapper (8 s by default) that reports the step, the elapsed time and the last raw answer, and ignores a late answer. |
| 3 | **`wx.authorize` was called outside the tap gesture and in the wrong order.** The authorisation modal was opened after an `await` chain (`getSetting` → `authorize`), and the scope was requested *before* the export instead of letting the target interface ask for it. | WeChat's guidance is to call the target interface and to handle its authorisation error; `wx.authorize` is itself privacy scoped, so it is the worst possible first call. | The export never calls `wx.authorize` any more. It calls `wx.saveImageToPhotosAlbum` directly and, on an auth-deny error, shows the modal → `wx.openSetting` → retries **once**. |
| 4 | **`wx.getSetting` was on the critical path.** A slow (or hanging) `getSetting` blocked the export before anything happened, and the user could not tell whether the app was working. | The old code awaited `getSetting` before the export started. | `wx.getSetting` is only a *hint* now: it has its own (short) timeout and the export continues when it does not answer. |
| 5 | **No diagnostics.** There was no way to see which call was pending. | — | Every step is logged (`[wx-spektrafilm][export]`) and the ring buffer is shown in the diagnostics panel under 「Export steps」, next to the privacy state. |

## 4. The flow

```text
app.js onLaunch ── Privacy.getPrivacyGuard().install()
                     └─ wx.onNeedPrivacyAuthorization(resolve, eventInfo)
                        → the guard stores resolve + eventInfo
                        → the page shows the in-app popup

保存到相册
  ├─ privacy pre-flight: wx.getPrivacySetting (8 s timeout)
  │     needAuthorization = true → the popup is shown
  │        同意  → <button open-type="agreePrivacyAuthorization"> →
  │                resolve({buttonId:'agree-btn', event:'agree'})
  │        拒绝  → resolve({event:'disagree'})
  │     the timeout of the step is *paused* while the popup is open
  ├─ hint: wx.getSetting (2.5 s timeout, never blocks)
  │     scope = false → wx.showModal → wx.openSetting → scope = true ?
  ├─ decode → render (per tile) → encode (wx.canvasToTempFilePath)
  └─ save: wx.saveImageToPhotosAlbum (15 s timeout)
        auth deny → wx.showModal → wx.openSetting → retry once
        privacy error / timeout / other → a message, a retry and 「打开设置」
```

### The in-app popup

The popup is a small dark panel (the theme of the app) with

* the title 「隐私保护指引」 and the name of the guide
  (`wx.getPrivacySetting().privacyContractName`),
* the text 「查看隐私保护指引」 → `wx.openPrivacyContract` (when the platform
  refuses to open it — for example because no guide is configured — the popup
  shows a clear note instead of failing silently),
* 「同意」 → `<button id="agree-btn" open-type="agreePrivacyAuthorization"
  bindagreeprivacyauthorization="onPrivacyAgree">`, and
* 「拒绝」 → `resolve({event:'disagree'})`.

The 「同意」 button has the id `agree-btn`, because the base library verifies
that the button with the id passed to `resolve()` was really tapped.

### The timeouts

| step | budget | on timeout |
|---|---|---|
| `wx.getPrivacySetting` | 8 s | the check is skipped (the passive path still works) |
| the popup (the consent) | 30 s | the request is refused, the interface fails with `privacy permission is not authorized` |
| `wx.getSetting` (the hint) | 2.5 s | ignored, the export continues |
| `wx.showModal`, `wx.openSetting` | 8 s | the recovery fails with a message |
| `wx.saveImageToPhotosAlbum` | 15 s | 「保存到相册超时…」 + retry + 「打开设置」 |
| `wx.canvasToTempFilePath` / the file write | 30 s | 「编码图片超时…」 + retry |
| `wx.getImageInfo`, the decode | 8 s / 20 s | the export stops with the step name and the elapsed time |

The budgets are configurable (`utils/export.js` → `DEFAULT_TIMEOUTS`, the host
exposes them as `host.timeouts`, and the unit suite injects tiny ones).

While the privacy popup is open the running step is **paused**: the time the
user needs to read the guide is not charged to the timeout, and the 「取消」
button keeps working.

A late answer (a callback that arrives after the timeout or after a
cancellation) is ignored — a step can never complete twice.

## 5. Decisions

### `__usePrivacyCheck__` is **not** set in `app.json`

*Evidence*: the official guide states that since 2023-10-17 the privacy
functionality is enabled regardless of the flag, and the flag is not part of
the current `app.json` reference any more
(<https://developers.weixin.qq.com/miniprogram/dev/reference/configuration/app.html>).
Consequences:

* the flag would be a no-op — adding it would not enable or disable anything;
* the privacy check is therefore **always active** in this app, also for the
  test AppID and in the DevTools, so the in-app popup and the timeouts are
  the paths that have to work;
* not declaring the privacy types in the console does **not** disable the
  privacy check: `wx.getPrivacySetting` then returns `needAuthorization:false`
  and the privacy scoped interfaces fail with `errno 112`
  (`api scope is not declared in the privacy agreement`). The app maps that
  error to a message that names the console page that has to be filled in.

### `wx.authorize` is not called

`wx.authorize({scope:'scope.writePhotosAlbum'})` is privacy scoped itself and
its modal is opened outside of a user gesture in this flow. The export calls
`wx.saveImageToPhotosAlbum` directly and handles the authorisation error
(modal → `wx.openSetting` → one retry), which is what the platform expects
and what keeps the number of system dialogs low.

### The app never leaves a privacy interface pending

`wx.onNeedPrivacyAuthorization` is registered **once** (the platform keeps only
the last registration) and the guard always answers it — with
`{buttonId, event:'agree'}` or `{event:'disagree'}`. If no page is attached
(the guard has no UI), the request is refused immediately instead of being
left pending.

### The privacy guard covers the photo picker too

`wx.chooseMedia` is privacy scoped (「收集你选中的照片或视频信息」 and, for the
camera, 「访问你的摄像头」). The page asks for the consent *before* the picker
opens (a real tap on 「同意」), and the passive listener is the safety net for
every other privacy scoped call. A refusal aborts the import with a clear
message — it never breaks the app.

## 6. What has to be configured in the WeChat console

Plain language: **before the app can be released, the owner of the AppID has
to fill in the privacy guide in the WeChat console, and the guide has to be
approved; without it the album write and the photo picker are refused by the
platform.**

1. Open <https://mp.weixin.qq.com> and log in with the administrator of the
   AppID.
2. Go to **设置 → 服务内容声明 → 用户隐私保护指引** (the "user privacy
   protection guide").
3. Fill in the purpose of every privacy type the app uses:
   * **选中的照片或视频信息** — the photo the user picks for the preview
     (`wx.chooseMedia`);
   * **摄像头** — only when the user picks 「拍照」 (`wx.chooseMedia` with
     `sourceType: ['camera']`);
   * **相册（仅写入）** — the exported picture that is written into the album
     (`wx.saveImageToPhotosAlbum`);
   * **相册（仅读取）** is **not** needed: the app never reads the album, it
     only writes one file.
4. Write the purpose in the wording of the platform:
   * 选中的照片或视频信息：「用于在设备本机对用户选择的照片进行胶片风格的调色预览」；
   * 摄像头：「用于拍摄用户主动选择的照片，并在设备本机进行胶片风格调色」；
   * 相册（仅写入）：「用于将用户确认保存的调色结果写入系统相册」。
5. Publish the guide (「发布」/「更新」) and wait for the approval; the
   platform says that a newly added privacy type needs about **five minutes**
   to take effect.
6. Fill in the other declarations of the console that the platform asks for
   (the privacy policy, the service category, the test account for the
   review).

### On the phone

* The user sees the platform's own privacy popup the first time a privacy
  scoped interface is used, and the app's own popup (with 「同意」 and
  「拒绝」).
* Tapping 「同意」 records the consent for the whole guide; it is asked again
  only when the guide gains a new privacy type.
* 「拒绝」 cancels the operation with a clear message; nothing is written to
  the album.
* The consent can be withdrawn: 微信 → 我 → 设置 → 隐私 → 授权管理 (or by
  deleting the Mini Program from 「微信 → 最近使用的小程序」, which clears the
  synchronisation state).
* For the album write the system permission (「保存到相册」) is separate: it
  is requested by the system when the first picture is written, and it can be
  changed in 设置 → 隐私 → 照片.

### In the DevTools

* The DevTools can simulate the platform: 详情 → 本地设置 → 「模拟隐私接口」
  (and 工具 → 清除缓存 → 清除授权数据 to reset the synchronisation state).
* A real device (预览/体验版) always uses the real state of the AppID, so the
  test AppID needs its own privacy guide — the console steps above are the
  same for every AppID.

## 7. Diagnostics

The 「关于 → 诊断」 panel contains two new sections:

* **Export steps** — the ring buffer of the export: every step with its
  phase (`start`, `ok`, `error`, `timeout`, `cancelled`), its elapsed time and
  the raw payload of the callback. The same lines are written to the console
  with the prefix `[wx-spektrafilm][export]`.
* **Privacy** — the state of the guard: whether the listener was installed,
  whether `onNeedPrivacyAuthorization` fired (and for which interface), the
  result of `wx.getPrivacySetting`, whether the popup is open, the last
  decision, the raw `authSetting` of `wx.getSetting` and the base library
  version (`wx.getSystemInfoSync().SDKVersion`).

The panel is copyable, so a bug report can carry the whole state of an
export that failed.

## 8. Verification

`harness/test-privacy.mjs` (pure, Node):

* the listener is registered once (the platform keeps the last registration);
* a privacy scoped interface stays pending until the guard resolves it, and
  the resolution carries the button id;
* the refusal resolves the pending interface with `{event:'disagree'}`;
* without a page the pending interface is refused instead of hanging;
* the pre-flight: agree, refuse, timeout, already agreed, old base library
  (the interfaces do not exist), a `getPrivacySetting` that never answers.

`harness/test-export.mjs` (pure, Node):

* the permission flow: the privacy pre-flight, the hint, the scope that was
  refused before (modal → settings), the cancellation;
* `wx.getSetting` that never answers (the export continues),
  `wx.authorize` that never answers (it is never called at all),
  `wx.saveImageToPhotosAlbum` that never answers (the step times out);
* the auth-deny recovery (modal → `wx.openSetting` → one retry) and the
  settings that keep refusing;
* a late answer after the timeout (ignored — the step completes once);
* the cancel while a call is pending and while the popup is open;
* the popup pauses the timeout of the running step.

`harness/test-page.mjs` and `harness/test-ui-state.mjs`:

* the states of the privacy popup and the export status texts;
* the page wiring: the popup is shown when the platform asks, 「同意」 resolves
  the pending interface, 「拒绝」 refuses it.
