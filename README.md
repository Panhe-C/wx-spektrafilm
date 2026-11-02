# wx-spektrafilm

A WeChat Mini Program (native JS/WXML/WXSS, no framework, no backend) that applies
film-emulation looks to phone photos using pre-baked 3D LUTs rendered on-device via WebGL.

Film modeling powered by spektrafilm
(https://github.com/andreavolpato/spektrafilm).

LUT/profile data derived from spektrafilm is licensed
CC BY-SA 4.0 (Andrea Volpato) — see
<https://github.com/andreavolpato/spektrafilm/blob/main/SPEKTRAFILM_LICENSE.txt>.
The code in this repository is licensed under GPLv3 (see LICENSE).

## Development

- Open the repo root in WeChat DevTools (微信开发者工具).
- Use the built-in tourist appid (`touristappid`, already set in `project.config.json`),
  or import your own appid.
- No npm build step is required; the Mini Program runs directly from source.

## Layout

- `app.js`, `app.json`, `app.wxss` — Mini Program entry
- `pages/` — Mini Program pages
- `tools/` — Python tooling for LUT baking (uses the venv at `/workspace/venv-sf`)
- `assets/` — static assets (LUTs live in a subpackage, e.g. `subpackages/luts`, at runtime)
- `docs/` — documentation
