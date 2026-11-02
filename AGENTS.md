# AGENTS.md — Project conventions

## Stack
- Native WeChat Mini Program (原生小程序): plain JS + WXML + WXSS.
  No framework, no npm build step (unless a later phase explicitly requires one).
- No external runtime dependencies.

## Code style
- JavaScript: ES2015+ syntax, 2-space indentation.

## Rendering
- WebGL only via `<canvas type="webgl">` (Mini Program webgl context), no other GL wrappers.

## Package size
- The main package must stay under 2 MB.
- Large assets (e.g. LUT files) go into subpackages such as `subpackages/luts`.

## Python tooling
- Python tooling lives in `tools/`.
- Use the venv at `/workspace/venv-sf` (Python 3.13, spektrafilm installed editable
  from `/workspace/spektrafilm`).

## Licensing & attribution
- Project code is GPLv3 (see LICENSE).
- Always credit spektrafilm: film modeling powered by
  [spektrafilm](https://github.com/andreavolpato/spektrafilm).
- LUT/profile data derived from spektrafilm is CC BY-SA 4.0 (Andrea Volpato) — see
  https://github.com/andreavolpato/spektrafilm/blob/main/SPEKTRAFILM_LICENSE.txt

## Workflow
- Commit in small steps with conventional commit messages (feat:, fix:, chore:, docs:, ...).
- Always verify JSON files parse (e.g. `python3 -c "import json,sys;json.load(open(f))"`).
- Do not push to any remote.
