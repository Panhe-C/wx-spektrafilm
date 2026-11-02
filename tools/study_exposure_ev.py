#!/usr/bin/env python3
"""Phase 4a EV candidate study against full fixed-print simulate() references."""
from __future__ import annotations

import argparse
import gc
import json
import math
from pathlib import Path
from time import perf_counter

import numpy as np
from skimage.color import deltaE_ciede2000, rgb2lab

from adjust import apply_lut_camera_gain, encoded_srgb
from image_fixtures import load_fixture, prepare_phone_fixtures
from lut_apply import apply_strip_lut_srgb_float
from pipeline_config import ROOT, load_stocks, simulate_srgb

OUT = ROOT / "build" / "p4a"
RESULT_DIR = OUT / "ev-results"
DELTA_DIR = OUT / "ev-deltas"
RAW_JSON = OUT / "ev-study.json"
DOC = ROOT / "docs" / "EXPOSURE_EV.md"
STOCK_IDS = ("portra400", "ektar100", "velvia100", "vision3_500t")
PHOTO_IDS = ("p1015", "p1062", "p237")
EV_VALUES = (-2.0, -1.0, -0.5, 0.0, 0.5, 1.0, 2.0)
C_NODES = (-2, -1, 0, 1, 2)
CANDIDATES = ("A", "B33", "B49", "C17", "C25", "D33", "D49")
BEGIN = "<!-- EV_STUDY_RESULTS:BEGIN -->"
END = "<!-- EV_STUDY_RESULTS:END -->"


def ev_key(ev: float) -> str:
    return f"{ev:+.1f}"


def stats(delta: np.ndarray) -> dict:
    return {
        "mean": float(np.mean(delta, dtype=np.float64)),
        "p95": float(np.percentile(delta, 95)),
        "p99": float(np.percentile(delta, 99)),
        "max": float(np.max(delta)),
        "pixels": int(delta.size),
    }


def metrics(reference: np.ndarray, actual: np.ndarray, reference_lab: np.ndarray,
            delta_path: Path) -> dict:
    ref = np.clip(reference, 0.0, 1.0).astype(np.float32)
    app = np.clip(actual, 0.0, 1.0).astype(np.float32)
    delta = deltaE_ciede2000(reference_lab, rgb2lab(app)).astype(np.float32)
    delta_path.parent.mkdir(parents=True, exist_ok=True)
    np.save(delta_path, delta)
    return {
        **stats(delta),
        "meanAbs8bit": float(np.mean(np.abs(ref - app), dtype=np.float64) * 255.0),
        "delta": str(delta_path.relative_to(ROOT)),
    }


def grid_path(group: str, stock_id: str) -> Path:
    return OUT / "grids" / group / f"{stock_id}.png"


def base_path(stock_id: str) -> Path:
    return ROOT / "subpackages" / "luts" / f"{stock_id}.png"


def candidate_image(candidate: str, source: np.ndarray, stock_id: str, ev: float) -> np.ndarray:
    if candidate == "A" or (candidate.startswith("D") and ev <= 0.0):
        return apply_lut_camera_gain(source, base_path(stock_id), (2.0 ** ev,) * 3)
    if candidate.startswith("B") or candidate.startswith("D"):
        n = candidate[1:]
        return apply_lut_camera_gain(source, grid_path(f"b{n}", stock_id),
                                     (2.0 ** (ev - 2.0),) * 3)
    if candidate.startswith("C"):
        n = candidate[1:]
        lower = max(C_NODES[0], min(C_NODES[-2], math.floor(ev)))
        upper = min(C_NODES[-1], lower + 1)
        fraction = float(np.clip(ev - lower, 0.0, 1.0))
        low_path = base_path(stock_id) if lower == 0 else grid_path(f"c{n}_ev{lower}", stock_id)
        low = apply_strip_lut_srgb_float(encoded_srgb(source), low_path)
        if fraction == 0.0:
            return low
        high_path = base_path(stock_id) if upper == 0 else grid_path(f"c{n}_ev{upper}", stock_id)
        high = apply_strip_lut_srgb_float(encoded_srgb(source), high_path)
        return low + (high - low) * np.float32(fraction)
    raise KeyError(candidate)


def neutral_diagnostic(stocks: list[dict]) -> list[dict]:
    codes = np.array([0, 60, 118, 170, 230, 255], dtype=np.float32) / 255.0
    ramp = codes.reshape(1, -1, 1).repeat(3, axis=2)
    records = []
    for stock in stocks:
        record = {"id": stock["id"], "name": stock["name"], "values": {}}
        for ev in EV_VALUES:
            if ev == 0.0:
                continue
            value = {}
            for mode, compensated in (("fixed", False), ("auto", True)):
                output = simulate_srgb(ramp, stock, overrides={
                    "camera_exposure_compensation_ev": ev,
                    "enlarger_print_exposure_compensation": compensated,
                })
                rgb = np.clip(output[0, 2], 0.0, 1.0) * 255.0
                value[mode] = float(np.mean(rgb))
            record["values"][ev_key(ev)] = value
        records.append(record)
        print(f"[auto-print diagnostic] {stock['id']}", flush=True)
    return records


def load_checkpoints() -> list[dict]:
    records = []
    for stock_id in STOCK_IDS:
        path = RESULT_DIR / f"{stock_id}.json"
        if path.is_file():
            payload = json.loads(path.read_text(encoding="utf-8"))
            if payload.get("version") != 1:
                raise RuntimeError(f"Stale study checkpoint: {path}")
            records.append(payload)
    return records


def package_projection() -> dict:
    manifest = json.loads((ROOT / "subpackages" / "luts" / "luts.json").read_text(encoding="utf-8"))
    base = {item["id"]: item["bytes"] for item in manifest}
    rep_base = sum(base[stock_id] for stock_id in STOCK_IDS)

    def group_png(group: str) -> int:
        return sum(json.loads((OUT / "grids" / group / "luts.json").read_text(encoding="utf-8"))
                   [index]["bytes"] for index in range(len(STOCK_IDS)))

    def project(groups: list[str], include_base: bool) -> int:
        groups_bytes = [group_png(group) for group in groups]
        scale = sum(groups_bytes) / (len(groups) * rep_base)
        extra = round(sum(base.values()) * scale)
        return (sum(base.values()) if include_base else 0) + extra + 3500 * (
            len(groups) + (1 if include_base else 0)
        )

    return {
        "baselineActual": sum(path.stat().st_size for path in (ROOT / "subpackages" / "luts").iterdir()
                              if path.is_file()),
        "A": sum(base.values()) + 3500,
        "B33": project(["b33"], False),
        "B49": project(["b49"], False),
        "C17": project([f"c17_ev{ev}" for ev in C_NODES if ev], True),
        "C25": project([f"c25_ev{ev}" for ev in C_NODES if ev], True),
        "D33": project(["b33"], True),
        "D49": project(["b49"], True),
        "method": "Representative PNG-size ratio projected over the actual 11-stock baseline; includes 3500 bytes per manifest estimate.",
    }


def pooled(records: list[dict]) -> dict:
    result = {candidate: {} for candidate in CANDIDATES}
    for candidate in CANDIDATES:
        for ev in EV_VALUES:
            paths = [ROOT / image["candidates"][candidate][ev_key(ev)]["delta"]
                     for stock in records for image in stock["images"]]
            delta = np.concatenate([np.load(path, mmap_mode="r") for path in paths])
            result[candidate][ev_key(ev)] = stats(delta)
            del delta
    return result


def update_reports(records: list[dict], complete: bool) -> dict:
    pool = pooled(records)
    sizes = package_projection()
    auto_path = OUT / "auto-print-neutral.json"
    auto = json.loads(auto_path.read_text(encoding="utf-8")) if auto_path.is_file() else []
    payload = {
        "version": 1,
        "complete": complete,
        "stocks": [record["id"] for record in records],
        "photos": list(PHOTO_IDS),
        "maxPixelsPerPhoto": 240000,
        "evValues": list(EV_VALUES),
        "reference": "full simulate_srgb; only camera EV changed; print_exposure_compensation=False",
        "candidates": pool,
        "projectedPackageBytes": sizes,
        "autoPrintNeutral118": auto,
    }
    temporary = RAW_JSON.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(RAW_JSON)

    lines = [
        f"**{'Complete representative study' if complete else 'Partial checkpoint'}:** "
        f"{len(records)}/{len(STOCK_IDS)} stocks × {len(PHOTO_IDS)} photos; each photo ≤240,000 pixels. "
        "Every entry pools all pixels equally. dE2000 is versus full fixed-print `simulate()`.",
        "",
        "| Candidate | EV | Mean | p95 | p99 | MAX dE2000 |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for candidate in CANDIDATES:
        for ev in EV_VALUES:
            value = pool[candidate][ev_key(ev)]
            lines.append(f"| {candidate} | {ev:+.1f} | {value['mean']:.4f} | {value['p95']:.4f} | "
                         f"{value['p99']:.4f} | {value['max']:.4f} |")
    lines.extend([
        "",
        "Projected complete-subpackage sizes use measured representative PNG compression ratios; "
        "the selected candidate must later be baked/converted for all 11 stocks and measured directly.",
        "",
        "| Candidate | Projected bytes | Approx. KiB |",
        "|---|---:|---:|",
    ])
    for candidate in CANDIDATES:
        lines.append(f"| {candidate} | {sizes[candidate]:,} | {sizes[candidate] / 1024:.1f} |")
    if auto:
        lines.extend([
            "",
            "### Neutral code-118 response: fixed print / auto-print",
            "",
            "These are full physical simulations, not candidate errors. Auto-print nearly cancels "
            "camera EV for negatives; direct positive scans have no print compensation.",
            "",
            "| Stock | −2 | −1 | −0.5 | +0.5 | +1 | +2 |",
            "|---|---:|---:|---:|---:|---:|---:|",
        ])
        for stock in auto:
            cells = []
            for ev in EV_VALUES:
                if ev == 0.0:
                    continue
                value = stock["values"][ev_key(ev)]
                cells.append(f"{value['fixed']:.1f}/{value['auto']:.1f}")
            lines.append(f"| {stock['id']} | " + " | ".join(cells) + " |")
    document = DOC.read_text(encoding="utf-8")
    if BEGIN not in document or END not in document:
        raise RuntimeError("EV study result markers missing")
    document = document.split(BEGIN, 1)[0] + BEGIN + "\n" + "\n".join(lines) + "\n" + END + document.split(END, 1)[1]
    DOC.write_text(document, encoding="utf-8")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    RESULT_DIR.mkdir(parents=True, exist_ok=True)
    all_stocks = load_stocks()
    stock_by_id = {stock["id"]: stock for stock in all_stocks}
    if not args.resume or not (OUT / "auto-print-neutral.json").is_file():
        auto = neutral_diagnostic(all_stocks)
        (OUT / "auto-print-neutral.json").write_text(
            json.dumps(auto, indent=2, allow_nan=False) + "\n", encoding="utf-8"
        )

    fixtures = [fixture for fixture in prepare_phone_fixtures(max_pixels=240000)
                if fixture["id"].removeprefix("phone_") in PHOTO_IDS]
    records = load_checkpoints() if args.resume else []
    completed = {record["id"] for record in records}
    for stock_id in STOCK_IDS:
        if stock_id in completed:
            continue
        stock = stock_by_id[stock_id]
        started = perf_counter()
        stock_record = {"version": 1, "id": stock_id, "images": []}
        print(f"[study] {stock_id}", flush=True)
        for fixture in fixtures:
            source = load_fixture(fixture)
            image_record = {"photo": fixture["id"], "width": source.shape[1],
                            "height": source.shape[0], "candidates": {candidate: {} for candidate in CANDIDATES}}
            for ev in EV_VALUES:
                reference = np.clip(simulate_srgb(
                    encoded_srgb(source), stock,
                    overrides={"camera_exposure_compensation_ev": ev,
                               "enlarger_print_exposure_compensation": False},
                ), 0.0, 1.0).astype(np.float32)
                reference_lab = rgb2lab(reference)
                if ev == 0.0:
                    auto_zero = np.clip(simulate_srgb(encoded_srgb(source), stock), 0.0, 1.0)
                    image_record["ev0PrintCompensationMaxAbs8bit"] = float(np.max(np.abs(
                        reference - auto_zero
                    )) * 255.0)
                    del auto_zero
                for candidate in CANDIDATES:
                    output = candidate_image(candidate, source, stock_id, ev)
                    delta_path = DELTA_DIR / stock_id / fixture["id"] / f"{candidate}_{ev_key(ev)}.npy"
                    image_record["candidates"][candidate][ev_key(ev)] = metrics(
                        reference, output, reference_lab, delta_path,
                    )
                    del output
                print(f"  {fixture['id']} EV={ev:+.1f}", flush=True)
                del reference, reference_lab
                gc.collect()
            stock_record["images"].append(image_record)
            del source
            gc.collect()
        stock_record["seconds"] = round(perf_counter() - started, 3)
        path = RESULT_DIR / f"{stock_id}.json"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(stock_record, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        temporary.replace(path)
        records.append(stock_record)
        records.sort(key=lambda record: STOCK_IDS.index(record["id"]))
        update_reports(records, complete=False)
        print(f"[checkpoint] {stock_id}; {stock_record['seconds']:.1f}s", flush=True)
    update_reports(records, complete=True)
    print(f"[done] wrote {RAW_JSON} and updated {DOC}", flush=True)


if __name__ == "__main__":
    main()
