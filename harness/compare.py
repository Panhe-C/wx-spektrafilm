#!/usr/bin/env python3
"""Compare headless WebGL renders with the canonical NumPy tiled-LUT path."""
from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from skimage.color import deltaE_ciede2000, rgb2lab

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "harness" / "out"
sys.path.insert(0, str(ROOT / "tools"))
from lut_apply import apply_strip_lut_float  # noqa: E402

MEAN_DE_LIMIT = 0.3
MAX_DE_LIMIT = 2.0
INTENSITY_CODE_TOLERANCE = 1
DIFF_AMPLIFICATION = 16


def read_rgb(relative: str | Path) -> np.ndarray:
    path = Path(relative)
    if not path.is_absolute():
        path = OUT / path
    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"), dtype=np.uint8)


def delta_metrics(actual: np.ndarray, expected: np.ndarray) -> dict[str, float]:
    if actual.shape != expected.shape or actual.ndim != 3 or actual.shape[2] != 3:
        raise ValueError(f"Shape mismatch: {actual.shape} versus {expected.shape}")
    actual_lab = rgb2lab(actual.astype(np.float32) * np.float32(1 / 255))
    expected_lab = rgb2lab(expected.astype(np.float32) * np.float32(1 / 255))
    delta = deltaE_ciede2000(actual_lab, expected_lab)
    absolute = np.abs(actual.astype(np.int16) - expected.astype(np.int16))
    return {
        "meanDeltaE": float(np.mean(delta)),
        "p95DeltaE": float(np.percentile(delta, 95)),
        "maxDeltaE": float(np.max(delta)),
        "meanAbs8bit": float(np.mean(absolute)),
        "maxAbs8bit": int(np.max(absolute)),
    }


def rounded(float_srgb: np.ndarray) -> np.ndarray:
    return np.rint(np.clip(float_srgb, 0.0, 1.0) * 255.0).astype(np.uint8)


def make_contact_sheet(pairs: list[dict], photos: list[str], stocks: list[str]) -> None:
    if not pairs:
        return
    photo = photos[0]
    preferred = ["portra400", "gold200", "velvia100"]
    selected = [stock for stock in preferred if stock in stocks]
    selected.extend(stock for stock in stocks if stock not in selected)
    selected = selected[:3]
    first = pairs[0]
    original = Image.fromarray(read_rgb(first["input"]))
    tile_width = 480
    tile_height = round(original.height * tile_width / original.width)
    label_height = 38
    sheet = Image.new("RGB", (tile_width * 2, (tile_height + label_height) * len(selected)), "#151515")
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 17)
    except OSError:
        font = ImageFont.load_default()
    for row, stock in enumerate(selected):
        pair = next(item for item in pairs if item["photo"] == photo and item["stock"] == stock)
        shader = Image.fromarray(read_rgb(pair["shader"]))
        y = row * (tile_height + label_height)
        original_tile = original.resize((tile_width, tile_height), Image.Resampling.LANCZOS)
        shader_tile = shader.resize((tile_width, tile_height), Image.Resampling.LANCZOS)
        sheet.paste(original_tile, (0, y + label_height))
        sheet.paste(shader_tile, (tile_width, y + label_height))
        draw.text((12, y + 9), f"Original · {photo}", fill="#eeeeee", font=font)
        draw.text((tile_width + 12, y + 9), f"WebGL shader · {stock}", fill="#eeeeee", font=font)
    sheet.save(OUT / "contact-shader.jpg", quality=90, optimize=True)


def main() -> int:
    with (OUT / "render-results.json").open(encoding="utf-8") as handle:
        render_results = json.load(handle)
    pairs = []
    intensity_checks = []

    for index, rendered in enumerate(render_results["pairs"], start=1):
        stock = rendered["stock"]
        photo = rendered["photo"]
        original = read_rgb(rendered["input"])
        shader = read_rgb(rendered["shader"])
        lut_path = ROOT / "subpackages" / "luts" / f"{stock}.png"
        float_reference = apply_strip_lut_float(original, lut_path)
        python_output = rounded(float_reference)
        Image.fromarray(python_output).save(OUT / rendered["python"], optimize=True)
        difference = np.abs(shader.astype(np.int16) - python_output.astype(np.int16))
        amplified = np.clip(difference * DIFF_AMPLIFICATION, 0, 255).astype(np.uint8)
        Image.fromarray(amplified).save(OUT / rendered["diff"], optimize=True)
        metrics = delta_metrics(shader, python_output)
        metrics.update({
            "stock": stock,
            "photo": photo,
            "input": rendered["input"],
            "renderMs": rendered["renderMs"],
            "shader": rendered["shader"],
            "python": rendered["python"],
            "diff": rendered["diff"],
            "pass": metrics["meanDeltaE"] < MEAN_DE_LIMIT and metrics["maxDeltaE"] < MAX_DE_LIMIT,
        })
        pairs.append(metrics)

        checks = rendered.get("intensityChecks")
        if checks:
            zero = read_rgb(checks["zero"])
            zero_absolute = np.abs(zero.astype(np.int16) - original.astype(np.int16))
            half = read_rgb(checks["half"])
            original_float = original.astype(np.float32) * np.float32(1 / 255)
            half_reference = rounded(original_float * np.float32(0.5) + float_reference * np.float32(0.5))
            half_metrics = delta_metrics(half, half_reference)
            check = {
                "stock": stock,
                "photo": photo,
                "zeroMeanAbs8bit": float(np.mean(zero_absolute)),
                "zeroMaxAbs8bit": int(np.max(zero_absolute)),
                "halfMeanAbs8bit": half_metrics["meanAbs8bit"],
                "halfMaxAbs8bit": half_metrics["maxAbs8bit"],
                "halfMeanDeltaE": half_metrics["meanDeltaE"],
                "halfMaxDeltaE": half_metrics["maxDeltaE"],
            }
            check["pass"] = (
                check["zeroMaxAbs8bit"] <= INTENSITY_CODE_TOLERANCE
                and check["halfMaxAbs8bit"] <= INTENSITY_CODE_TOLERANCE
                and check["halfMeanDeltaE"] < MEAN_DE_LIMIT
                and check["halfMaxDeltaE"] < MAX_DE_LIMIT
            )
            intensity_checks.append(check)
        print(f"[{index}/{len(render_results['pairs'])}] {stock}/{photo}: "
              f"mean={metrics['meanDeltaE']:.5f}, max={metrics['maxDeltaE']:.5f}")

    make_contact_sheet(pairs, render_results["photos"], render_results["stocks"])
    render_times = [pair["renderMs"] for pair in pairs]
    all_green = all(pair["pass"] for pair in pairs) and all(check["pass"] for check in intensity_checks)
    worst_mean = max(pairs, key=lambda pair: pair["meanDeltaE"])
    worst_max = max(pairs, key=lambda pair: pair["maxDeltaE"])
    summary = {
        "allGreen": all_green,
        "pairCount": len(pairs),
        "passedPairCount": sum(pair["pass"] for pair in pairs),
        "intensityCheckCount": len(intensity_checks),
        "worstMeanDeltaE": worst_mean["meanDeltaE"],
        "worstMeanPair": f"{worst_mean['stock']}/{worst_mean['photo']}",
        "worstMaxDeltaE": worst_max["maxDeltaE"],
        "worstMaxPair": f"{worst_max['stock']}/{worst_max['photo']}",
        "worstMeanAbs8bit": max(pair["meanAbs8bit"] for pair in pairs),
        "medianRenderMs": float(statistics.median(render_times)),
    }
    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "smoke": render_results["smoke"],
        "webgl": render_results["webgl"],
        "thresholds": {
            "meanDeltaELessThan": MEAN_DE_LIMIT,
            "maxDeltaELessThan": MAX_DE_LIMIT,
            "intensityZeroMaxAbs8bitAtMost": INTENSITY_CODE_TOLERANCE,
            "intensityHalfMaxAbs8bitAtMost": INTENSITY_CODE_TOLERANCE,
        },
        "diffAmplification": DIFF_AMPLIFICATION,
        "summary": summary,
        "pairs": pairs,
        "intensityChecks": intensity_checks,
        "contactSheet": "contact-shader.jpg",
    }
    with (OUT / "report.json").open("w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, ensure_ascii=False, allow_nan=False)
        handle.write("\n")

    grouped: dict[str, list[dict]] = defaultdict(list)
    for pair in pairs:
        grouped[pair["stock"]].append(pair)
    lines = [
        "# Headless WebGL LUT verification",
        "",
        f"Generated: {report['generatedAt']}  ",
        f"Scope: {'SMOKE TEST ONLY' if report['smoke'] else 'full stock × photo matrix'}  ",
        f"WebGL renderer: `{report['webgl']['renderer']}`  ",
        f"Result: **{'PASS' if all_green else 'FAIL'}** — {summary['passedPairCount']}/{len(pairs)} pairs",
        "",
        "Every browser-downscaled input PNG is also the input to `tools/lut_apply.py`; there is no",
        "independent Python resize. ΔE2000 is computed after conversion of both 8-bit sRGB outputs",
        "to CIE Lab. Difference PNGs are absolute channel differences amplified 16× and clipped.",
        "",
        "## Overall summary",
        "",
        "| Metric | Value |",
        "|---|---:|",
        f"| Worst pair mean ΔE2000 | {summary['worstMeanDeltaE']:.6f} ({summary['worstMeanPair']}) |",
        f"| Worst pair max ΔE2000 | {summary['worstMaxDeltaE']:.6f} ({summary['worstMaxPair']}) |",
        f"| Worst pair mean abs 8-bit error | {summary['worstMeanAbs8bit']:.6f} |",
        f"| Median shader render time | {summary['medianRenderMs']:.3f} ms |",
        "",
        "Acceptance requires every pair to have mean ΔE2000 < 0.3 and max ΔE2000 < 2.0.",
        "Render timing covers draw, `gl.finish()`, and a one-pixel synchronous readback; image "
        "upload and PNG encoding are excluded.",
        "",
        "## Per-stock summary (worst across photos)",
        "",
        "| Stock | Pairs | Worst mean ΔE | Worst max ΔE | Worst mean abs code | Median ms | Pass |",
        "|---|---:|---:|---:|---:|---:|:---:|",
    ]
    for stock, stock_pairs in grouped.items():
        lines.append(
            f"| {stock} | {len(stock_pairs)} | {max(p['meanDeltaE'] for p in stock_pairs):.6f} | "
            f"{max(p['maxDeltaE'] for p in stock_pairs):.6f} | "
            f"{max(p['meanAbs8bit'] for p in stock_pairs):.6f} | "
            f"{statistics.median(p['renderMs'] for p in stock_pairs):.3f} | "
            f"{'✓' if all(p['pass'] for p in stock_pairs) else '✗'} |"
        )
    lines.extend([
        "",
        "## Per-pair measurements",
        "",
        "| Stock | Photo | Mean ΔE | p95 ΔE | Max ΔE | Mean abs code | Max abs code | ms | Pass |",
        "|---|---|---:|---:|---:|---:|---:|---:|:---:|",
    ])
    for pair in pairs:
        lines.append(
            f"| {pair['stock']} | {pair['photo']} | {pair['meanDeltaE']:.6f} | "
            f"{pair['p95DeltaE']:.6f} | {pair['maxDeltaE']:.6f} | {pair['meanAbs8bit']:.6f} | "
            f"{pair['maxAbs8bit']} | {pair['renderMs']:.3f} | {'✓' if pair['pass'] else '✗'} |"
        )
    lines.extend([
        "",
        "## Intensity checks",
        "",
        "Intensity 0 is compared directly with the downscaled original. Intensity 0.5 is compared",
        "with the rounded midpoint of the original and the unrounded NumPy LUT result. Both mix",
        "checks allow at most one 8-bit code; the half-intensity image also uses the ΔE thresholds.",
        "",
        "| Stock | Photo | 0 mean abs | 0 max abs | 0.5 mean abs | 0.5 max abs | 0.5 mean ΔE | 0.5 max ΔE | Pass |",
        "|---|---|---:|---:|---:|---:|---:|---:|:---:|",
    ])
    for check in intensity_checks:
        lines.append(
            f"| {check['stock']} | {check['photo']} | {check['zeroMeanAbs8bit']:.6f} | "
            f"{check['zeroMaxAbs8bit']} | {check['halfMeanAbs8bit']:.6f} | "
            f"{check['halfMaxAbs8bit']} | {check['halfMeanDeltaE']:.6f} | "
            f"{check['halfMaxDeltaE']:.6f} | {'✓' if check['pass'] else '✗'} |"
        )
    lines.extend([
        "",
        "Contact sheet: [`contact-shader.jpg`](contact-shader.jpg).",
        "",
    ])
    (OUT / "report.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0 if all_green else 1


if __name__ == "__main__":
    raise SystemExit(main())
