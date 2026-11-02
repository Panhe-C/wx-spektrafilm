#!/usr/bin/env python3
"""Analyse the Phase 5a spatial-effect harness renders.

Reads the PNG files written by harness/test-effects.mjs, checks them and
writes harness/out/effects-report.{json,md} plus the two contact sheets
required by the plan (contact-effects.jpg and grain-compare.jpg).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "harness" / "out"
EFFECTS = OUT / "effects"
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "harness"))

from lut_apply import apply_strip_lut  # noqa: E402
from effects_mirror import (  # noqa: E402
    apply_grain,
    grain_statistics,
    radial_profile,
)
from effects_report import write_contact_sheets, write_markdown  # noqa: E402

LUTS = ROOT / "subpackages" / "luts"
PHYSICS = ROOT / "docs" / "effects-physics.json"

# Tolerances of the acceptance checks.
IDENTITY_MAX_CODE = 1
SCALE_STD_TOLERANCE = 0.05      # relative
SCALE_AUTOCORR_TOLERANCE = 0.06  # absolute, in frame units
MIRROR_STD_TOLERANCE = 0.08     # relative
MIRROR_AUTOCORR_TOLERANCE = 0.06


def load(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"), dtype=np.uint8)


def font(size: int):
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ):
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def label(draw, xy, text, size=15):
    draw.text(xy, text, fill=(235, 235, 235), font=font(size))


def autocorr_curve(stats: dict, long_edge: int) -> dict:
    """Autocorrelation of channel 0 as a function of the lag in frame units."""
    curve = {}
    for lag in range(1, 7):
        rho = stats["autocorr"][0].get(f"{lag},0")
        if rho is None:
            continue
        curve[lag] = rho
    return curve


def frame_curve(row: dict) -> dict:
    """{pixel lag: rho} keyed by the lag expressed in 1/4096 of the long edge."""
    long_edge = max(row["width"], row["height"])
    return {lag * 4096 // long_edge: rho for lag, rho in row["curve"].items()}


def main() -> int:
    cases = json.loads((EFFECTS / "effects-cases.json").read_text())
    report = {"photo": cases["photo"], "checks": {}, "numbers": {}}
    failures = []

    # --- identity: effects off must reproduce the Phase-4 output ------------
    source = load(EFFECTS / "effects-input.png")
    manifest = json.loads((LUTS / "luts.json").read_text())
    stock = next(item for item in manifest if item["id"] == "portra400")
    reference = apply_strip_lut(source, LUTS / stock["file"])
    identity = load(EFFECTS / "identity-off.png")
    difference = np.abs(identity.astype(np.int32) - reference.astype(np.int32))
    identity_max = int(difference.max())
    identity_mean = float(difference.mean())
    report["checks"]["identity"] = {
        "maxCodeError": identity_max,
        "meanCodeError": identity_mean,
        "tolerance": IDENTITY_MAX_CODE,
        "pass": identity_max <= IDENTITY_MAX_CODE,
    }
    if identity_max > IDENTITY_MAX_CODE:
        failures.append(f"identity: max code error {identity_max} > {IDENTITY_MAX_CODE}")
    print(f"identity (effects off vs tools/lut_apply.py): max {identity_max} code, "
          f"mean {identity_mean:.5f}")

    # --- determinism -------------------------------------------------------
    pairs = [
        ("identity-off.png", "identity-off-again.png"),
        ("effects-on.png", "effects-on-again.png"),
    ]
    deterministic = True
    for first, second in pairs:
        if (EFFECTS / first).read_bytes() != (EFFECTS / second).read_bytes():
            deterministic = False
    report["checks"]["determinism"] = {"pass": deterministic}
    if not deterministic:
        failures.append("determinism: repeated renders differ")
    print(f"determinism: {'identical' if deterministic else 'DIFFERENT'}")

    # --- scale invariance --------------------------------------------------
    scale_rows = []
    for entry in cases["cases"]["scale"]:
        off = load(EFFECTS / entry["off"]).astype(np.float64)
        on = load(EFFECTS / entry["on"]).astype(np.float64)
        grain = on - off
        stats = grain_statistics(grain)
        long_edge = max(entry["width"], entry["height"])
        scale_rows.append({
            "width": entry["width"],
            "height": entry["height"],
            "std": stats["std"],
            "autocorr": stats["autocorr"][0],
            "curve": autocorr_curve(stats, long_edge),
            "cross": stats["cross"],
        })
    report["numbers"]["scale"] = scale_rows
    small, large = scale_rows[0], scale_rows[1]
    std_ratio = [large["std"][c] / max(small["std"][c], 1e-9) for c in range(3)]
    # The autocorrelation is compared at the frame lags that both sizes
    # sample: the pixel lag of the larger render is an integer multiple of
    # the pixel lag of the smaller one.
    small_curve = frame_curve(small)
    large_curve = frame_curve(large)
    common = sorted(set(small_curve) & set(large_curve))
    curve_rows = [
        {"frameLag": key / 4096.0,
         "small": small_curve[key],
         "large": large_curve[key],
         "delta": abs(small_curve[key] - large_curve[key])}
        for key in common
    ]
    curve_delta = [row["delta"] for row in curve_rows]
    scale_pass = (max(abs(ratio - 1.0) for ratio in std_ratio) <= SCALE_STD_TOLERANCE
                  and max(curve_delta) <= SCALE_AUTOCORR_TOLERANCE)
    report["checks"]["scaleInvariance"] = {
        "stdRatio": std_ratio,
        "maxCurveDelta": max(curve_delta),
        "curveRows": curve_rows,
        "pass": scale_pass,
    }
    if not scale_pass:
        failures.append("scale invariance: the grain statistics differ between sizes")
    print(f"scale invariance: std ratio {['%.4f' % r for r in std_ratio]}, "
          f"max autocorrelation delta {max(curve_delta):.4f}")

    # --- the NumPy mirror of the shader maths ------------------------------
    constants = json.loads((EFFECTS / "effects-constants.json").read_text())
    stock_effects = constants["stocks"]["portra400"]
    off_codes = load(EFFECTS / "scale-1280-off.png").astype(np.float64)
    graded = off_codes.astype(np.float32) / 255.0
    grain = apply_grain(
        graded,
        stock_effects["grain"]["curve"],
        stock_effects["grain"]["matrix"],
        constants["grainLatticeFrame"],
        1.0,
    )
    # The mirror predicts the final 8-bit picture, so that the 8-bit
    # quantisation of the render is part of the comparison.
    predicted_codes = np.rint(np.clip(graded + grain, 0.0, 1.0) * 255.0)
    measured_codes = load(EFFECTS / "scale-1280-on.png").astype(np.float64)
    predicted_stats = grain_statistics(predicted_codes - off_codes)
    measured_stats = grain_statistics(measured_codes - off_codes)
    std_ratio = [predicted_stats["std"][c] / max(measured_stats["std"][c], 1e-9)
                 for c in range(3)]
    mirror_curve_predicted = autocorr_curve(predicted_stats, 1280)
    mirror_curve_measured = autocorr_curve(measured_stats, 1280)
    common = sorted(set(mirror_curve_predicted) & set(mirror_curve_measured))
    mirror_delta = [
        abs(mirror_curve_predicted[key] - mirror_curve_measured[key]) for key in common
    ]
    mirror_pass = (max(abs(ratio - 1.0) for ratio in std_ratio) <= MIRROR_STD_TOLERANCE
                   and max(mirror_delta) <= MIRROR_AUTOCORR_TOLERANCE)
    report["numbers"]["mirror"] = {
        "predicted": predicted_stats,
        "measured": measured_stats,
        "stdRatio": std_ratio,
        "maxAutocorrDelta": max(mirror_delta),
        "pixelMaxError": float(np.abs(predicted_codes - measured_codes).max()),
    }
    report["checks"]["numpyMirror"] = {"pass": mirror_pass}
    if not mirror_pass:
        failures.append("numpy mirror: the shader grain differs from the NumPy mirror")
    print(f"numpy mirror: std ratio {['%.4f' % r for r in std_ratio]}, "
          f"max autocorrelation delta {max(mirror_delta):.4f}")

    # --- halation radial profile ------------------------------------------
    disc_off = load(EFFECTS / "disc-off.png").astype(np.float64)
    disc_halo = load(EFFECTS / "disc-halation.png").astype(np.float64)
    profile = radial_profile(disc_halo - disc_off, 640, 320, 70)
    report["numbers"]["halationProfile"] = profile
    if PHYSICS.is_file():
        physics = json.loads(PHYSICS.read_text())
        reference_profile = physics["halation"]["portra400"]["profile"]
        rows = []
        for entry in profile:
            radius = entry["radius_px"]
            match = next((item for item in reference_profile
                          if item["radius_px"] == radius), None)
            if match is None:
                continue
            rows.append({
                "radius_px": radius,
                "radius_um": radius * physics["pixel_size_um"],
                "physics": match["mean_codes"],
                "shader": entry["mean_codes"],
            })
        report["numbers"]["halationComparison"] = rows
        print(f"halation profile: {len(rows)} radii compared with the physics study")

    # --- timings -----------------------------------------------------------
    report["numbers"]["timings"] = cases["cases"]["timings"]

    # --- the physical reference for the grain comparison image -------------
    physics = run_physics_grain()
    if physics is not None:
        report["numbers"]["physicsGrain"] = physics["statistics"]
    photo_halation = run_physics_halation_photo(EFFECTS / "effects-input.png")
    if photo_halation is not None:
        report["numbers"]["physicsHalationPhoto"] = photo_halation

    report["pass"] = not failures
    report["failures"] = failures
    (OUT / "effects-report.json").write_text(json.dumps(report, indent=2) + "\n")

    write_markdown(report)
    write_contact_sheets(cases)

    if failures:
        for failure in failures:
            print(f"FAIL: {failure}")
        return 1
    print("effects checks: PASS")
    return 0


def run_physics_halation_photo(input_png: Path) -> dict | None:
    """Physical halation on the harness photo, compared with the shader.

    The same picture is simulated with the halation on and off; the difference
    is the physical halation contribution, which is compared with the shader's
    halation difference on the same input.
    """
    try:
        from PIL import Image as PILImage
        sys.path.insert(0, str(ROOT / "tools"))
        from study_effects import make_effect_params, simulate_effects
        from pipeline_config import GLOBAL_RECIPE, decode_srgb_input, load_stocks
    except Exception as error:  # pragma: no cover - depends on the environment
        print(f"physical reference unavailable: {error}")
        return None
    with PILImage.open(input_png) as handle:
        image = np.asarray(handle.convert("RGB"), dtype=np.float64) / 255.0
    stocks = {item["id"]: item for item in load_stocks()}
    stock = stocks["portra400"]
    linear = decode_srgb_input(image, GLOBAL_RECIPE, GLOBAL_RECIPE["stops_above_midgray"])
    params = make_effect_params(stock)
    off = simulate_effects(linear, params, grain=False, halation=False)
    on = simulate_effects(linear, params, grain=False, halation=True)
    difference = (on - off) * 255.0
    physics = {
        "max_abs_code": float(np.abs(difference).max()),
        "rms_code": float(np.sqrt(np.mean(difference ** 2))),
        "mean_codes": [float(difference[:, :, c].mean()) for c in range(3)],
    }
    # The shader's own halation difference on the same picture.
    shader_off = load(EFFECTS / "identity-off.png").astype(np.float64)
    shader_on = load(EFFECTS / "photo-halation.png").astype(np.float64)
    shader_difference = shader_on - shader_off
    physics["shader_max_abs_code"] = float(np.abs(shader_difference).max())
    physics["shader_rms_code"] = float(np.sqrt(np.mean(shader_difference ** 2)))
    physics["shader_mean_codes"] = [float(shader_difference[:, :, c].mean()) for c in range(3)]
    physics["difference_max_code"] = float(np.abs(difference - shader_difference).max())
    physics["difference_rms_code"] = float(
        np.sqrt(np.mean((difference - shader_difference) ** 2))
    )
    print(f"physical halation on the photo: rms {physics['rms_code']:.4f} code, "
          f"max {physics['max_abs_code']:.3f}; shader rms {physics['shader_rms_code']:.4f}, "
          f"max {physics['shader_max_abs_code']:.3f}")
    return physics


def parse_stock_effects(source: str, stock_id: str) -> dict:
    """Deprecated: the constants now come from effects-constants.json."""
    raise NotImplementedError


def run_physics_grain() -> dict | None:
    """Run the physical pipeline on the same flat field and save the result.

    The comparison needs spektrafilm itself; the harness virtual environment
    provides it. When it is unavailable the report simply states that the
    physical comparison image was not produced.
    """
    try:
        from PIL import Image as PILImage
        sys.path.insert(0, str(ROOT / "tools"))
        from study_effects import make_effect_params, simulate_effects
        from pipeline_config import GLOBAL_RECIPE, decode_srgb_input, load_stocks
    except Exception as error:  # pragma: no cover - depends on the environment
        print(f"physical reference unavailable: {error}")
        return None
    stocks = {item["id"]: item for item in load_stocks()}
    stock = stocks["portra400"]
    image = np.full((192, 1280, 3), 128.0 / 255.0, dtype=np.float64)
    linear = decode_srgb_input(image, GLOBAL_RECIPE, GLOBAL_RECIPE["stops_above_midgray"])
    params = make_effect_params(stock)
    off = simulate_effects(linear, params, grain=False, halation=True)
    on = simulate_effects(linear, params, grain=True, halation=True)
    delta = (on - off) * 255.0
    PILImage.fromarray(
        np.clip(on * 255.0, 0, 255).astype(np.uint8)
    ).save(EFFECTS / "physics-grain.png")
    statistics = grain_statistics(delta)
    print(f"physical grain: std {['%.4f' % v for v in statistics['std']]} "
          f"at output level {float(off[0, 0, 0] * 255):.2f}")
    return {"statistics": statistics, "level": float(off[0, 0, 0] * 255)}


if __name__ == "__main__":
    raise SystemExit(main())
