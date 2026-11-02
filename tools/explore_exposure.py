#!/usr/bin/env python3
"""Sweep global physical exposure/scan recipes with real `simulate()` runs."""
from __future__ import annotations

import argparse
import gc
import json
import math
from pathlib import Path
from time import perf_counter

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from spektrafilm.utils.autoexposure import measure_autoexposure_ev

from image_fixtures import load_fixture, prepare_phone_fixtures
from pipeline_config import (
    AUTO_EXPOSURE_MEDIAN_EV,
    BUILD_DIR,
    NATIVE_STOPS_ABOVE_MIDGRAY,
    PHYSICAL_RECIPE,
    ROOT,
    load_stocks,
    simulate_srgb,
)

OUT_DIR = BUILD_DIR / "exposure"
REPORT_JSON = OUT_DIR / "exploration.json"
REPORT_MD = ROOT / "docs" / "EXPOSURE.md"
RAMP_CODES = np.array([0, 20, 45, 60, 80, 118, 170, 200, 230, 255], dtype=np.uint8)
PHOTO_CANDIDATES = ("native_baseline", "native_scan_zero", "native_scan_median", "plus4_scan_median")
PREVIEW_STOCKS = ("portra400", "ektar100", "velvia100")


def candidate_definitions(median_ev: float) -> dict[str, dict]:
    return {
        "native_baseline": {
            "stops": NATIVE_STOPS_ABOVE_MIDGRAY,
            "overrides": {
                "camera_exposure_compensation_ev": 0.0,
                "enlarger_print_exposure_compensation": False,
                "scanner_white_correction": False,
                "scanner_black_correction": False,
            },
            "description": "Native gain; old LUT-mode print/scanner resets; no post curve.",
        },
        "native_scan_zero": {
            "stops": NATIVE_STOPS_ABOVE_MIDGRAY,
            "overrides": {"camera_exposure_compensation_ev": 0.0},
            "description": "Native gain; 0 camera EV; normalized print; scanner W+B.",
        },
        "native_scan_median": {
            "stops": NATIVE_STOPS_ABOVE_MIDGRAY,
            "overrides": {"camera_exposure_compensation_ev": median_ev},
            "description": "Native gain; measured median camera EV; normalized print; scanner W+B.",
        },
        "plus4_scan_zero": {
            "stops": 4.0,
            "overrides": {"camera_exposure_compensation_ev": 0.0},
            "description": "Upstream +4-stop SDR convention; 0 camera EV; scanner W+B.",
        },
        "plus4_scan_median": {
            "stops": 4.0,
            "overrides": {"camera_exposure_compensation_ev": median_ev},
            "description": "Upstream +4-stop SDR convention plus measured median camera EV.",
        },
        "native_white_only": {
            "stops": NATIVE_STOPS_ABOVE_MIDGRAY,
            "overrides": {
                "camera_exposure_compensation_ev": median_ev,
                "scanner_black_correction": False,
            },
            "description": "Isolate scanner white normalization (black correction off).",
        },
        "native_black_only": {
            "stops": NATIVE_STOPS_ABOVE_MIDGRAY,
            "overrides": {
                "camera_exposure_compensation_ev": median_ev,
                "scanner_white_correction": False,
            },
            "description": "Isolate scanner black normalization (white correction off).",
        },
        "native_no_print_comp": {
            "stops": NATIVE_STOPS_ABOVE_MIDGRAY,
            "overrides": {
                "camera_exposure_compensation_ev": median_ev,
                "enlarger_print_exposure_compensation": False,
            },
            "description": "Scanner W+B; print normalized but camera compensation off.",
        },
        "native_no_print_norm": {
            "stops": NATIVE_STOPS_ABOVE_MIDGRAY,
            "overrides": {
                "camera_exposure_compensation_ev": median_ev,
                "enlarger_normalize_print_exposure": False,
            },
            "description": "Scanner W+B; print midgray normalization off.",
        },
        "native_print_minus_0_5": {
            "stops": NATIVE_STOPS_ABOVE_MIDGRAY,
            "overrides": {
                "camera_exposure_compensation_ev": median_ev,
                "enlarger_print_exposure_ev": -0.5,
            },
            "description": "Selected physical family with -0.5 EV enlarger exposure.",
        },
        "native_print_plus_0_5": {
            "stops": NATIVE_STOPS_ABOVE_MIDGRAY,
            "overrides": {
                "camera_exposure_compensation_ev": median_ev,
                "enlarger_print_exposure_ev": 0.5,
            },
            "description": "Selected physical family with +0.5 EV enlarger exposure.",
        },
    }


def _neutral_image() -> np.ndarray:
    values = RAMP_CODES.astype(np.float64) / 255.0
    padded = np.pad(values, (0, 6), mode="edge")
    return np.repeat(padded.reshape(4, 4, 1), 3, axis=2)


def _ramp_metrics(encoded: np.ndarray) -> dict:
    rgb = np.clip(encoded.reshape(-1, 3)[:RAMP_CODES.size], 0.0, 1.0) * 255.0
    means = np.mean(rgb, axis=1)
    spread = np.max(rgb, axis=1) - np.min(rgb, axis=1)
    return {
        "input_codes": RAMP_CODES.astype(int).tolist(),
        "output_rgb8": rgb.tolist(),
        "output_mean8": means.tolist(),
        "channel_spread8": spread.tolist(),
        "max_channel_spread8": float(np.max(spread)),
        "white_reach8": float(means[-1]),
        "midtone_118_mean8": float(means[5]),
        "shadow_60_mean8": float(means[3]),
        "highlight_230_255_monotonic": bool(means[-1] > means[-2]),
    }


def _linear_y(encoded: np.ndarray) -> np.ndarray:
    from spektrafilm_lut_creator.color_spaces import decode_cctf

    linear = decode_cctf(np.clip(encoded, 0.0, 1.0), "sRGB")
    return linear @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float64)


def _photo_metrics(source: np.ndarray, encoded: np.ndarray) -> dict:
    source_float = source.astype(np.float64) / 255.0
    input_y = _linear_y(source_float)
    output_y = _linear_y(encoded)
    input_luma8 = (source_float @ np.array([0.2126, 0.7152, 0.0722])) * 255.0
    output_luma8 = (np.clip(encoded, 0.0, 1.0) @ np.array([0.2126, 0.7152, 0.0722])) * 255.0
    return {
        "input_mean_luminance": float(np.mean(input_y)),
        "output_mean_luminance": float(np.mean(output_y)),
        "luminance_preservation_ratio": float(np.mean(output_y) / max(np.mean(input_y), 1e-12)),
        "input_mean_encoded_luma8": float(np.mean(input_luma8)),
        "output_mean_encoded_luma8": float(np.mean(output_luma8)),
        "mean_encoded_luma8_delta": float(np.mean(output_luma8) - np.mean(input_luma8)),
    }


def _font(size: int):
    try:
        return ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", size=size)
    except OSError:
        return ImageFont.load_default()


def _write_preview(preview: dict, candidates: dict) -> None:
    if not preview:
        return
    width, height, label = 360, 240, 48
    columns = len(PHOTO_CANDIDATES) + 1
    rows = len(PREVIEW_STOCKS)
    sheet = Image.new("RGB", (columns * width, rows * (height + label)), (20, 20, 22))
    draw = ImageDraw.Draw(sheet)
    font = _font(15)
    for row, stock_id in enumerate(PREVIEW_STOCKS):
        for col, candidate in enumerate(("original", *PHOTO_CANDIDATES)):
            array = preview.get((stock_id, candidate))
            if array is None:
                continue
            image = Image.fromarray(array, mode="RGB").resize((width, height), Image.Resampling.LANCZOS)
            x, y = col * width, row * (height + label)
            sheet.paste(image, (x, y))
            draw.text((x + 7, y + height + 6), f"{stock_id} | {candidate}", fill="white", font=font)
    path = OUT_DIR / "candidate-preview.jpg"
    sheet.save(path, format="JPEG", quality=90, subsampling=0, optimize=True)


def _write_reports(report: dict, candidates: dict) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_JSON.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")

    intro = REPORT_MD.read_text(encoding="utf-8") if REPORT_MD.exists() else "# Phase 1c exposure exploration\n"
    intro = intro.split("## Sweep results", 1)[0].rstrip()
    lines = [intro, "", "## Sweep results", ""]
    lines.extend([
        "The exploration uses 4×4 neutral-ramp images and all six phone photos downscaled to at",
        "most 240,000 pixels. Photo luminance preservation is mean linear Rec.709 Y after the",
        "physical pipeline divided by input mean Y; encoded-luma delta is included to make bright-",
        "ness changes easier to read. Both are exposure diagnostics, not LUT-versus-reference errors.",
        "",
        "### Candidates",
        "",
        "| ID | Stops above gray | Camera EV | Scanner W/B | Print comp/norm | Print EV | Purpose |",
        "|---|---:|---:|:---:|:---:|---:|---|",
    ])
    for candidate_id, candidate in candidates.items():
        merged = dict(PHYSICAL_RECIPE)
        merged.update(candidate["overrides"])
        lines.append(
            f"| `{candidate_id}` | {candidate['stops']:.6f} | "
            f"{merged['camera_exposure_compensation_ev']:+.6f} | "
            f"{'on' if merged['scanner_white_correction'] else 'off'}/"
            f"{'on' if merged['scanner_black_correction'] else 'off'} | "
            f"{'on' if merged['enlarger_print_exposure_compensation'] else 'off'}/"
            f"{'on' if merged['enlarger_normalize_print_exposure'] else 'off'} | "
            f"{merged['enlarger_print_exposure_ev']:+.2f} | {candidate['description']} |"
        )

    for candidate_id, candidate in candidates.items():
        lines.extend([
            "",
            f"### Neutral ramp — `{candidate_id}`",
            "",
            "Values are display sRGB mean R/G/B at inputs 0, 20, 45, 60, 80, 118, 170, 200, 230, 255.",
            "Spread is the maximum neutral R/G/B channel spread over those inputs.",
            "",
            "| Stock | 0 | 20 | 45 | 60 | 80 | 118 | 170 | 200 | 230 | 255 | Max spread |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ])
        for stock in report["stocks"]:
            result = stock["candidates"].get(candidate_id)
            if result is None:
                continue
            ramp = result["ramp"]
            values = " | ".join(f"{value:.1f}" for value in ramp["output_mean8"])
            lines.append(f"| {stock['name']} | {values} | {ramp['max_channel_spread8']:.1f} |")

    for candidate_id in PHOTO_CANDIDATES:
        lines.extend([
            "",
            f"### Phone-photo exposure — `{candidate_id}`",
            "",
            "| Stock | p1015 Y ratio | p1025 Y ratio | p1043 Y ratio | p1062 Y ratio | p237 Y ratio | p433 Y ratio | Median Y ratio | Mean luma delta (8-bit) |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ])
        for stock in report["stocks"]:
            result = stock["candidates"].get(candidate_id)
            if result is None or not result.get("photos"):
                continue
            photos = result["photos"]
            ratios = [photos[f"phone_{pid}"]["luminance_preservation_ratio"] for pid in ("p1015", "p1025", "p1043", "p1062", "p237", "p433")]
            delta = float(np.mean([value["mean_encoded_luma8_delta"] for value in photos.values()]))
            lines.append(
                f"| {stock['name']} | " + " | ".join(f"{value:.3f}" for value in ratios)
                + f" | {float(np.median(ratios)):.3f} | {delta:+.2f} |"
            )

    lines.extend([
        "",
        "### Final global selection and reasoning",
        "",
        "**Selected:** native sRGB headroom `stops_above_midgray=log2(1/0.18)=2.473931188332`",
        "(input gain 1.0), fixed camera compensation **-0.652249582 EV** (the measured median),",
        "print exposure **1.0** (0 EV), print exposure compensation and midgray normalization **on**,",
        "TH-KG3 and database neutral filters, scanner white+black correction **on** at 0.98/0.01,",
        "and default input/output gamut compression. Positive stocks alone take `scan_film=True`.",
        "This is one recipe for all 11 stocks, with no per-stock exposure or neutral fitting.",
        "",
        "The +4-stop candidate is rejected for display-referred phone JPEGs. With the same median",
        "camera EV, its across-stock median photo Y ratio is **1.652**, mean encoded-luma change is",
        "**+33.71/255**, and negative-stock code 118 becomes roughly 182–212. The comparison image",
        "shows blown blankets/foliage, especially Ektar. Native gain plus the median has an overall",
        "median Y ratio of **0.870** and mean luma change **-17.04/255**; for the eight negative/print",
        "stocks the median per-stock Y ratios are 0.838–0.938. It retains a contrasty but plausible",
        "film exposure instead of manufacturing shoulder headroom by overexposing every midtone.",
        "",
        "Print compensation/normalization is retained from the physical GUI/filmroom defaults. With",
        "native gain and scanner correction, disabling print camera compensation drops negative code",
        "118 to roughly 77–85; a -0.5 EV print exposure instead raises it to about 160–164. These",
        "large movements are not a neutral exposure trim and are not used to chase ramp targets.",
        "",
        "Scanner normalization raises white reach only modestly. The selected recipe reaches about",
        "199.5 (Kodachrome) to 225.3 (Ektar), not the soft ~240 goal. Ektar remains deliberately",
        "dark/punchy (code 60 ≈14.6; code 118 ≈110.6), and Vision3 retains a physical neutral channel",
        "spread around 15 codes. No white-level, channel-alignment, or shadow-lift hack is added.",
        "",
        "**Known global-recipe trade-off:** direct positive scans have no print stage to compensate",
        "camera EV. Their selected code-118 values are about 81–85 and median photo Y ratios 0.594–",
        "0.657, versus 0.920–1.032 at zero camera EV. Thus the Plan-mandated measured-median fixed EV",
        "makes all three slide looks darker than the normally exposed phone originals. Zero EV would",
        "be preferable for slides in isolation, but selecting it only for slides would violate the",
        "one-global-recipe rule. This soft-goal miss is accepted and disclosed, not fitted away.",
        "",
        "The spektrafilm GUI and filmroom both default scanner corrections off. Enabling them here is",
        "therefore an explicit physical scan-normalization choice, not a claim about application",
        "defaults; the bake and every reference restore exactly the same settings after `lut_mode`.",
        "",
    ])
    REPORT_MD.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stock", action="append", dest="stock_ids")
    parser.add_argument("--skip-photos", action="store_true")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fixtures = prepare_phone_fixtures(max_pixels=240_000)
    auto_measurements = {}
    for fixture in fixtures:
        # Meter the supplied full-resolution JPEGs, not their downscaled
        # simulation derivatives; resizing slightly changes the weighted mean.
        source_path = Path(fixture["source"])
        with Image.open(source_path) as image:
            source = np.asarray(image.convert("RGB"), dtype=np.float64) / 255.0
        auto_measurements[fixture["id"]] = float(measure_autoexposure_ev(
            source, color_space="sRGB", apply_cctf_decoding=True, method="center_weighted",
        ))
        del source
    median_ev = float(np.median(list(auto_measurements.values())))
    if not math.isclose(median_ev, AUTO_EXPOSURE_MEDIAN_EV, abs_tol=1e-5):
        raise RuntimeError(f"Measured median {median_ev} differs from configured {AUTO_EXPOSURE_MEDIAN_EV}")
    candidates = candidate_definitions(median_ev)
    report = {
        "auto_exposure_ev": auto_measurements,
        "auto_exposure_median_ev": median_ev,
        "native_stops_above_midgray": NATIVE_STOPS_ABOVE_MIDGRAY,
        "plus4_input_gain": 0.18 * 2.0 ** 4.0,
        "photo_max_pixels": 240_000,
        "stocks": [],
    }

    stocks = load_stocks()
    if args.stock_ids:
        selected = set(args.stock_ids)
        stocks = [stock for stock in stocks if stock["id"] in selected]
    preview = {}
    for stock in stocks:
        started = perf_counter()
        print(f"[explore] {stock['id']}", flush=True)
        stock_record = {"id": stock["id"], "name": stock["name"], "candidates": {}}
        for candidate_id, candidate in candidates.items():
            encoded = simulate_srgb(
                _neutral_image(), stock,
                stops_above_midgray=candidate["stops"], overrides=candidate["overrides"],
            )
            result = {"ramp": _ramp_metrics(encoded), "photos": {}}
            del encoded
            if candidate_id in PHOTO_CANDIDATES and not args.skip_photos:
                for fixture in fixtures:
                    source = load_fixture(fixture)
                    output = simulate_srgb(
                        source.astype(np.float64) / 255.0, stock,
                        stops_above_midgray=candidate["stops"], overrides=candidate["overrides"],
                    )
                    result["photos"][fixture["id"]] = _photo_metrics(source, output)
                    if (
                        stock["id"] in PREVIEW_STOCKS
                        and fixture["id"] == "phone_p1025"
                    ):
                        preview[(stock["id"], "original")] = source
                        preview[(stock["id"], candidate_id)] = np.rint(
                            np.clip(output, 0.0, 1.0) * 255.0
                        ).astype(np.uint8)
                    del source, output
                    gc.collect()
            stock_record["candidates"][candidate_id] = result
            ramp = result["ramp"]
            print(
                f"  {candidate_id:24s} 60={ramp['shadow_60_mean8']:6.1f} "
                f"118={ramp['midtone_118_mean8']:6.1f} white={ramp['white_reach8']:6.1f} "
                f"spread={ramp['max_channel_spread8']:5.1f}",
                flush=True,
            )
            gc.collect()
        stock_record["seconds"] = round(perf_counter() - started, 3)
        report["stocks"].append(stock_record)
        _write_reports(report, candidates)
        _write_preview(preview, candidates)
        print(f"[timing] {stock['id']}: {stock_record['seconds']:.2f}s", flush=True)

    print(f"[done] median auto-exposure={median_ev:+.9f} EV; wrote {REPORT_JSON} and {REPORT_MD}")


if __name__ == "__main__":
    main()
