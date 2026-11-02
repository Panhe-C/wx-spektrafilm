#!/usr/bin/env python3
"""Measure camera-side WB LUT paths against unclipped full simulate() input gains."""
from __future__ import annotations

import argparse
import gc
import json
from pathlib import Path
from time import perf_counter

import numpy as np
from skimage.color import rgb2lab

from adjust import apply_lut_camera_gain, encoded_srgb
from image_fixtures import load_fixture, prepare_phone_fixtures
from pipeline_config import ROOT, decode_srgb_input, load_stocks, simulate_linear_srgb
from study_exposure_ev import (
    PHOTO_IDS, STOCK_IDS, base_path, grid_path, metrics, stats,
)
from wb import white_balance

OUT = ROOT / "build" / "p4a"
RESULT_DIR = OUT / "wb-results"
DELTA_DIR = OUT / "wb-deltas"
RAW_JSON = OUT / "wb-study.json"
DOC = ROOT / "docs" / "EXPOSURE_EV.md"
BEGIN = "<!-- WB_STUDY_RESULTS:BEGIN -->"
END = "<!-- WB_STUDY_RESULTS:END -->"
CANDIDATES = ("A", "B33", "B49")
SETTINGS = (
    ("temp-50", "Temperature −50 (cool)", -50, 0),
    ("temp+50", "Temperature +50 (warm)", 50, 0),
    ("tint-50", "Tint −50 (green)", 0, -50),
    ("tint+50", "Tint +50 (magenta)", 0, 50),
    ("combo-cool-magenta", "Temperature −50, tint +50", -50, 50),
    ("combo-warm-green", "Temperature +50, tint −50", 50, -50),
)


def load_checkpoints() -> list[dict]:
    records = []
    for stock_id in STOCK_IDS:
        path = RESULT_DIR / f"{stock_id}.json"
        if path.is_file():
            payload = json.loads(path.read_text(encoding="utf-8"))
            if payload.get("version") != 1:
                raise RuntimeError(f"Stale WB checkpoint: {path}")
            records.append(payload)
    return records


def pooled(records: list[dict]) -> dict:
    output = {candidate: {} for candidate in CANDIDATES}
    for candidate in CANDIDATES:
        for setting_id, label, temperature, tint in SETTINGS:
            paths = [ROOT / image["candidates"][candidate][setting_id]["delta"]
                     for stock in records for image in stock["images"]]
            values = np.concatenate([np.load(path, mmap_mode="r") for path in paths])
            output[candidate][setting_id] = stats(values)
            del values
    return output


def update_reports(records: list[dict], complete: bool) -> None:
    pool = pooled(records)
    payload = {
        "version": 1, "complete": complete,
        "stocks": [record["id"] for record in records], "photos": list(PHOTO_IDS),
        "maxPixelsPerPhoto": 240000,
        "reference": "decode sRGB; apply unclipped JS-mirrored linear WB gains; full simulate_linear_srgb at camera EV 0 and fixed print exposure",
        "settings": [{"id": sid, "label": label, "temperature": temp, "tint": tint,
                      "gain": white_balance(temp, tint)["gain"].tolist(),
                      "cct": white_balance(temp, tint)["cct"]}
                     for sid, label, temp, tint in SETTINGS],
        "candidates": pool,
    }
    temporary = RAW_JSON.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(RAW_JSON)
    lines = [
        f"**{'Complete representative WB study' if complete else 'Partial WB checkpoint'}:** "
        f"{len(records)}/{len(STOCK_IDS)} stocks × {len(PHOTO_IDS)} photos, each ≤240,000 pixels. "
        "B is the extended-only path; selected D uses B49 for each nonidentity WB setting.",
        "",
        "| Candidate | Setting | Mean | p95 | p99 | MAX dE2000 |",
        "|---|---|---:|---:|---:|---:|",
    ]
    for candidate in CANDIDATES:
        for setting_id, label, temperature, tint in SETTINGS:
            value = pool[candidate][setting_id]
            lines.append(f"| {candidate} | {label} | {value['mean']:.4f} | {value['p95']:.4f} | "
                         f"{value['p99']:.4f} | {value['max']:.4f} |")
    lines.extend(["", "Exact gains used by both reference and candidates:", "",
                  "| Setting | CCT K | Linear R gain | G gain | B gain |",
                  "|---|---:|---:|---:|---:|"])
    for setting in payload["settings"]:
        gain = setting["gain"]
        lines.append(f"| {setting['label']} | {setting['cct']:.2f} | {gain[0]:.6f} | "
                     f"{gain[1]:.6f} | {gain[2]:.6f} |")
    document = DOC.read_text(encoding="utf-8")
    if BEGIN not in document or END not in document:
        raise RuntimeError("WB study result markers missing")
    document = document.split(BEGIN, 1)[0] + BEGIN + "\n" + "\n".join(lines) + "\n" + END + document.split(END, 1)[1]
    DOC.write_text(document, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    RESULT_DIR.mkdir(parents=True, exist_ok=True)
    stocks = {stock["id"]: stock for stock in load_stocks()}
    fixtures = [fixture for fixture in prepare_phone_fixtures(max_pixels=240000)
                if fixture["id"].removeprefix("phone_") in PHOTO_IDS]
    records = load_checkpoints() if args.resume else []
    completed = {record["id"] for record in records}
    for stock_id in STOCK_IDS:
        if stock_id in completed:
            continue
        stock = stocks[stock_id]
        started = perf_counter()
        stock_record = {"version": 1, "id": stock_id, "images": []}
        print(f"[WB study] {stock_id}", flush=True)
        for fixture in fixtures:
            source = load_fixture(fixture)
            linear_source = decode_srgb_input(encoded_srgb(source))
            image_record = {"photo": fixture["id"], "width": source.shape[1],
                            "height": source.shape[0],
                            "candidates": {candidate: {} for candidate in CANDIDATES}}
            for setting_id, label, temperature, tint in SETTINGS:
                gain = white_balance(temperature, tint)["gain"]
                reference = np.clip(simulate_linear_srgb(
                    linear_source * gain, stock,
                    overrides={"enlarger_print_exposure_compensation": False},
                ), 0.0, 1.0).astype(np.float32)
                reference_lab = rgb2lab(reference)
                for candidate in CANDIDATES:
                    path = base_path(stock_id) if candidate == "A" else grid_path(candidate.lower(), stock_id)
                    candidate_gain = gain if candidate == "A" else gain * 0.25
                    output = apply_lut_camera_gain(source, path, candidate_gain)
                    delta_path = DELTA_DIR / stock_id / fixture["id"] / f"{candidate}_{setting_id}.npy"
                    image_record["candidates"][candidate][setting_id] = metrics(
                        reference, output, reference_lab, delta_path,
                    )
                    del output
                print(f"  {fixture['id']} {setting_id}", flush=True)
                del reference, reference_lab
                gc.collect()
            stock_record["images"].append(image_record)
            del source, linear_source
            gc.collect()
        stock_record["seconds"] = round(perf_counter() - started, 3)
        path = RESULT_DIR / f"{stock_id}.json"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(stock_record, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        temporary.replace(path)
        records.append(stock_record)
        records.sort(key=lambda record: STOCK_IDS.index(record["id"]))
        update_reports(records, complete=False)
        print(f"[WB checkpoint] {stock_id}; {stock_record['seconds']:.1f}s", flush=True)
    update_reports(records, complete=True)
    print(f"[done] wrote {RAW_JSON} and updated {DOC}", flush=True)


if __name__ == "__main__":
    main()
