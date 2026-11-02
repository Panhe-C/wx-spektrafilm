#!/usr/bin/env python3
"""Derive the shader effect constants from the Phase 5a physics study.

Reads ``build/p5a/effects-study.json`` (produced by ``tools/study_effects.py``)
and writes ``utils/effects.js``: the shared per-stock grain/halation model
used by the Mini Program, the headless harness and the NumPy reference.

The derivation is mechanical, not hand tuned:

* the grain amplitude curve is the measured grain standard deviation of the
  physical pipeline versus the output level, normalised at the mid-tone and
  resampled on 17 evenly spaced levels;
* the grain colour mixing is the Cholesky factor of the measured mid-tone
  covariance matrix of the grain perturbation (in 8-bit code units);
* the halation constants are spektrafilm's own per-stock presets
  (``halation_strength`` and ``halation_first_sigma_um``), which are selected
  from the film profile's ``use``/``antihalation`` tags.

Usage::

    /workspace/venv-sf/bin/python tools/derive_effects.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build" / "p5a"
STUDY = BUILD / "effects-study.json"
TEMPLATE = ROOT / "tools" / "effects_template.js"
DESTINATION = ROOT / "utils" / "effects.js"
sys.path.insert(0, str(ROOT / "tools"))

from pipeline_config import load_stocks  # noqa: E402

CURVE_SIZE = 17
CURVE_MAX_LEVEL = 255.0
# The mid-tone reference level used to normalise the curve and to freeze the
# colour mixing (the physical correlation is level dependent; the shader uses
# the mid-tone value, see docs/EFFECTS.md).
REFERENCE_LEVEL = 118.0

# spektrafilm/src/spektrafilm/runtime/params_builder.py::_HALATION_PRESETS
HALATION_PRESETS = {
    ("still", "strong"): {"sigma_um": 65.0, "strength": [0.015, 0.005, 0.0]},
    ("still", "weak"): {"sigma_um": 65.0, "strength": [0.08, 0.02, 0.0]},
    ("still", "no"): {"sigma_um": 65.0, "strength": [0.30, 0.10, 0.015]},
    ("cine", "strong"): {"sigma_um": 50.0, "strength": [0.015, 0.005, 0.0]},
    ("cine", "weak"): {"sigma_um": 50.0, "strength": [0.08, 0.02, 0.0]},
    ("cine", "no"): {"sigma_um": 50.0, "strength": [0.30, 0.10, 0.015]},
}
PROFILE_DIR = Path("/workspace/spektrafilm/src/spektrafilm/data/profiles")


def profile_tags(film: str) -> tuple[str, str]:
    data = json.loads((PROFILE_DIR / f"{film}.json").read_text(encoding="utf-8"))
    info = data["info"]
    return info.get("use", "still"), info.get("antihalation", "strong")


def grain_model(levels: list[dict]) -> dict:
    """Amplitude curve and colour mixing from the measured grain statistics."""
    measured = []
    for entry in levels:
        level = float(np.mean(entry["output_codes"]))
        sigma = np.array(entry["std_codes"], dtype=np.float64)
        measured.append((level, sigma, entry))
    measured.sort(key=lambda item: item[0])

    # Reference row: the measured level closest to the reference mid-tone.
    index = int(np.argmin([abs(item[0] - REFERENCE_LEVEL) for item in measured]))
    level0, sigma0, entry0 = measured[index]
    cross = entry0["cross_corr"]
    corr = np.array([
        [1.0, cross["rg"], cross["rb"]],
        [cross["rg"], 1.0, cross["gb"]],
        [cross["rb"], cross["gb"], 1.0],
    ])
    covariance = np.outer(sigma0, sigma0) * corr
    # Guard against a non positive definite measurement: fall back to a
    # diagonal matrix, which keeps the shader well defined.
    if float(np.linalg.eigvalsh(covariance).min()) <= 1e-9:
        covariance = np.diag(np.diag(covariance))
    mixing = np.linalg.cholesky(covariance)

    # Normalised amplitude curve: the mean over the three channels of
    # sigma_ch(level) / sigma_ch(reference).
    ratios = [(level, float(np.mean(sigma / sigma0))) for level, sigma, _ in measured]
    grid = np.linspace(0.0, CURVE_MAX_LEVEL, CURVE_SIZE)
    xs = np.array([item[0] for item in ratios])
    ys = np.array([item[1] for item in ratios])
    curve = np.clip(np.interp(grid, xs, ys, left=0.0, right=float(ys[-1])), 0.0, None)
    return {
        "curve": [float(value) for value in curve],
        "matrix": [float(value) for value in mixing.reshape(-1)],
        "reference_level": level0,
        "reference_sigma": [float(value) for value in sigma0],
    }


def autocorrelation_lattice(levels: list[dict]) -> tuple[float, float, float, float]:
    """Measured autocorrelation of the physical grain (per level average)."""
    rho = float(np.mean([entry["autocorr"][0]["1,0"] for entry in levels]))
    rho11 = float(np.mean([entry["autocorr"][0]["1,1"] for entry in levels]))
    rho20 = float(np.mean([entry["autocorr"][0]["2,0"] for entry in levels]))
    return rho, rho11, rho20


def fit_lattice_spacing(reference_width: int, height: int,
                        target: tuple[float, float, float]) -> tuple[float, dict]:
    """Choose the grain lattice spacing so that the shader's noise has the
    measured autocorrelation of the physical grain.

    The shader uses a bilinear value-noise field whose *sampled*
    autocorrelation depends on the lattice spacing and on the lattice phase
    relative to the pixel grid. The spacing is therefore fitted numerically
    against the measured physical correlation, using the same noise code the
    shader runs (harness/effects_mirror.py).
    """
    sys.path.insert(0, str(ROOT / "harness"))
    from effects_mirror import autocorrelate, grain_signal  # noqa: E402

    columns = (np.arange(reference_width, dtype=np.float32) + np.float32(0.5)) / np.float32(reference_width)
    rows = (np.arange(height, dtype=np.float32) + np.float32(0.5)) / np.float32(reference_width)
    frame_x = np.broadcast_to(columns[None, :], (height, reference_width))
    frame_y = np.broadcast_to(rows[:, None], (height, reference_width))

    best = None
    table = []
    for spacing in np.arange(1.20, 2.60, 0.005):
        lattice = float(spacing) / reference_width
        fields = grain_signal(frame_x, frame_y, lattice)[:, :, 0]
        auto = autocorrelate(fields, lags=((1, 0), (2, 0), (1, 1)))
        error = (auto["1,0"] - target[0]) ** 2 + (auto["1,1"] - target[1]) ** 2 \
            + 0.25 * (auto["2,0"] - target[2]) ** 2
        table.append((float(spacing), auto, float(error)))
        if best is None or error < best[2]:
            best = (float(spacing), auto, float(error))
    return best[0], {"autocorrelation": best[1], "error": best[2], "table": table}


def stock_entries(study: dict, stocks: list[dict]) -> str:
    lines = []
    for stock in stocks:
        stock_id = stock["id"]
        grain = study["grain"][stock_id]
        model = grain_model(grain["levels"])
        use, antihalation = profile_tags(stock["film"])
        preset = HALATION_PRESETS[(use, antihalation)]
        curve = ", ".join(f"{value:.6f}" for value in model["curve"])
        matrix = ", ".join(f"{value:.6f}" for value in model["matrix"])
        strength = ", ".join(f"{value:.6f}" for value in preset["strength"])
        lines.append(f"    {stock_id}: Object.freeze({{")
        lines.append("      grain: Object.freeze({")
        lines.append(f"        curve: Object.freeze([{curve}]),")
        lines.append(f"        matrix: Object.freeze([{matrix}]),")
        lines.append(f"        referenceLevel: {model['reference_level']:.3f},")
        lines.append("      }),")
        lines.append("      halation: Object.freeze({")
        lines.append(f"        sigmaUm: {preset['sigma_um']:.1f},")
        lines.append(f"        strength: Object.freeze([{strength}]),")
        lines.append("      }),")
        lines.append(f"      tags: Object.freeze({{ use: '{use}', antihalation: '{antihalation}' }}),")
        lines.append("    }),")
    return "\n".join(lines)


def main() -> int:
    if not STUDY.is_file():
        raise SystemExit(f"missing {STUDY}; run tools/study_effects.py first")
    study = json.loads(STUDY.read_text(encoding="utf-8"))
    stocks = load_stocks()
    missing = [stock["id"] for stock in stocks if stock["id"] not in study.get("grain", {})]
    if missing:
        raise SystemExit(f"study is missing stocks: {missing}")

    rho10, rho11, rho20 = autocorrelation_lattice(
        study["grain"][stocks[0]["id"]]["levels"]
    )
    reference_width = float(study.get("reference_width", 1280))
    spacing, fit = fit_lattice_spacing(
        int(reference_width), 192, (rho10, rho11, rho20)
    )
    predicted11 = fit["autocorrelation"]["1,1"]
    lattice_frame = spacing / reference_width

    template = TEMPLATE.read_text(encoding="utf-8")
    output = (template
               .replace("__REFERENCE_LONG_EDGE__", str(int(reference_width)))
               .replace("__GRAIN_LATTICE_PX__", f"{spacing:.6f}")
               .replace("__GRAIN_LATTICE_FRAME__", f"{lattice_frame:.9f}")
               .replace("__RHO10__", f"{rho10:.4f}")
               .replace("__RHO11__", f"{rho11:.4f}")
               .replace("__PREDICTED11__", f"{predicted11:.4f}")
               .replace("__STOCK_ENTRIES__", stock_entries(study, stocks)))
    DESTINATION.write_text(output, encoding="utf-8")
    print(f"wrote {DESTINATION}")
    print(f"grain lattice: {spacing:.4f} px at {reference_width:.0f} px "
          f"(frame {lattice_frame:.9f}); measured rho10={rho10:.4f} rho11={rho11:.4f} "
          f"rho20={rho20:.4f}; fitted rho10={fit['autocorrelation']['1,0']:.4f} "
          f"rho11={predicted11:.4f} rho20={fit['autocorrelation']['2,0']:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
