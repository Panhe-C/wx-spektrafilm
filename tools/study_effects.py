#!/usr/bin/env python3
"""Phase 5a physics study: grain statistics and halation radial profiles.

The study runs the *full* spektrafilm pipeline (public ``simulate()`` with the
same physical recipe the shipped LUTs use) with the stochastic/spatial
effects switched on and off, and measures

* grain: the per-level standard deviation of the grain-induced difference in
  sRGB codes, the spatial autocorrelation of that difference, and the
  cross-channel correlation;
* halation (+ in-emulsion scatter): the radial profile of the added energy per
  channel around a synthetic bright disc.

Everything is measured at a defined output scale: the long edge of the test
patch is ``--width`` pixels (default 1280, the app's preview size), because
spektrafilm derives the film-plane pixel size from the image size
(``pixel_size_um = film_format_mm * 1000 / max(h, w)``).

Usage::

    /workspace/venv-sf/bin/python tools/study_effects.py --resume

Results are written to ``build/p5a/effects-study.json`` (resumable, one file
per stock) and summarised in ``docs/EFFECTS.md`` by the agent.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build" / "p5a"
sys.path.insert(0, str(ROOT / "tools"))

from pipeline_config import (  # noqa: E402
    GLOBAL_RECIPE,
    INPUT_COLOR_SPACE,
    OUTPUT_COLOR_SPACE,
    decode_srgb_input,
    encode_srgb_output,
    load_stocks,
    make_bundle_spec,
)

# Stocks studied: one of every kind the project ships, plus the two stocks
# whose profile tags select a weak anti-halation layer (much stronger
# back-reflection halation).
DEFAULT_STOCKS = [
    "portra400",     # colour negative, strong anti-halation
    "gold200",       # colour negative, weak anti-halation
    "velvia100",     # slide (direct film scan)
    "vision3_500t",  # cinema negative (PET base -> smaller sigma_h)
]

# Input sRGB values (encoded) probed for the grain study.
DEFAULT_LEVELS = [
    0.03, 0.06, 0.10, 0.16, 0.22, 0.30, 0.38, 0.46,
    0.55, 0.64, 0.73, 0.82, 0.90, 0.96,
]


# --------------------------------------------------------------------------
# parameter construction
# --------------------------------------------------------------------------

def make_effect_params(stock: dict, recipe: dict | None = None):
    """Runtime params identical to the shipped bake, but with the spatial and
    stochastic effects *enabled*.

    ``tools/pipeline_config.make_runtime_params`` builds the LUT-compatible
    parameter object with ``lut_mode = True``, which force-disables every
    spatial/stochastic effect. The study needs the same physical recipe with
    those effects switched back on, so the recipe is rebuilt here from the
    same shared constants and digested without ``lut_mode``.
    """
    from spektrafilm.runtime.params_builder import digest_params, init_params
    from spektrafilm_lut_creator.color_spaces import get as get_color_space

    recipe = GLOBAL_RECIPE if recipe is None else recipe
    spec = make_bundle_spec(stock, recipe=recipe)
    in_entry = get_color_space(INPUT_COLOR_SPACE)
    out_entry = get_color_space(OUTPUT_COLOR_SPACE)

    params = init_params(film_profile=stock["film"], print_profile=stock["print"])
    params.debug.lut_mode = False
    params.io.input_color_space = in_entry.primaries
    params.io.output_color_space = out_entry.primaries
    params.io.input_cctf_decoding = False
    params.io.output_cctf_encoding = False
    params.io.input_gamut_compress = spec.input_gamut_compress
    params.io.output_gamut_compress = spec.output_gamut_compress
    params.io.scan_film = bool(params.film.is_positive)
    params.settings.neutral_print_filters_from_database = bool(
        recipe["neutral_print_filters_from_database"]
    )
    params.enlarger.illuminant = str(recipe["illuminant"])
    params.enlarger.y_filter_shift = float(recipe["y_filter_shift"])
    params.enlarger.m_filter_shift = float(recipe["m_filter_shift"])
    params = digest_params(params)

    params.camera.auto_exposure = False
    params.camera.exposure_compensation_ev = float(recipe["camera_exposure_compensation_ev"])
    params.enlarger.print_exposure = float(recipe["enlarger_print_exposure"])
    params.enlarger.print_exposure_compensation = bool(recipe["print_exposure_compensation"])
    params.enlarger.normalize_print_exposure = bool(recipe["normalize_print_exposure"])
    params.scanner.white_correction = bool(recipe["scanner_white_correction"])
    params.scanner.black_correction = bool(recipe["scanner_black_correction"])
    params.scanner.white_level = float(recipe["scanner_white_level"])
    params.scanner.black_level = float(recipe["scanner_black_level"])
    # The shipped LUT is baked without the scanner unsharp mask; keep it off
    # so the study measures the same base image as the delivered cubes.
    params.scanner.unsharp_mask = (0.0, 0.0)
    params.io.scan_film = bool(params.film.is_positive)
    return params


def simulate_effects(linear_input: np.ndarray, params, grain: bool, halation: bool,
                      glare: bool = False) -> np.ndarray:
    """Full ``simulate()`` with the requested effects switched on/off."""
    from spektrafilm import simulate

    params.film_render.grain.active = bool(grain)
    params.film_render.halation.active = bool(halation)
    params.print_render.glare.active = bool(glare)
    params.film_render.glare.active = bool(glare)
    linear_output = simulate(
        linear_input, params, digest_params_first=False, print_timings=False,
    )
    return encode_srgb_output(linear_output, clip=False)


# --------------------------------------------------------------------------
# measurements
# --------------------------------------------------------------------------

def autocorrelate(plane: np.ndarray, lags=((1, 0), (2, 0), (3, 0), (1, 1))) -> dict:
    """Normalised autocorrelation of a zero-mean 2D plane at given lags."""
    x = plane - plane.mean()
    var = float(np.mean(x * x))
    out = {}
    if var <= 0:
        return {f"{dy},{dx}": 0.0 for dy, dx in lags}
    for dy, dx in lags:
        if dy == 0:
            a = x[:, :-dx] if dx else x
            b = x[:, dx:] if dx else x
        else:
            a = x[:-dy, :-dx] if dx else x[:-dy, :]
            b = x[dy:, dx:] if dx else x[dy:, :]
        out[f"{dy},{dx}"] = float(np.mean(a * b) / var)
    return out


def cross_correlate(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean()
    b = b - b.mean()
    denom = math.sqrt(float(np.mean(a * a)) * float(np.mean(b * b)))
    if denom <= 0:
        return 0.0
    return float(np.mean(a * b) / denom)


def grain_study(stock: dict, width: int, height: int, levels: list[float]) -> dict:
    """Grain amplitude per output level, plus spatial/channel statistics."""
    params = make_effect_params(stock)
    pixel_size_um = 35000.0 / max(width, height)
    rows = []
    for value in levels:
        image = np.full((height, width, 3), float(value), dtype=np.float64)
        linear_input = decode_srgb_input(image, GLOBAL_RECIPE, GLOBAL_RECIPE["stops_above_midgray"])
        off = simulate_effects(linear_input, params, grain=False, halation=True)
        on = simulate_effects(linear_input, params, grain=True, halation=True)
        base = off * 255.0
        delta = (on - off) * 255.0
        entry = {
            "input_srgb": value,
            "output_codes": [float(base[0, 0, c]) for c in range(3)],
            "std_codes": [float(np.std(delta[:, :, c])) for c in range(3)],
            "mean_codes": [float(np.mean(delta[:, :, c])) for c in range(3)],
            "autocorr": [autocorrelate(delta[:, :, c]) for c in range(3)],
        }
        entry["cross_corr"] = {
            "rg": cross_correlate(delta[:, :, 0], delta[:, :, 1]),
            "rb": cross_correlate(delta[:, :, 0], delta[:, :, 2]),
            "gb": cross_correlate(delta[:, :, 1], delta[:, :, 2]),
        }
        rows.append(entry)
        print(
            f"  {stock['id']:14s} in={value:5.3f} out={entry['output_codes'][0]:7.2f} "
            f"std={entry['std_codes'][0]:6.3f}/{entry['std_codes'][1]:6.3f}/{entry['std_codes'][2]:6.3f}",
            flush=True,
        )
    return {
        "stock": stock["id"],
        "film": stock["film"],
        "print": stock["print"],
        "category": stock["category"],
        "width": width,
        "height": height,
        "pixel_size_um": pixel_size_um,
        "levels": rows,
    }


def halation_study(stock: dict, width: int, height: int, disc_radius: int,
                   disc_value: float = 1.0, background: float = 0.02) -> dict:
    """Radial profile of the halation + scatter contribution around a disc."""
    params = make_effect_params(stock)
    pixel_size_um = 35000.0 / max(width, height)
    yy, xx = np.mgrid[0:height, 0:width]
    cy, cx = height // 2, width // 2
    radius = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2)
    image = np.full((height, width, 3), background, dtype=np.float64)
    image[radius <= disc_radius] = disc_value
    linear_input = decode_srgb_input(image, GLOBAL_RECIPE, GLOBAL_RECIPE["stops_above_midgray"])
    off = simulate_effects(linear_input, params, grain=False, halation=False)
    on = simulate_effects(linear_input, params, grain=False, halation=True)
    delta = (on - off) * 255.0
    profile = []
    max_radius = min(disc_radius + 60, min(height, width) // 2 - 2)
    for r in range(0, max_radius + 1):
        mask = (radius >= r) & (radius < r + 1)
        if not mask.any():
            continue
        profile.append({
            "radius_px": r,
            "radius_um": r * pixel_size_um,
            "mean_codes": [float(np.mean(delta[:, :, c][mask])) for c in range(3)],
            "max_codes": [float(np.max(delta[:, :, c][mask])) for c in range(3)],
        })
    disc = radius <= disc_radius
    ring = (radius > disc_radius) & (radius <= disc_radius + 20)
    return {
        "stock": stock["id"],
        "film": stock["film"],
        "print": stock["print"],
        "width": width,
        "height": height,
        "pixel_size_um": pixel_size_um,
        "disc_radius_px": disc_radius,
        "disc_value": disc_value,
        "background": background,
        "disc_mean_codes": [float(np.mean((on - off)[:, :, c][disc])) for c in range(3)],
        "ring_mean_codes": [float(np.mean(delta[:, :, c][ring])) for c in range(3)],
        "profile": profile,
    }


def write_summary(summary: dict, reference_width: int) -> Path:
    """Compact, committed summary of the measurements (docs/effects-physics.json)."""
    out = {
        "reference_width": reference_width,
        "pixel_size_um": 35000.0 / reference_width,
        "grain": {},
        "halation": {},
    }
    for stock_id, grain in summary.get("grain", {}).items():
        rows = []
        for entry in grain["levels"]:
            auto = entry["autocorr"][0]
            rows.append({
                "input_srgb": round(entry["input_srgb"], 4),
                "output_codes": [round(value, 4) for value in entry["output_codes"]],
                "std_codes": [round(value, 5) for value in entry["std_codes"]],
                "rho10": round(auto["1,0"], 5),
                "rho11": round(auto["1,1"], 5),
                "rho20": round(auto["2,0"], 5),
                "corr_rg": round(entry["cross_corr"]["rg"], 5),
                "corr_rb": round(entry["cross_corr"]["rb"], 5),
                "corr_gb": round(entry["cross_corr"]["gb"], 5),
            })
        out["grain"][stock_id] = {
            "film": grain["film"],
            "category": grain["category"],
            "levels": rows,
        }
    for stock_id, halation in summary.get("halation", {}).items():
        profile = [
            {
                "radius_px": entry["radius_px"],
                "radius_um": round(entry["radius_um"], 2),
                "mean_codes": [round(value, 6) for value in entry["mean_codes"]],
            }
            for entry in halation["profile"]
            if entry["radius_px"] % 2 == 0
        ]
        out["halation"][stock_id] = {
            "film": halation["film"],
            "disc_radius_px": halation["disc_radius_px"],
            "disc_mean_codes": [round(value, 6) for value in halation["disc_mean_codes"]],
            "ring_mean_codes": [round(value, 6) for value in halation["ring_mean_codes"]],
            "profile": profile,
        }
    path = ROOT / "docs" / "effects-physics.json"
    path.write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stocks", nargs="*", default=DEFAULT_STOCKS)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=192)
    parser.add_argument("--halo-width", type=int, default=1280)
    parser.add_argument("--halo-height", type=int, default=640)
    parser.add_argument("--disc-radius", type=int, default=40)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--only-grain", action="store_true")
    parser.add_argument("--only-halation", action="store_true")
    args = parser.parse_args()

    BUILD.mkdir(parents=True, exist_ok=True)
    stocks = {stock["id"]: stock for stock in load_stocks()}
    summary = {"reference_width": args.width, "pixel_size_um": 35000.0 / args.width,
               "grain": {}, "halation": {}}

    for stock_id in args.stocks:
        if stock_id not in stocks:
            raise SystemExit(f"unknown stock {stock_id}")
        stock = stocks[stock_id]
        grain_path = BUILD / f"grain-{stock_id}.json"
        halo_path = BUILD / f"halation-{stock_id}.json"
        if not args.only_halation:
            if args.resume and grain_path.is_file():
                summary["grain"][stock_id] = json.loads(grain_path.read_text())
                print(f"[resume] grain {stock_id}")
            else:
                started = time.time()
                result = grain_study(stock, args.width, args.height, DEFAULT_LEVELS)
                grain_path.write_text(json.dumps(result, indent=2))
                summary["grain"][stock_id] = result
                print(f"grain {stock_id}: {time.time() - started:.1f}s", flush=True)
        if not args.only_grain:
            if args.resume and halo_path.is_file():
                summary["halation"][stock_id] = json.loads(halo_path.read_text())
                print(f"[resume] halation {stock_id}")
            else:
                started = time.time()
                result = halation_study(stock, args.halo_width, args.halo_height, args.disc_radius)
                halo_path.write_text(json.dumps(result, indent=2))
                summary["halation"][stock_id] = result
                print(f"halation {stock_id}: {time.time() - started:.1f}s", flush=True)

    out = BUILD / "effects-study.json"
    if out.is_file() and args.resume:
        previous = json.loads(out.read_text())
        previous.setdefault("grain", {}).update(summary["grain"])
        previous.setdefault("halation", {}).update(summary["halation"])
        summary = previous
    summary["reference_width"] = args.width
    summary["pixel_size_um"] = 35000.0 / args.width
    out.write_text(json.dumps(summary, indent=2))
    print(f"wrote {out}")
    print(f"wrote {write_summary(summary, args.width)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
