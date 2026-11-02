#!/usr/bin/env python3
"""Validate tiled LUTs against identical full spektrafilm simulate() runs."""
from __future__ import annotations

import argparse
import gc
import json
import math
import shutil
from pathlib import Path
from time import perf_counter

import numpy as np
from skimage.color import deltaE_ciede2000, rgb2lab
from spektrafilm_lut_creator.formats import get_format

from image_fixtures import load_fixture, prepare_fixtures
from lut_apply import apply_cube_lut, apply_strip_lut
from pipeline_config import (
    BUILD_DIR,
    LUT_COLS,
    LUT_RESOLUTIONS,
    MAX_LUT_DIRECTORY_BYTES,
    RAMP_CODES,
    ROOT,
    effective_stock_parameters,
    load_stocks,
    read_bake_manifest,
    recipe_snapshot,
    simulate_srgb,
)

VALIDATION_JSON = ROOT / "docs" / "validation.json"
VALIDATION_MD = ROOT / "docs" / "validation.md"
STUDY_JSON = BUILD_DIR / "resolution-study.json"
CHOICE_JSON = BUILD_DIR / "selected_resolution.json"
STOCK_RESULT_DIR = BUILD_DIR / "validation-stocks"
DELTA_DIR = BUILD_DIR / "validation-deltas"
SUBSET_NAMES = (
    "shadows_Lstar_lt_20",
    "highlights_Lstar_gt_85",
    "saturated_Cstarab_gt_50",
)
NATURAL_MEAN_LIMIT = 1.0
NATURAL_P95_LIMIT = 3.0
RESOLUTION_P95_TOLERANCE = 0.1
_CHUNK = 65_536


def _stats(delta_e: np.ndarray) -> dict:
    return {
        "mean_dE2000": float(np.mean(delta_e, dtype=np.float64)),
        "p95_dE2000": float(np.percentile(delta_e, 95)),
        "p99_dE2000": float(np.percentile(delta_e, 99)),
        "max_dE2000": float(np.max(delta_e)),
    }


def _metrics(reference: np.ndarray, applied: np.ndarray,
             reference_lab: np.ndarray | None = None,
             subsets: bool = False) -> tuple[dict, np.ndarray]:
    """Chunked CIEDE2000 metrics with reference-defined tonal/chroma subsets."""
    reference = np.clip(np.asarray(reference, dtype=np.float64), 0.0, 1.0)
    applied = np.clip(np.asarray(applied, dtype=np.float64), 0.0, 1.0)
    ref_flat = reference.reshape(-1, 3)
    app_flat = applied.reshape(-1, 3)
    if reference_lab is None:
        reference_lab = rgb2lab(reference)
    lab_flat = reference_lab.reshape(-1, 3)
    delta = np.empty(ref_flat.shape[0], dtype=np.float32)
    abs_sum = 0.0
    for start in range(0, ref_flat.shape[0], _CHUNK):
        stop = min(start + _CHUNK, ref_flat.shape[0])
        applied_lab = rgb2lab(app_flat[start:stop])
        delta[start:stop] = deltaE_ciede2000(
            lab_flat[start:stop], applied_lab
        ).astype(np.float32)
        abs_sum += float(np.sum(np.abs(
            ref_flat[start:stop] * 255.0 - app_flat[start:stop] * 255.0
        ), dtype=np.float64))
    result = {
        **_stats(delta),
        "mean_abs_8bit": abs_sum / delta.size,
        "pixels": int(delta.size),
        "reference_mean_srgb": float(np.mean(reference, dtype=np.float64)),
        "lut_mean_srgb": float(np.mean(applied, dtype=np.float64)),
    }
    if subsets:
        lightness = lab_flat[:, 0]
        chroma = np.hypot(lab_flat[:, 1], lab_flat[:, 2])
        masks = {
            "shadows_Lstar_lt_20": lightness < 20.0,
            "highlights_Lstar_gt_85": lightness > 85.0,
            "saturated_Cstarab_gt_50": chroma > 50.0,
        }
        result["subsets"] = {}
        for name, mask in masks.items():
            values = delta[mask]
            result["subsets"][name] = {
                **(_stats(values) if values.size else {
                    "mean_dE2000": None, "p95_dE2000": None,
                    "p99_dE2000": None, "max_dE2000": None,
                }),
                "pixels": int(values.size),
                "coverage_percent": float(np.mean(mask) * 100.0),
            }
    return result, delta


def _load_assets(stock: dict, resolution: int) -> dict:
    manifest_path = BUILD_DIR / f"bake-manifest-{resolution}.json"
    bake = read_bake_manifest(manifest_path)
    record = next(item for item in bake["stocks"] if item["id"] == stock["id"])
    grid_dir = BUILD_DIR / "tiled" / str(resolution)
    grid_manifest = json.loads((grid_dir / "luts.json").read_text(encoding="utf-8"))
    grid_record = next(item for item in grid_manifest if item["id"] == stock["id"])
    cube = get_format("cube").read(ROOT / record["cube"])
    table = np.asarray(cube.table, dtype=np.float32)
    quantized = np.rint(np.clip(table, 0.0, 1.0) * 255.0).astype(np.float32) / 255.0
    return {
        "table": table,
        "quantized_table": quantized,
        "png": grid_dir / grid_record["file"],
        "grid": grid_record,
        "bake_record": record,
        "bake_settings": bake["settings"],
        "package_bytes": sum(
            path.stat().st_size for path in grid_dir.iterdir() if path.is_file()
        ),
    }


def _neutral_ramp() -> np.ndarray:
    return np.repeat(RAMP_CODES[None, :, None], 3, axis=2).astype(np.uint8)


def _ramp_record(reference: np.ndarray, applied: np.ndarray) -> dict:
    reference = np.clip(reference.reshape(-1, 3), 0.0, 1.0) * 255.0
    applied = applied.reshape(-1, 3).astype(np.float64)
    ref_mean = np.mean(reference, axis=1)
    lut_mean = np.mean(applied, axis=1)
    spread = np.ptp(applied, axis=1)
    indices = {int(code): index for index, code in enumerate(RAMP_CODES)}
    physical_strict = bool(
        ref_mean[indices[230]] < ref_mean[indices[250]] < ref_mean[indices[255]]
    )
    lut_strict = bool(
        lut_mean[indices[230]] < lut_mean[indices[250]] < lut_mean[indices[255]]
    )
    lut_non_decreasing = bool(
        lut_mean[indices[230]] <= lut_mean[indices[250]] <= lut_mean[indices[255]]
    )
    physical_steps = [
        float(ref_mean[indices[250]] - ref_mean[indices[230]]),
        float(ref_mean[indices[255]] - ref_mean[indices[250]]),
    ]
    lut_steps = [
        float(lut_mean[indices[250]] - lut_mean[indices[230]]),
        float(lut_mean[indices[255]] - lut_mean[indices[250]]),
    ]
    # An 8-bit table cannot strictly encode a physical rise smaller than one
    # code after rounding. Accept only a non-decreasing, sub-one-code plateau;
    # reversals and plateaus spanning >=1 physical code remain hard failures.
    quantization_plateau = bool(
        physical_strict and not lut_strict and lut_non_decreasing
        and all(lut_step > 0.0 or physical_step < 1.0
                for lut_step, physical_step in zip(lut_steps, physical_steps))
    )
    return {
        "input_codes": RAMP_CODES.astype(int).tolist(),
        "physical_output_rgb8": reference.tolist(),
        "physical_output_mean8": ref_mean.tolist(),
        "lut_output_rgb8": applied.astype(int).tolist(),
        "lut_output_mean8": lut_mean.tolist(),
        "lut_channel_spread8": spread.tolist(),
        "max_lut_channel_spread8": float(np.max(spread)),
        "physical_near_white_steps8": physical_steps,
        "lut_near_white_steps8": lut_steps,
        "physical_near_white_strictly_monotonic": physical_strict,
        "lut_near_white_strictly_monotonic": lut_strict,
        "lut_near_white_non_decreasing": lut_non_decreasing,
        "quantization_limited_plateau": quantization_plateau,
        "lut_did_not_introduce_flat_top": bool(
            lut_strict or quantization_plateau
            or (not physical_strict and lut_non_decreasing)
        ),
    }


def validate_stock(stock: dict, fixtures: list[dict], resolutions: list[int]) -> dict:
    assets = {n: _load_assets(stock, n) for n in resolutions}
    by_resolution = {
        n: {"id": stock["id"], "name": stock["name"], "resolution": n, "images": []}
        for n in resolutions
    }
    natural_deltas = {n: [] for n in resolutions}
    natural_subset_deltas = {
        n: {name: [] for name in SUBSET_NAMES} for n in resolutions
    }
    for fixture in fixtures:
        source = load_fixture(fixture)
        # Public full simulate(), exactly the selected physical recipe. This is
        # computed once and reused for every candidate cube resolution.
        reference = np.clip(simulate_srgb(
            source.astype(np.float64) / 255.0, stock, resolution=max(resolutions)
        ), 0.0, 1.0)
        reference_lab = rgb2lab(reference)
        subset_masks = None
        if fixture["natural"]:
            lab_flat = reference_lab.reshape(-1, 3)
            subset_masks = {
                "shadows_Lstar_lt_20": lab_flat[:, 0] < 20.0,
                "highlights_Lstar_gt_85": lab_flat[:, 0] > 85.0,
                "saturated_Cstarab_gt_50": np.hypot(
                    lab_flat[:, 1], lab_flat[:, 2]
                ) > 50.0,
            }
        for n in resolutions:
            asset = assets[n]
            applied8 = apply_strip_lut(source, asset["png"], cols=LUT_COLS)
            result, delta = _metrics(
                reference, applied8.astype(np.float64) / 255.0,
                reference_lab=reference_lab, subsets=True,
            )
            ideal = apply_cube_lut(source, asset["table"])
            quantized = apply_cube_lut(source, asset["quantized_table"])
            quantization, _ = _metrics(ideal, quantized, subsets=False)
            # Quantization-only compares float trilinear output from the original
            # cube with the same operation on 8-bit-rounded nodes. It excludes
            # physical interpolation error and final render-target rounding.
            result["quantization_only_8bit_nodes"] = quantization
            result.update({
                "image": fixture["id"], "kind": fixture["kind"],
                "label": fixture["label"], "natural": fixture["natural"],
                "width": fixture["width"], "height": fixture["height"],
            })
            by_resolution[n]["images"].append(result)
            if fixture["natural"]:
                natural_deltas[n].append(delta)
                for name, mask in subset_masks.items():
                    natural_subset_deltas[n][name].append(delta[mask])
            if n == min(resolutions):
                print(
                    f"  {fixture['id']:12s} N={n} mean={result['mean_dE2000']:.4f} "
                    f"p95={result['p95_dE2000']:.4f} max={result['max_dE2000']:.4f} "
                    f"quantMean={quantization['mean_dE2000']:.4f}",
                    flush=True,
                )
            del applied8, ideal, quantized, result, quantization
        del source, reference, reference_lab
        gc.collect()

    for n in resolutions:
        values = (np.concatenate(natural_deltas[n]) if natural_deltas[n]
                  else np.empty(0, dtype=np.float32))
        by_resolution[n]["natural"] = {
            **(_stats(values) if values.size else {
                "mean_dE2000": None, "p95_dE2000": None,
                "p99_dE2000": None, "max_dE2000": None,
            }),
            "pixels": int(values.size),
            "mean_pass": bool(values.size and np.mean(values) < NATURAL_MEAN_LIMIT),
            "p95_pass": bool(values.size and np.percentile(values, 95) < NATURAL_P95_LIMIT),
        }
        by_resolution[n]["grid"] = assets[n]["grid"]
        by_resolution[n]["package_bytes"] = assets[n]["package_bytes"]
        by_resolution[n]["preclip_edge"] = assets[n]["bake_record"].get("preclip_edge")
        # Keep exact pooled deltas on disk only until all stocks are combined.
        # This avoids retaining roughly 1 GB of study data in RAM and preserves
        # exact overall percentiles for the selected resolution.
        delta_dir = DELTA_DIR / str(n)
        delta_dir.mkdir(parents=True, exist_ok=True)
        np.save(delta_dir / f"{stock['id']}__natural.npy", values)
        del values
        natural_deltas[n] = []
        for name in SUBSET_NAMES:
            subset_values = (np.concatenate(natural_subset_deltas[n][name])
                             if natural_subset_deltas[n][name]
                             else np.empty(0, dtype=np.float32))
            np.save(delta_dir / f"{stock['id']}__{name}.npy", subset_values)
            del subset_values
            natural_subset_deltas[n][name] = []

    selected_ramp_resolution = min(resolutions)
    ramp_source = _neutral_ramp()
    physical_ramp = simulate_srgb(
        ramp_source.astype(np.float64) / 255.0, stock,
        resolution=selected_ramp_resolution,
    )
    # Ramp is replaced with the final selected resolution in main().
    for n in resolutions:
        lut_ramp = apply_strip_lut(ramp_source, assets[n]["png"], cols=LUT_COLS)
        by_resolution[n]["ramp"] = _ramp_record(physical_ramp, lut_ramp)
    return by_resolution


def _resolution_summary(stock_results: dict[str, dict], resolutions: list[int]) -> dict:
    summary = {}
    baseline = max(resolutions)
    for n in resolutions:
        records = [stock_results[stock_id][n] for stock_id in stock_results]
        means = [record["natural"]["mean_dE2000"] for record in records]
        p95s = [record["natural"]["p95_dE2000"] for record in records]
        baseline_p95 = {
            stock_id: stock_results[stock_id][baseline]["natural"]["p95_dE2000"]
            for stock_id in stock_results
        }
        deltas = {
            stock_id: stock_results[stock_id][n]["natural"]["p95_dE2000"] - baseline_p95[stock_id]
            for stock_id in stock_results
        }
        package_bytes = max(record["package_bytes"] for record in records)
        within_budget = package_bytes < MAX_LUT_DIRECTORY_BYTES
        within_tolerance = all(value <= RESOLUTION_P95_TOLERANCE + 1e-12
                               for value in deltas.values())
        targets = all(record["natural"]["mean_pass"] and record["natural"]["p95_pass"]
                      for record in records)
        summary[str(n)] = {
            "resolution": n,
            "width": records[0]["grid"]["width"], "height": records[0]["grid"]["height"],
            "cols": records[0]["grid"]["cols"], "rows": records[0]["grid"]["rows"],
            "package_bytes": package_bytes,
            "package_kib": package_bytes / 1024.0,
            "mean_of_stock_natural_mean_dE2000": float(np.mean(means)),
            "worst_stock_natural_mean_dE2000": float(np.max(means)),
            "worst_stock_natural_p95_dE2000": float(np.max(p95s)),
            "worst_stock_natural_max_dE2000": float(max(
                record["natural"]["max_dE2000"] for record in records
            )),
            "max_stock_p95_increase_vs_65": float(max(deltas.values())),
            "per_stock_p95_increase_vs_65": deltas,
            "within_package_budget": within_budget,
            "within_p95_tolerance_of_65": within_tolerance,
            "natural_targets_pass": targets,
            "eligible": bool(within_budget and within_tolerance and targets),
        }
    return summary


def _overall_natural_metrics(selected: int, stocks: list[dict],
                             reuse_overall: bool = False) -> dict:
    """Exact pooled statistics from per-stock on-disk delta arrays.

    ``reuse_overall`` is an explicit recovery path for report-only fixes after
    a completed study. It accepts the existing summary only when both N and the
    complete physical recipe snapshot match, preventing cross-recipe reuse.
    """
    pooled_anchor = DELTA_DIR / str(selected) / f"{stocks[0]['id']}__natural.npy"
    if reuse_overall and not pooled_anchor.is_file() and VALIDATION_JSON.is_file():
        existing = json.loads(VALIDATION_JSON.read_text(encoding="utf-8"))
        current_settings = json.loads(json.dumps(recipe_snapshot(resolution=selected)))
        if (existing["selection"]["selected_resolution"] == selected
                and existing["settings"] == current_settings):
            return existing["summary"]["natural_overall"]
        raise RuntimeError("Existing overall metrics do not match selected N and physical recipe")
    natural_pixels = 0
    for stock in stocks:
        path = DELTA_DIR / str(selected) / f"{stock['id']}__natural.npy"
        if not path.is_file():
            raise FileNotFoundError(
                f"Missing pooled delta data {path}; rerun validation without --resume"
            )
        natural_pixels += int(np.load(path, mmap_mode="r").shape[0])

    def collect(group: str) -> dict:
        arrays = [
            np.load(DELTA_DIR / str(selected) / f"{stock['id']}__{group}.npy", mmap_mode="r")
            for stock in stocks
        ]
        nonempty = [array for array in arrays if array.size]
        values = (np.concatenate(nonempty) if nonempty
                  else np.empty(0, dtype=np.float32))
        result = {
            **(_stats(values) if values.size else {
                "mean_dE2000": None, "p95_dE2000": None,
                "p99_dE2000": None, "max_dE2000": None,
            }),
            "pixels": int(values.size),
            "coverage_percent": float(values.size / natural_pixels * 100.0),
        }
        del values, nonempty, arrays
        gc.collect()
        return result

    overall = {"natural": collect("natural")}
    overall["subsets"] = {name: collect(name) for name in SUBSET_NAMES}
    return overall


def _quantization_summary(records: list[dict]) -> dict:
    images = [image for stock in records for image in stock["images"]]
    pixels = sum(image["quantization_only_8bit_nodes"]["pixels"] for image in images)
    return {
        "images": len(images),
        "pixels": int(pixels),
        "pixel_weighted_mean_dE2000": float(sum(
            image["quantization_only_8bit_nodes"]["mean_dE2000"]
            * image["quantization_only_8bit_nodes"]["pixels"] for image in images
        ) / pixels),
        "worst_image_p95_dE2000": float(max(
            image["quantization_only_8bit_nodes"]["p95_dE2000"] for image in images
        )),
        "global_max_dE2000": float(max(
            image["quantization_only_8bit_nodes"]["max_dE2000"] for image in images
        )),
        "pixel_weighted_mean_abs_8bit": float(sum(
            image["quantization_only_8bit_nodes"]["mean_abs_8bit"]
            * image["quantization_only_8bit_nodes"]["pixels"] for image in images
        ) / pixels),
    }


def _markdown(payload: dict) -> str:
    selected = payload["selection"]["selected_resolution"]
    summary = payload["summary"]
    lines = [
        "# LUT validation — Phase 1c",
        "",
        "Film modeling powered by [spektrafilm](https://github.com/andreavolpato/spektrafilm).",
        "",
        "References are public full `simulate()` runs with exactly the bake's film/print, sRGB",
        "CCTF boundary, input gain, fixed camera EV, normalized/compensated print exposure,",
        "database neutral filters, scanner white/black normalization, positive-film route, and",
        "CAM16-UCS output handling. Grain, halation/scatter, diffusion, blur, glare, DIR spatial",
        "diffusion, unsharp masking, auto exposure, and other spatial/stochastic effects are off.",
        "**There is no project-owned tone curve or post-simulation levels transform.**",
        "",
        "Natural images are the six phone photos plus the ProPhoto-derived portrait. The IT8",
        "chart and synthetic target are reported separately. Subsets use reference CIE Lab:",
        "shadows L*<20, highlights L*>85, saturated colours C*ab>50. Quantization-only error",
        "compares float trilinear output from original versus 8-bit-rounded cube nodes; it does",
        "not include interpolation error or final 8-bit render-target rounding.",
        "",
        "## Acceptance summary",
        "",
        f"- Selected **N={selected}**, tiled grid **{payload['resolution_study'][str(selected)]['width']}×",
        f"{payload['resolution_study'][str(selected)]['height']}**, 8 columns; package "
        f"**{payload['resolution_study'][str(selected)]['package_kib']:.1f} KiB**.",
        f"- Stocks: **{summary['stocks_validated']}**; images per stock: **{summary['images_per_stock']}**.",
        f"- Natural-image limits: each stock's pooled mean <{NATURAL_MEAN_LIMIT:.1f} and p95 "
        f"<{NATURAL_P95_LIMIT:.1f} dE2000: **{'PASS' if summary['natural_targets_met'] else 'FAIL'}**.",
        f"- Near-white non-decreasing response with no material LUT flat top: "
        f"**{'PASS' if summary['highlight_monotonicity_met'] else 'FAIL'}**.",
        f"- Strict-rise exceptions caused solely by sub-one-code 8-bit rounding: "
        f"**{', '.join(summary['highlight_quantization_plateaus']) or 'none'}**.",
        f"- Package <1.5 MiB: **{'PASS' if summary['package_target_met'] else 'FAIL'}**.",
        "",
        "### Overall natural-image and subset fidelity (selected N)",
        "",
        "These are exact pixel-pooled results across all 11 stocks and seven natural images,",
        "not averages of per-image percentiles. Subsets are defined independently in each full",
        "physical reference, so their pixels can overlap.",
        "",
        "| Population | Pixels (coverage) | Mean dE2000 | p95 | p99 | MAX |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    overall = summary["natural_overall"]
    for name, result in (("All natural pixels", overall["natural"]), *overall["subsets"].items()):
        lines.append(
            f"| {name} | {result['pixels']} ({result['coverage_percent']:.2f}%) | "
            f"{result['mean_dE2000']:.4f} | {result['p95_dE2000']:.4f} | "
            f"{result['p99_dE2000']:.4f} | {result['max_dE2000']:.4f} |"
        )
    quant = summary["quantization_only_8bit_nodes"]
    lines.extend([
        "",
        f"8-bit node quantization only (99 stock×image pairs): pixel-weighted mean "
        f"**{quant['pixel_weighted_mean_dE2000']:.4f}**, worst image p95 "
        f"**{quant['worst_image_p95_dE2000']:.4f}**, global MAX "
        f"**{quant['global_max_dE2000']:.4f} dE2000**; mean absolute code error "
        f"**{quant['pixel_weighted_mean_abs_8bit']:.4f}**.",
        "",
        "### Resolution / size / error trade-off",
        "",
        "Eligibility requires package <1.5 MiB, natural targets passing, and every stock's",
        "natural p95 within 0.1 dE2000 of the same stock at N=65. The smallest eligible N wins.",
        "",
        "| N | Grid | Package KiB | Mean of stock natural means | Worst stock mean | Worst stock p95 | Max p95 increase vs 65 | Eligible |",
        "|---:|---|---:|---:|---:|---:|---:|:---:|",
    ])
    for n_text, study in payload["resolution_study"].items():
        lines.append(
            f"| {n_text} | {study['width']}×{study['height']} | {study['package_kib']:.1f} | "
            f"{study['mean_of_stock_natural_mean_dE2000']:.4f} | "
            f"{study['worst_stock_natural_mean_dE2000']:.4f} | "
            f"{study['worst_stock_natural_p95_dE2000']:.4f} | "
            f"{study['max_stock_p95_increase_vs_65']:+.4f} | "
            f"{'yes' if study['eligible'] else 'no'} |"
        )
    lines.extend([
        "",
        "### Per-stock pooled natural-image results (selected N)",
        "",
        "| Stock | Mean dE2000 | p95 | p99 | MAX | Mean target | p95 target |",
        "|---|---:|---:|---:|---:|:---:|:---:|",
    ])
    for stock in payload["stocks"]:
        natural = stock["natural"]
        lines.append(
            f"| {stock['name']} | {natural['mean_dE2000']:.4f} | "
            f"{natural['p95_dE2000']:.4f} | {natural['p99_dE2000']:.4f} | "
            f"{natural['max_dE2000']:.4f} | {'PASS' if natural['mean_pass'] else 'FAIL'} | "
            f"{'PASS' if natural['p95_pass'] else 'FAIL'} |"
        )
    lines.extend([
        "",
        "## Per-stock, per-image metrics (selected N)",
        "",
        "| Stock | Image | Kind | Mean | p95 | p99 | MAX dE2000 | MAE 8-bit | Quant-only mean/p95/MAX |",
        "|---|---|---|---:|---:|---:|---:|---:|---:|",
    ])
    for stock in payload["stocks"]:
        for image in stock["images"]:
            quant = image["quantization_only_8bit_nodes"]
            lines.append(
                f"| {stock['name']} | {image['image']} | {image['kind']} | "
                f"{image['mean_dE2000']:.4f} | {image['p95_dE2000']:.4f} | "
                f"{image['p99_dE2000']:.4f} | {image['max_dE2000']:.4f} | "
                f"{image['mean_abs_8bit']:.4f} | {quant['mean_dE2000']:.4f}/"
                f"{quant['p95_dE2000']:.4f}/{quant['max_dE2000']:.4f} |"
            )
    lines.extend([
        "",
        "## Reference-defined subsets (selected N)",
        "",
        "| Stock | Image | Subset | Pixels (coverage) | Mean | p95 | p99 | MAX dE2000 |",
        "|---|---|---|---:|---:|---:|---:|---:|",
    ])
    for stock in payload["stocks"]:
        for image in stock["images"]:
            for subset_name, subset in image["subsets"].items():
                if subset["pixels"] == 0:
                    values = "— | — | — | —"
                else:
                    values = (f"{subset['mean_dE2000']:.4f} | {subset['p95_dE2000']:.4f} | "
                              f"{subset['p99_dE2000']:.4f} | {subset['max_dE2000']:.4f}")
                lines.append(
                    f"| {stock['name']} | {image['image']} | {subset_name} | "
                    f"{subset['pixels']} ({subset['coverage_percent']:.2f}%) | {values} |"
                )
    lines.extend([
        "",
        "## Neutral ramps (full physical / tiled LUT mean sRGB codes)",
        "",
        "Each cell is `physical → LUT`. The spread column is for the LUT. Strict near-white",
        "monotonicity compares inputs 230 < 250 < 255. A physical flat/non-monotonic response is",
        "distinguished from an interpolation defect. `8-bit plateau` marks a non-decreasing LUT",
        "plateau only where the full physical rise is below one output code and therefore cannot",
        "remain strictly increasing after correct 8-bit rounding; it is reported, not retuned.",
        "",
        "| Stock | 0 | 20 | 45 | 60 | 80 | 118 | 170 | 200 | 230 | 250 | 255 | Max spread | LUT monotonic |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|",
    ])
    for stock in payload["stocks"]:
        ramp = stock["ramp"]
        cells = " | ".join(
            f"{physical:.1f}→{lut:.1f}" for physical, lut in zip(
                ramp["physical_output_mean8"], ramp["lut_output_mean8"]
            )
        )
        if ramp["lut_near_white_strictly_monotonic"]:
            ramp_status = "strict"
        elif ramp["quantization_limited_plateau"]:
            ramp_status = "8-bit plateau"
        elif ramp["lut_did_not_introduce_flat_top"]:
            ramp_status = "physical plateau"
        else:
            ramp_status = "FAIL"
        lines.append(
            f"| {stock['name']} | {cells} | {ramp['max_lut_channel_spread8']:.1f} | "
            f"{ramp_status} |"
        )
    lines.extend([
        "",
        "## Cube edge handling (selected N)",
        "",
        "Percentages are measured over all physical cube outputs before the LUT creator's",
        "required [0,1] clamp. CAM16-UCS chroma/lightness compression is active inside the full",
        "pipeline; any remaining floating-point excursions are clipped identically at the cube",
        "and display-reference boundary. Linear-light excursions are also recorded in JSON.",
        "",
        "| Stock | Nodes any encoded channel outside | Encoded samples outside | Encoded min/max |",
        "|---|---:|---:|---:|",
    ])
    for stock in payload["stocks"]:
        edge = stock["preclip_edge"]
        lines.append(
            f"| {stock['name']} | {edge['encoded_nodes_with_any_channel_outside_percent']:.6f}% | "
            f"{edge['encoded_channel_samples_outside_percent']:.6f}% | "
            f"{edge['encoded_min']:.6f}/{edge['encoded_max']:.6f} |"
        )
    lines.extend([
        "",
        "## Effective per-stock physical parameters",
        "",
        "| Stock | Route | Camera EV | Print exposure / compensation | Scanner W/B | Neutral C/M/Y |",
        "|---|---|---:|---|:---:|---:|",
    ])
    for stock in payload["stocks"]:
        params = stock["effective_parameters"]
        route = "direct positive scan" if params["scan_film"] else params["print"]
        lines.append(
            f"| {stock['name']} | {route} | {params['camera_exposure_compensation_ev']:+.6f} | "
            f"{params['enlarger_print_exposure']:.3f} / "
            f"{'on' if params['print_exposure_compensation'] else 'off'} | "
            f"{'on' if params['scanner_white_correction'] else 'off'}/"
            f"{'on' if params['scanner_black_correction'] else 'off'} | "
            + "/".join(f"{v:g}" for v in params["neutral_cmy_filters"]) + " |"
        )
    return "\n".join(lines) + "\n"


def _stock_result_path(stock_id: str, resolutions: list[int]) -> Path:
    suffix = "-".join(str(n) for n in resolutions)
    return STOCK_RESULT_DIR / f"{stock_id}-N{suffix}.json"


def _save_stock_result(stock_id: str, by_resolution: dict,
                       resolutions: list[int]) -> None:
    STOCK_RESULT_DIR.mkdir(parents=True, exist_ok=True)
    path = _stock_result_path(stock_id, resolutions)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({
        "id": stock_id,
        "resolutions": resolutions,
        "results": by_resolution,
    }, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)
    progress = {
        "completed_stocks": sorted(
            path.stem.rsplit("-N", 1)[0]
            for path in STOCK_RESULT_DIR.glob(f"*-N{'-'.join(map(str, resolutions))}.json")
        ),
        "resolutions": resolutions,
    }
    (BUILD_DIR / "validation-progress.json").write_text(
        json.dumps(progress, indent=2) + "\n", encoding="utf-8"
    )


def _load_stock_result(stock_id: str, resolutions: list[int]) -> dict:
    path = _stock_result_path(stock_id, resolutions)
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload["resolutions"] != resolutions:
        raise RuntimeError(f"{path}: resolution list does not match requested study")
    results = {int(n): record for n, record in payload["results"].items()}
    # Upgrade checkpointed ramps without resimulation when the report logic
    # gains more explicit physical/quantization diagnostics.
    for record in results.values():
        ramp = record["ramp"]
        record["ramp"] = _ramp_record(
            np.asarray(ramp["physical_output_rgb8"], dtype=np.float64) / 255.0,
            np.asarray(ramp["lut_output_rgb8"], dtype=np.uint8),
        )
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resolutions", type=int, nargs="+", default=list(LUT_RESOLUTIONS))
    parser.add_argument("--stock", action="append", dest="stock_ids")
    parser.add_argument("--resume", action="store_true",
                        help="Reuse completed per-stock JSON results in build/validation-stocks")
    parser.add_argument("--combine-only", action="store_true",
                        help="Only combine saved per-stock results; run no simulations")
    parser.add_argument("--reuse-overall", action="store_true",
                        help="With --combine-only, reuse overall pools only if N and full recipe match")
    args = parser.parse_args()
    resolutions = sorted(set(args.resolutions))
    if not resolutions or any(n < 2 for n in resolutions):
        parser.error("resolutions must be integers >=2")
    if len(resolutions) > 1 and 65 not in resolutions:
        parser.error("a resolution study must include 65 as the comparison baseline")
    if args.combine_only and args.stock_ids:
        parser.error("--combine-only cannot be combined with --stock")
    if not args.resume and not args.combine_only and DELTA_DIR.exists():
        shutil.rmtree(DELTA_DIR)

    all_stocks = load_stocks()
    stocks = all_stocks
    if args.stock_ids:
        selected = set(args.stock_ids)
        stocks = [stock for stock in stocks if stock["id"] in selected]
    fixtures = prepare_fixtures()
    stock_results = {}
    for stock in stocks:
        result_path = _stock_result_path(stock["id"], resolutions)
        if args.resume and result_path.is_file():
            print(f"[resume] {stock['id']} <- {result_path}", flush=True)
            stock_results[stock["id"]] = _load_stock_result(stock["id"], resolutions)
            continue
        if args.combine_only:
            stock_results[stock["id"]] = _load_stock_result(stock["id"], resolutions)
            continue
        started = perf_counter()
        print(f"[validate] {stock['id']} at N={resolutions}", flush=True)
        stock_results[stock["id"]] = validate_stock(stock, fixtures, resolutions)
        _save_stock_result(stock["id"], stock_results[stock["id"]], resolutions)
        print(f"[timing] {stock['id']}: {perf_counter() - started:.1f}s; saved {result_path}", flush=True)
        gc.collect()

    if len(stocks) != len(all_stocks):
        print(f"[partial] saved {len(stocks)} stock result(s); run --combine-only after all stocks", flush=True)
        return
    # A full invocation may have reused results; all_stocks defines stable order.
    stock_results = {stock["id"]: stock_results[stock["id"]] for stock in all_stocks}
    stocks = all_stocks

    study = _resolution_summary(stock_results, resolutions)
    eligible = [n for n in resolutions if study[str(n)]["eligible"]]
    if not eligible:
        raise RuntimeError("No resolution meets package, p95-vs-65, and natural-target criteria")
    selected = min(eligible)
    selected_records = []
    for stock in stocks:
        record = stock_results[stock["id"]][selected]
        record["film"] = stock["film"]
        record["print"] = stock["print"]
        record["effective_parameters"] = effective_stock_parameters(stock)
        selected_records.append(record)
    choice = {
        "selected_resolution": selected,
        "rule": "smallest N with package <1.5 MiB, all natural targets passing, and every stock natural p95 <= same-stock N=65 p95 + 0.1",
        "eligible_resolutions": eligible,
    }
    CHOICE_JSON.write_text(json.dumps(choice, indent=2) + "\n", encoding="utf-8")
    STUDY_JSON.write_text(json.dumps({
        "selection": choice, "summary": study,
        "stocks": {stock_id: {str(n): record for n, record in by_n.items()}
                   for stock_id, by_n in stock_results.items()},
    }, indent=2, allow_nan=False) + "\n", encoding="utf-8")

    overall = _overall_natural_metrics(selected, stocks, reuse_overall=args.reuse_overall)
    summary = {
        "stocks_validated": len(selected_records),
        "images_per_stock": len(fixtures),
        "natural_overall": overall,
        "quantization_only_8bit_nodes": _quantization_summary(selected_records),
        "natural_targets_met": all(
            record["natural"]["mean_pass"] and record["natural"]["p95_pass"]
            for record in selected_records
        ),
        "highlight_monotonicity_met": all(
            record["ramp"]["lut_did_not_introduce_flat_top"] for record in selected_records
        ),
        "highlight_quantization_plateaus": [
            record["id"] for record in selected_records
            if record["ramp"]["quantization_limited_plateau"]
        ],
        "package_target_met": study[str(selected)]["within_package_budget"],
        "natural_mean_limit": NATURAL_MEAN_LIMIT,
        "natural_p95_limit": NATURAL_P95_LIMIT,
    }
    payload = {
        "settings": recipe_snapshot(resolution=selected),
        "selection": choice,
        "summary": summary,
        "resolution_study": study,
        "fixtures": [{k: v for k, v in fixture.items() if k != "path"} for fixture in fixtures],
        "stocks": selected_records,
    }
    VALIDATION_JSON.write_text(json.dumps(payload, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    VALIDATION_MD.write_text(_markdown(payload), encoding="utf-8")
    shutil.rmtree(DELTA_DIR, ignore_errors=True)
    print(
        f"[done] selected N={selected}; natural targets={summary['natural_targets_met']}; "
        f"highlights={summary['highlight_monotonicity_met']}; wrote {VALIDATION_MD}",
        flush=True,
    )
    if not summary["natural_targets_met"]:
        failures = [record["id"] for record in selected_records
                    if not (record["natural"]["mean_pass"] and record["natural"]["p95_pass"])]
        raise RuntimeError(f"Natural-image dE2000 acceptance failed: {failures}")
    if not summary["highlight_monotonicity_met"]:
        raise RuntimeError("LUT interpolation introduced a near-white flat top")
    if not summary["package_target_met"]:
        raise RuntimeError("Selected LUT package exceeds 1.5 MiB")


if __name__ == "__main__":
    main()
