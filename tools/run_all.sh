#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "${VIRTUAL_ENV:-}" != "/workspace/venv-sf" ]]; then
  # shellcheck disable=SC1091
  source /workspace/venv-sf/bin/activate
fi

# Keep spectral simulation and large-image validation serial and memory-bound.
export OPENBLAS_NUM_THREADS=1
export OMP_NUM_THREADS=1
export MKL_NUM_THREADS=1
export NUMEXPR_NUM_THREADS=1
export NUMBA_NUM_THREADS=1
export PYTHONUNBUFFERED=1

# Set SKIP_EXPOSURE=1 only when reusing the complete existing exploration.
if [[ "${SKIP_EXPOSURE:-0}" != "1" ]]; then
  python tools/explore_exposure.py
fi

for n in 33 49 65; do
  python tools/bake_luts.py \
    --resolution "$n" \
    --output-dir "build/luts/$n" \
    --manifest "build/bake-manifest-$n.json"
  python tools/convert_luts.py \
    --manifest "build/bake-manifest-$n.json" \
    --output-dir "build/tiled/$n" \
    --clean
done

# Reuses each full simulate() reference for all three resolutions, selects N,
# and writes docs/validation.{json,md} plus build/selected_resolution.json.
python tools/validate_luts.py

selected="$(python -c "import json; print(json.load(open('build/selected_resolution.json'))['selected_resolution'])")"
cp "build/bake-manifest-$selected.json" build/bake_manifest.json
python tools/convert_luts.py \
  --manifest "build/bake-manifest-$selected.json" \
  --output-dir subpackages/luts \
  --clean
python tools/make_contact_sheet.py

# Snapshot only the three small non-phone fixtures (phone photos stay on-box).
mkdir -p tools/testdata
cp build/validation/portrait.jpg build/validation/chart.jpg \
   build/validation/synthetic.png tools/testdata/

python - <<'PY'
import json
from pathlib import Path

for path in Path('.').rglob('*.json'):
    if '.git' not in path.parts and 'build' not in path.parts:
        json.loads(path.read_text(encoding='utf-8'))
testdata = sum(path.stat().st_size for path in Path('tools/testdata').iterdir() if path.is_file())
if testdata > 200 * 1024:
    raise RuntimeError(f'tools/testdata is too large: {testdata} bytes')
print(f'[done] all tracked-context JSON files parse; testdata={testdata:,} bytes')
PY
