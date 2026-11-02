#!/usr/bin/env python3
"""Compare shared WebGL adjustments/thumbnails with canonical NumPy paths."""
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
from adjust import apply_lut_camera_gain, finish_adjustments, rounded_srgb  # noqa: E402
from lut_apply import apply_strip_lut_float, apply_strip_lut_srgb_float  # noqa: E402
from wb import white_balance  # noqa: E402

MEAN_DE_LIMIT = 0.3
MAX_DE_LIMIT = 2.0
INTENSITY_CODE_TOLERANCE = 1
DIFF_AMPLIFICATION = 16
STOCK_SWITCH_MS_LIMIT = 300.0


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
        "p99DeltaE": float(np.percentile(delta, 99)),
        "maxDeltaE": float(np.max(delta)),
        "meanAbs8bit": float(np.mean(absolute)),
        "maxAbs8bit": int(np.max(absolute)),
    }


def rounded(float_srgb: np.ndarray) -> np.ndarray:
    return rounded_srgb(float_srgb)


def font(size: int = 17):
    try:
        return ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", size)
    except OSError:
        return ImageFont.load_default()


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
    face = font()
    for row, stock in enumerate(selected):
        pair = next(item for item in pairs if item["photo"] == photo and item["stock"] == stock)
        shader = Image.fromarray(read_rgb(pair["shader"]))
        y = row * (tile_height + label_height)
        original_tile = original.resize((tile_width, tile_height), Image.Resampling.LANCZOS)
        shader_tile = shader.resize((tile_width, tile_height), Image.Resampling.LANCZOS)
        sheet.paste(original_tile, (0, y + label_height))
        sheet.paste(shader_tile, (tile_width, y + label_height))
        draw.text((12, y + 9), f"Original · {photo}", fill="#eeeeee", font=face)
        draw.text((tile_width + 12, y + 9), f"WebGL shader · {stock}", fill="#eeeeee", font=face)
    sheet.save(OUT / "contact-shader.jpg", quality=90, optimize=True)


def bilinear_source_sample(source: np.ndarray, width: int, height: int) -> np.ndarray:
    """Match the renderer's top-row-first, pixel-centre LINEAR image samples."""
    rgb = source.astype(np.float32) * np.float32(1.0 / 255.0)
    x = (np.arange(width, dtype=np.float32) + np.float32(0.5)) * np.float32(source.shape[1] / width) - np.float32(0.5)
    y = (np.arange(height, dtype=np.float32) + np.float32(0.5)) * np.float32(source.shape[0] / height) - np.float32(0.5)
    x0 = np.floor(x).astype(np.intp)
    y0 = np.floor(y).astype(np.intp)
    fx = (x - x0).astype(np.float32)
    fy = (y - y0).astype(np.float32)
    x0c = np.clip(x0, 0, source.shape[1] - 1)
    y0c = np.clip(y0, 0, source.shape[0] - 1)
    x1c = np.clip(x0 + 1, 0, source.shape[1] - 1)
    y1c = np.clip(y0 + 1, 0, source.shape[0] - 1)
    top = rgb[y0c[:, None], x0c[None, :]] * (1.0 - fx)[None, :, None] + rgb[y0c[:, None], x1c[None, :]] * fx[None, :, None]
    bottom = rgb[y1c[:, None], x0c[None, :]] * (1.0 - fx)[None, :, None] + rgb[y1c[:, None], x1c[None, :]] * fx[None, :, None]
    return (top * (1.0 - fy)[:, None, None] + bottom * fy[:, None, None]).astype(np.float32)


def adjustment_reference(original: np.ndarray, stock: dict, adjustments: dict,
                         intensity: float) -> np.ndarray:
    use_extended = bool(stock.get("extended")) and (
        adjustments["ev"] > 0 or adjustments["temperature"] != 0 or adjustments["tint"] != 0
    )
    variant = stock["extended"] if use_extended else stock
    path = ROOT / "subpackages" / "luts" / variant["file"]
    identity = not use_extended and all((
        adjustments["ev"] == 0, adjustments["temperature"] == 0, adjustments["tint"] == 0,
    ))
    if identity:
        graded = apply_strip_lut_float(original, path)
    else:
        headroom = variant["headroomEv"] if use_extended else 0.0
        gain = white_balance(adjustments["temperature"], adjustments["tint"])["gain"]
        gain = gain * 2.0 ** (adjustments["ev"] - headroom)
        graded = apply_lut_camera_gain(original, path, gain)
    return finish_adjustments(
        original, graded, intensity=intensity,
        contrast=adjustments["contrast"], saturation=adjustments["saturation"],
    )


def make_adjustment_contact(pairs: list[dict], stock: str) -> None:
    selected = [pair for pair in pairs if pair["stock"] == stock and not pair["case"].startswith("asset-")]
    if not selected:
        return
    original = Image.fromarray(read_rgb(selected[0]["input"]))
    tile_width = 360
    tile_height = round(original.height * tile_width / original.width)
    label_height = 42
    sheet = Image.new("RGB", (tile_width * 2, (tile_height + label_height) * len(selected)), "#151515")
    draw = ImageDraw.Draw(sheet)
    face = font(15)
    for row, pair in enumerate(selected):
        y = row * (tile_height + label_height)
        sheet.paste(original.resize((tile_width, tile_height), Image.Resampling.LANCZOS), (0, y + label_height))
        shader = Image.fromarray(read_rgb(pair["shader"])).resize((tile_width, tile_height), Image.Resampling.LANCZOS)
        sheet.paste(shader, (tile_width, y + label_height))
        draw.text((8, y + 5), f"Original | {pair['case']} | intensity {pair['intensity']}", fill="white", font=face)
        draw.text((8, y + 23), json.dumps(pair["adjustments"], separators=(",", ":")), fill="#cccccc", font=face)
    sheet.save(OUT / "contact-adjust.jpg", quality=88, optimize=True)


def make_thumbnail_contact(thumbnails: list[dict]) -> None:
    if not thumbnails:
        return
    columns = 4
    cell_width, cell_height, label_height = 216, 168, 26
    rows = (len(thumbnails) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * cell_width, rows * (cell_height + label_height)), "#151515")
    draw = ImageDraw.Draw(sheet)
    face = font(15)
    for index, thumbnail in enumerate(thumbnails):
        row, column = divmod(index, columns)
        image = Image.fromarray(read_rgb(thumbnail["file"]))
        image.thumbnail((cell_width - 12, cell_height - 12), Image.Resampling.NEAREST)
        x = column * cell_width + (cell_width - image.width) // 2
        y = row * (cell_height + label_height) + label_height + (cell_height - image.height) // 2
        sheet.paste(image, (x, y))
        draw.text((column * cell_width + 8, row * (cell_height + label_height) + 5),
                  thumbnail["stock"], fill="white", font=face)
    sheet.save(OUT / "contact-thumbs.jpg", quality=92, optimize=True)


def main() -> int:
    with (OUT / "render-results.json").open(encoding="utf-8") as handle:
        render_results = json.load(handle)
    manifest = {stock["id"]: stock for stock in json.loads(
        (ROOT / "subpackages" / "luts" / "luts.json").read_text(encoding="utf-8")
    )}
    pairs = []
    intensity_checks = []

    for index, rendered in enumerate(render_results["pairs"], start=1):
        stock = rendered["stock"]
        photo = rendered["photo"]
        original = read_rgb(rendered["input"])
        shader = read_rgb(rendered["shader"])
        lut_path = ROOT / "subpackages" / "luts" / manifest[stock]["file"]
        float_reference = apply_strip_lut_float(original, lut_path)
        python_output = rounded(float_reference)
        Image.fromarray(python_output).save(OUT / rendered["python"], optimize=True)
        difference = np.abs(shader.astype(np.int16) - python_output.astype(np.int16))
        amplified = np.clip(difference * DIFF_AMPLIFICATION, 0, 255).astype(np.uint8)
        Image.fromarray(amplified).save(OUT / rendered["diff"], optimize=True)
        result = delta_metrics(shader, python_output)
        result.update({
            "stock": stock, "photo": photo, "input": rendered["input"],
            "renderMs": rendered["renderMs"], "shader": rendered["shader"],
            "python": rendered["python"], "diff": rendered["diff"],
            "pass": result["meanDeltaE"] < MEAN_DE_LIMIT and result["maxDeltaE"] < MAX_DE_LIMIT,
        })
        pairs.append(result)

        checks = rendered.get("intensityChecks")
        if checks:
            zero = read_rgb(checks["zero"])
            zero_absolute = np.abs(zero.astype(np.int16) - original.astype(np.int16))
            half = read_rgb(checks["half"])
            original_float = original.astype(np.float32) * np.float32(1 / 255)
            half_reference = rounded(original_float * np.float32(0.5) + float_reference * np.float32(0.5))
            half_metrics = delta_metrics(half, half_reference)
            check = {
                "stock": stock, "photo": photo,
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
              f"mean={result['meanDeltaE']:.5f}, max={result['maxDeltaE']:.5f}")

    adjustments = []
    for rendered in render_results.get("adjustmentPairs", []):
        original = read_rgb(rendered["input"])
        shader = read_rgb(rendered["shader"])
        expected = rounded(adjustment_reference(
            original, manifest[rendered["stock"]], rendered["adjustments"], rendered["intensity"],
        ))
        Image.fromarray(expected).save(OUT / rendered["python"], optimize=True)
        difference = np.abs(shader.astype(np.int16) - expected.astype(np.int16))
        Image.fromarray(np.clip(difference * DIFF_AMPLIFICATION, 0, 255).astype(np.uint8)).save(
            OUT / rendered["diff"], optimize=True,
        )
        result = delta_metrics(shader, expected)
        result.update({
            "stock": rendered["stock"], "photo": rendered["photo"], "case": rendered["case"],
            "adjustments": rendered["adjustments"], "intensity": rendered["intensity"],
            "input": rendered["input"],
            "shader": rendered["shader"], "python": rendered["python"], "diff": rendered["diff"],
            "renderMs": rendered["renderMs"],
            "pass": result["meanDeltaE"] < MEAN_DE_LIMIT and result["maxDeltaE"] < MAX_DE_LIMIT,
        })
        adjustments.append(result)
        print(f"[adjust] {result['stock']}/{result['case']}: mean={result['meanDeltaE']:.5f}, "
              f"max={result['maxDeltaE']:.5f}, maxCode={result['maxAbs8bit']}")

    thumbnails = []
    original = read_rgb(render_results["pairs"][0]["input"])
    for rendered in render_results.get("thumbnails", []):
        actual = read_rgb(rendered["file"])
        sampled = bilinear_source_sample(original, rendered["width"], rendered["height"])
        expected = rounded(apply_strip_lut_srgb_float(
            sampled, ROOT / "subpackages" / "luts" / manifest[rendered["stock"]]["file"],
        ))
        result = delta_metrics(actual, expected)
        result.update(rendered)
        result["pass"] = bool(
            rendered["restored"]
            and rendered["liveAdjustments"]["ev"] == 1
            and result["meanDeltaE"] < MEAN_DE_LIMIT
            and result["maxDeltaE"] < MAX_DE_LIMIT
            and float(np.std(actual)) > 1.0
        )
        thumbnails.append(result)

    make_contact_sheet(pairs, render_results["photos"], render_results["stocks"])
    make_adjustment_contact(adjustments, render_results["stocks"][0])
    make_thumbnail_contact(thumbnails)
    render_times = [pair["renderMs"] for pair in pairs]
    thumbnail_switches = [item["switchMs"] for item in thumbnails]
    full_switches = [item["switchMs"] for item in render_results.get("stockSwitches", [])]
    median_thumbnail_switch = float(statistics.median(thumbnail_switches)) if thumbnail_switches else 0.0
    median_full_switch = float(statistics.median(full_switches)) if full_switches else 0.0
    expected_count = 1 if render_results["smoke"] else 11
    timing_pass = bool(
        len(thumbnails) == expected_count and len(full_switches) == expected_count
        and median_thumbnail_switch < STOCK_SWITCH_MS_LIMIT
        and median_full_switch < STOCK_SWITCH_MS_LIMIT
    )
    all_green = bool(
        all(pair["pass"] for pair in pairs) and all(check["pass"] for check in intensity_checks)
        and all(pair["pass"] for pair in adjustments) and all(item["pass"] for item in thumbnails)
        and timing_pass
        and bool(render_results.get("lutContract", {}).get("noExtended"))
        and bool(render_results.get("lutContract", {}).get("drawWithoutExtendedThrows"))
        and bool(render_results.get("lutContract", {}).get("extendedAccepted"))
    )
    worst_mean = max(pairs, key=lambda pair: pair["meanDeltaE"])
    worst_max = max(pairs, key=lambda pair: pair["maxDeltaE"])
    summary = {
        "allGreen": all_green,
        "pairCount": len(pairs), "passedPairCount": sum(pair["pass"] for pair in pairs),
        "intensityCheckCount": len(intensity_checks),
        "adjustmentPairCount": len(adjustments),
        "passedAdjustmentPairCount": sum(pair["pass"] for pair in adjustments),
        "worstAdjustmentMeanDeltaE": max((pair["meanDeltaE"] for pair in adjustments), default=0.0),
        "worstAdjustmentMaxDeltaE": max((pair["maxDeltaE"] for pair in adjustments), default=0.0),
        "thumbnailCount": len(thumbnails),
        "passedThumbnailCount": sum(item["pass"] for item in thumbnails),
        "worstMeanDeltaE": worst_mean["meanDeltaE"],
        "worstMeanPair": f"{worst_mean['stock']}/{worst_mean['photo']}",
        "worstMaxDeltaE": worst_max["maxDeltaE"],
        "worstMaxPair": f"{worst_max['stock']}/{worst_max['photo']}",
        "worstMeanAbs8bit": max(pair["meanAbs8bit"] for pair in pairs),
        "medianRenderMs": float(statistics.median(render_times)),
        "medianThumbnailSwitchMs": median_thumbnail_switch,
        "medianFullStockSwitchMs": median_full_switch,
        "timingPass": timing_pass,
    }
    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "smoke": render_results["smoke"], "webgl": render_results["webgl"],
        "thresholds": {
            "meanDeltaELessThan": MEAN_DE_LIMIT, "maxDeltaELessThan": MAX_DE_LIMIT,
            "intensityZeroMaxAbs8bitAtMost": INTENSITY_CODE_TOLERANCE,
            "intensityHalfMaxAbs8bitAtMost": INTENSITY_CODE_TOLERANCE,
            "medianStockSwitchMsLessThan": STOCK_SWITCH_MS_LIMIT,
        },
        "diffAmplification": DIFF_AMPLIFICATION, "summary": summary, "pairs": pairs,
        "intensityChecks": intensity_checks, "adjustmentPairs": adjustments,
        "thumbnails": thumbnails, "stockSwitches": render_results.get("stockSwitches", []),
        "contactSheet": "contact-shader.jpg",
        "adjustmentContactSheet": "contact-adjust.jpg", "thumbnailContactSheet": "contact-thumbs.jpg",
    }
    with (OUT / "report.json").open("w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, ensure_ascii=False, allow_nan=False)
        handle.write("\n")

    grouped: dict[str, list[dict]] = defaultdict(list)
    for pair in pairs:
        grouped[pair["stock"]].append(pair)
    lines = [
        "# Headless WebGL LUT and adjustment verification", "",
        f"Generated: {report['generatedAt']}  ",
        f"Scope: {'SMOKE TEST ONLY' if report['smoke'] else 'full stock × photo matrix'}  ",
        f"WebGL renderer: `{report['webgl']['renderer']}`  ",
        f"Result: **{'PASS' if all_green else 'FAIL'}** — {summary['passedPairCount']}/{len(pairs)} default pairs, "
        f"{summary['passedAdjustmentPairCount']}/{len(adjustments)} adjustment pairs, "
        f"{summary['passedThumbnailCount']}/{len(thumbnails)} thumbnails", "",
        "Every browser-downscaled input PNG is also the NumPy input. ΔE2000 uses 8-bit sRGB → Lab. "
        "Difference PNGs show absolute channel differences amplified 16×.", "",
        "## Overall summary", "", "| Metric | Value |", "|---|---:|",
        f"| Worst default pair mean ΔE2000 | {summary['worstMeanDeltaE']:.6f} ({summary['worstMeanPair']}) |",
        f"| Worst default pair max ΔE2000 | {summary['worstMaxDeltaE']:.6f} ({summary['worstMaxPair']}) |",
        f"| Worst adjustment mean ΔE2000 | {summary['worstAdjustmentMeanDeltaE']:.6f} |",
        f"| Worst adjustment max ΔE2000 | {summary['worstAdjustmentMaxDeltaE']:.6f} |",
        f"| Median default render/readback | {summary['medianRenderMs']:.3f} ms |",
        f"| Median thumbnail setLut+render+readback | {median_thumbnail_switch:.3f} ms |",
        f"| Median full-preview stock switch | {median_full_switch:.3f} ms |", "",
        "All numerical pairs require mean ΔE2000 <0.3 and max <2.0. Intensity zero uses extreme "
        "camera/post settings and must still return the untouched original within one code. "
        "Thumbnail references sample the full-resolution source at the same pixel-centre coordinates; "
        "they also check framebuffer/viewport restoration and independence from live adjustments.", "",
        "## Per-stock default summary (worst across photos)", "",
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
    lines.extend(["", "## Default per-pair measurements", "",
                  "| Stock | Photo | Mean ΔE | p95 ΔE | Max ΔE | Mean abs code | Max abs code | ms | Pass |",
                  "|---|---|---:|---:|---:|---:|---:|---:|:---:|"])
    for pair in pairs:
        lines.append(f"| {pair['stock']} | {pair['photo']} | {pair['meanDeltaE']:.6f} | "
                     f"{pair['p95DeltaE']:.6f} | {pair['maxDeltaE']:.6f} | {pair['meanAbs8bit']:.6f} | "
                     f"{pair['maxAbs8bit']} | {pair['renderMs']:.3f} | {'✓' if pair['pass'] else '✗'} |")
    lines.extend(["", "## EV / WB / post-adjustment shader versus NumPy", "",
                  "| Stock | Case | Intensity | Mean ΔE | p95 | p99 | Max ΔE | Max code | Pass |",
                  "|---|---|---:|---:|---:|---:|---:|---:|:---:|"])
    for pair in adjustments:
        lines.append(f"| {pair['stock']} | {pair['case']} | {pair['intensity']} | "
                     f"{pair['meanDeltaE']:.6f} | {pair['p95DeltaE']:.6f} | {pair['p99DeltaE']:.6f} | "
                     f"{pair['maxDeltaE']:.6f} | {pair['maxAbs8bit']} | {'✓' if pair['pass'] else '✗'} |")
    lines.extend(["", "## Intensity checks", "",
                  "| Stock | Photo | 0 mean abs | 0 max abs | 0.5 mean abs | 0.5 max abs | 0.5 mean ΔE | 0.5 max ΔE | Pass |",
                  "|---|---|---:|---:|---:|---:|---:|---:|:---:|"])
    for check in intensity_checks:
        lines.append(f"| {check['stock']} | {check['photo']} | {check['zeroMeanAbs8bit']:.6f} | "
                     f"{check['zeroMaxAbs8bit']} | {check['halfMeanAbs8bit']:.6f} | {check['halfMaxAbs8bit']} | "
                     f"{check['halfMeanDeltaE']:.6f} | {check['halfMaxDeltaE']:.6f} | {'✓' if check['pass'] else '✗'} |")
    lines.extend(["", "## Thumbnails and stock-switch timing", "",
                  "| Stock | Size | Mean ΔE | Max ΔE | Thumbnail switch ms | Full switch ms | Pass |",
                  "|---|---:|---:|---:|---:|---:|:---:|"])
    full_by_stock = {item["stock"]: item["switchMs"] for item in render_results.get("stockSwitches", [])}
    for item in thumbnails:
        lines.append(f"| {item['stock']} | {item['width']}×{item['height']} | {item['meanDeltaE']:.6f} | "
                     f"{item['maxDeltaE']:.6f} | {item['switchMs']:.3f} | {full_by_stock[item['stock']]:.3f} | "
                     f"{'✓' if item['pass'] else '✗'} |")
    lines.extend(["", f"Median thumbnail switch **{median_thumbnail_switch:.3f} ms**; full-preview switch "
                  f"**{median_full_switch:.3f} ms**; both must be <300 ms: **{'PASS' if timing_pass else 'FAIL'}**.", "",
                  "Contact sheets: [`contact-shader.jpg`](contact-shader.jpg), "
                  "[`contact-adjust.jpg`](contact-adjust.jpg), [`contact-thumbs.jpg`](contact-thumbs.jpg).", ""])
    (OUT / "report.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0 if all_green else 1


if __name__ == "__main__":
    raise SystemExit(main())
