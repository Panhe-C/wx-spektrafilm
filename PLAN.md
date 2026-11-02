# wx-spektrafilm — Plan

A WeChat Mini Program (native, JS/WXML/WXSS) for film-emulation of phone photos, using
pre-baked 3D LUTs generated from [spektrafilm](https://github.com/andreavolpato/spektrafilm)
and applied on-device via WebGL. No backend. License: GPLv3.

## Phase 0 — Scaffold & compliance
Tasks:
1. Native Mini Program scaffold at repo root: `app.js`, `app.json`, `app.wxss`,
   `project.config.json` (appid `"touristappid"`, `miniprogramRoot` = "./", compileType "miniprogram",
   `libVersion` "latest", `setting.urlCheck` false), `project.private.config.json` NOT needed,
   `sitemap.json`, `pages/index/index.{js,json,wxml,wxss}` (simple placeholder page: title,
   "choose photo" button stub).
2. `LICENSE`: full, unmodified GPLv3 text (fetch from https://www.gnu.org/licenses/gpl-3.0.txt with curl).
3. `README.md`: project description; attribution line exactly "Film modeling powered by spektrafilm"
   with link https://github.com/andreavolpato/spektrafilm; note that LUT/profile data derived from
   spektrafilm are CC BY-SA 4.0 (Andrea Volpato) — see https://github.com/andreavolpato/spektrafilm/blob/main/SPEKTRAFILM_LICENSE.txt ;
   GPLv3 for this project's code; dev instructions (open in WeChat DevTools, touristappid).
4. `AGENTS.md`: project conventions (see below).
5. `.gitignore` (node_modules, .venv, build/, *.pyc, __pycache__, project.private.config.json, .DS_Store).
6. Directory placeholders: `tools/` (Python scripts), `docs/`, `assets/` (with `.gitkeep` where empty).

Acceptance criteria:
- Every `*.json` parses with `python3 -c "import json,sys;json.load(open(f))"`.
- `app.json` `pages` lists `pages/index/index` and each listed page has js/json/wxml/wxss files.
- project.config.json has `"appid": "touristappid"`.
- LICENSE is GPLv3 (starts with "GNU GENERAL PUBLIC LICENSE", Version 3, ~674 lines).
- README contains attribution line, spektrafilm link, CC BY-SA 4.0 note.
- No file larger than 100 KB in the repo.

## Phase 1 — LUT baking (see tools/)
(Spec added after Phase 0.)

## Later phases
2 pick & preview; 3 WebGL LUT renderer; 4 presets UI; 5 effects & export; 6 release.
(Server mode dropped: route A only.)
