# Release checklist (not implemented here)

Film modeling powered by [spektrafilm](https://github.com/andreavolpato/spektrafilm).

This file is a **list only**. Nothing in it is implemented in the repository;
it describes what a release of the Mini Program still needs. The items are
ordered the way a release normally goes.

## 1. Accounts and identity

- a real WeChat AppID (the repository ships the tourist appid and the
  `project.config.json` must be pointed at the real one);
- the developer account, the Mini Program registration and the category;
- the release version and the changelog text;
- the open-source licence note (GPLv3 for the code, CC BY-SA 4.0 for the
  LUT/profile data derived from spektrafilm) and the attribution to
  [spektrafilm](https://github.com/andreavolpato/spektrafilm) in the 「关于」
  section (already present) and in the release notes;
- the statement that the app has **no backend and uploads nothing**.

## 2. Privacy

The privacy authorisation is **implemented** in the app (`utils/privacy.js`,
the popup in `pages/index`, see `docs/PRIVACY.md`); what is missing is the
declaration in the WeChat console. Without it the platform refuses the
privacy scoped interfaces of the app.

In the WeChat console (<https://mp.weixin.qq.com>) of the release AppID:

- **设置 → 服务内容声明 → 用户隐私保护指引** has to be filled in and
  published (the guide must be approved by the platform):
  - **选中的照片或视频信息** — the photo the user picks for the preview
    (`wx.chooseMedia`); purpose: 「用于在设备本机对用户选择的照片进行胶片风格的调色预览」;
  - **摄像头** — only for the 「拍照」 button (`wx.chooseMedia` with
    `sourceType:['camera']`); purpose: 「用于拍摄用户主动选择的照片，并在设备本机进行胶片风格调色」;
  - **相册（仅写入）** — the exported picture (`wx.saveImageToPhotosAlbum`);
    purpose: 「用于将用户确认保存的调色结果写入系统相册」;
  - **相册（仅读取）** is *not* needed: the app never reads the album.
- the guide must be published and the new privacy types need about five
  minutes to take effect;
- the privacy authorisation API is in place: `wx.onNeedPrivacyAuthorization`
  (registered in `app.js`), `wx.getPrivacySetting` (the pre-flight),
  `wx.openPrivacyContract` (the 「查看隐私保护指引」 button) and
  `<button open-type="agreePrivacyAuthorization">` (the 「同意」 button of the
  in-app popup) — see `docs/PRIVACY.md`;
- the 「隐私保护指引」 entry in the 「关于」 section (already present);
- a check that the app does not collect, store or transmit any data.

For the **test AppID** (`wxa4be938db07a4bb4`, used for the preview and the
device tests) the same three privacy types have to be declared in its own
console account — the preview runs against the real state of that AppID, so
the privacy popup and the album write can only be tested after the guide of
that AppID is published. In the DevTools the state can be reset with
工具 → 清除缓存 → 清除授权数据 and simulated with
详情 → 本地设置 → 模拟隐私接口.

The plain-language version for the release owner:

> 1. Log in at <https://mp.weixin.qq.com> with the administrator of the
>    AppID.
> 2. Open 设置 → 服务内容声明 → 用户隐私保护指引.
> 3. Tick 「选中的照片或视频信息」, 「摄像头」 and 「相册（仅写入）」, write the
>    purpose of each one (the wording is in `docs/PRIVACY.md`), and publish
>    the guide.
> 4. Wait until the platform approved it (a new privacy type needs about
>    five minutes), then upload a new version.
> 5. On the phone the user sees the privacy popup the first time a photo is
>    picked or saved; tapping 「同意」 remembers the decision, 「拒绝」 aborts
>    the action. The album permission itself is asked by the system when the
>    first picture is written.

## 3. Store and review

- the service category (e.g. 工具 / 图片处理);
- the review materials: the screenshots, the feature description, the test
  account and the test instructions;
- the 「运营规范」 self-check (no ads, no payments, no social features, no
  user-generated content);
- the ICP filing, if the chosen category requires it.

## 4. Device verification

Everything in the checklists of `docs/UI.md` and `docs/LIMITATIONS.md` has to
be executed by hand on real phones:

- the preview, the EXIF orientation and the letterboxing;
- the preset cards, the thumbnails and their invalidation;
- the sliders, the press-and-hold comparison and the reset;
- the 「效果」 panel (grain, halation, vignette);
- the **export**: the privacy popup, the album permission flow, the
  progress, the cancel (also while a platform call is pending), the saved
  file size and its look, and the memory peak on a low-end phone;
- the diagnostics panel: the 「Export steps」 and the 「Privacy」 sections
  after a failed export;
- the share entries (the app message and the timeline);
- the package size reported by the WeChat DevTools upload.

## 5. Build and release

- a clean `npm test` in `harness/` (all green);
- `python3 tools/check_miniprogram.py` (static checks and the package sizes);
- `python3 tools/embed_shaders.py --check` (the committed GLSL module is
  current);
- the Mini Program package built by the WeChat DevTools: the main package
  below 2 MB, including all LUT assets (whose separate size is reported by
  the static checker);
- `miniprogram-ci` upload with the AppID and the private key (both are
  missing in the repository — the tool is intentionally skipped);
- the version bump in `utils/app-info.js` and in the changelog.
