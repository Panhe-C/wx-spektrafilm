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

- the 用户隐私保护指引 (privacy policy) in the WeChat console, listing the
  data the app touches (the photo the user picks, the album the export is
  written to);
- the privacy authorisation API: `wx.onNeedPrivacyAuthorization` and
  `wx.requirePrivacyAuthorize` for `wx.chooseMedia` and
  `wx.saveImageToPhotosAlbum`;
- the 「隐私保护指引」 entry in the 「关于」 section;
- a check that the app does not collect, store or transmit any data.

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
- the **export**: the album permission flow, the progress, the cancel, the
  saved file size and its look, and the memory peak on a low-end phone;
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
