#!/usr/bin/env python3
"""Generate the markdown tables of docs/EFFECTS.md from the measured data.

Reads the committed physics summary (docs/effects-physics.json), the raw
study (build/p5a/effects-study.json) and the harness report
(harness/out/effects/effects-report.json), and prints the tables.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
PHYSICS = ROOT / "docs" / "effects-physics.json"
STUDY = ROOT / "build" / "p5a" / "effects-study.json"
REPORT = ROOT / "harness" / "out" / "effects-report.json"


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def parse_stock_constants() -> dict:
    """Read the generated per-stock constants out of utils/effects.js."""
    path = ROOT / "utils" / "effects.js"
    if not path.is_file():
        return {}
    text = path.read_text(encoding="utf-8")
    pattern = re.compile(
        r"    (\w+): Object\.freeze\(\{\n"
        r"      grain: Object\.freeze\(\{\n"
        r"        curve: Object\.freeze\(\[([^\]]*)\]\),\n"
        r"        matrix: Object\.freeze\(\[([^\]]*)\]\),",
        re.MULTILINE,
    )
    constants = {}
    for match in pattern.finditer(text):
        stock = match.group(1)
        curve = [float(value) for value in match.group(2).split(",")]
        matrix = [float(value) for value in match.group(3).split(",")]
        constants[stock] = {"curve": curve, "matrix": matrix}
    return constants


def curve_lookup(curve: list[float], level: float) -> float:
    scaled = max(0.0, min(1.0, level / 255.0)) * (len(curve) - 1)
    index = int(scaled)
    index = min(index, len(curve) - 2) if len(curve) > 1 else 0
    fraction = scaled - index
    return curve[index] + (curve[index + 1] - curve[index]) * fraction


def grain_table(physics: dict, stocks: list[str]) -> str:
    lines = [
        "| stock | output code | physical std R/G/B (code) | shader model std R/G/B (code) |",
        "|---|---|---|---|",
    ]
    constants = parse_stock_constants()
    for stock in stocks:
        rows = physics["grain"][stock]["levels"]
        entry = constants.get(stock)
        norms = [1.0, 1.0, 1.0]
        if entry:
            matrix = entry["matrix"]
            norms = [
                float(np.linalg.norm(matrix[0:3])),
                float(np.linalg.norm(matrix[3:6])),
                float(np.linalg.norm(matrix[6:9])),
            ]
        used = set()
        for target in (30, 60, 118, 170, 210):
            index = min(
                (i for i in range(len(rows)) if i not in used),
                key=lambda i: abs(rows[i]["output_codes"][0] - target),
            )
            used.add(index)
            row = rows[index]
            level = float(np.mean(row["output_codes"]))
            if entry:
                amplitude = curve_lookup(entry["curve"], level)
                shader = " / ".join(
                    f"{amplitude * norms[channel]:.3f}" for channel in range(3)
                )
            else:
                shader = "n/a"
            lines.append(
                f"| {stock} | {row['output_codes'][0]:.1f} "
                f"| {row['std_codes'][0]:.3f} / {row['std_codes'][1]:.3f} / {row['std_codes'][2]:.3f}"
                f" | {shader} |"
            )
    return "\n".join(lines)


def autocorrelation_table(physics: dict) -> str:
    lines = [
        "| quantity | physical | shader (1280 px) | shader model |",
        "|---|---|---|---|",
    ]
    report = load(REPORT)
    measured = {}
    if report:
        mirror = report["numbers"].get("mirror", {})
        measured = mirror.get("measured", {}).get("autocorr", [{}])[0]
    rho10 = np.mean([row["rho10"] for row in physics["grain"]["portra400"]["levels"]])
    rho11 = np.mean([row["rho11"] for row in physics["grain"]["portra400"]["levels"]])
    rho20 = np.mean([row["rho20"] for row in physics["grain"]["portra400"]["levels"]])
    lines.append(f"| rho(1 px) | {rho10:.4f} | {measured.get('1,0', 0):.4f} | 0.5223 (fitted) |")
    lines.append(f"| rho(1,1 px) | {rho11:.4f} | {measured.get('1,1', 0):.4f} | 0.2708 (fitted) |")
    lines.append(f"| rho(2 px) | {rho20:.4f} | {measured.get('2,0', 0):.4f} | 0.0528 (fitted) |")
    return "\n".join(lines)


def halation_table(physics: dict) -> str:
    lines = [
        "| radius (px) | radius (um) | physical R/G/B (code) | shader R/G/B (code) |",
        "|---|---|---|---|",
    ]
    report = load(REPORT)
    rows = {}
    if report:
        for row in report["numbers"].get("halationComparison", []):
            rows[row["radius_px"]] = row
    for entry in physics["halation"]["portra400"]["profile"]:
        radius = entry["radius_px"]
        if radius % 2 or radius > 52:
            continue
        shader_text = "n/a"
        if radius in rows:
            shader_text = " / ".join(f"{value:.4f}" for value in rows[radius]["shader"])
        lines.append(
            f"| {radius} | {entry['radius_um']:.0f} "
            f"| {entry['mean_codes'][0]:.4f} / {entry['mean_codes'][1]:.4f} / {entry['mean_codes'][2]:.4f}"
            f" | {shader_text} |"
        )
    return "\n".join(lines)


def stock_table(physics: dict) -> str:
    lines = [
        "| stock | film profile | anti-halation | sigma_h (um) | a_R / a_G / a_B | grain peak (code) |",
        "|---|---|---|---|---|---|",
    ]
    presets = {
        ("still", "strong"): (65.0, (0.015, 0.005, 0.0)),
        ("still", "weak"): (65.0, (0.08, 0.02, 0.0)),
        ("cine", "strong"): (50.0, (0.015, 0.005, 0.0)),
    }
    films = {
        "portra400": ("kodak_portra_400", "still", "strong"),
        "portra160": ("kodak_portra_160", "still", "strong"),
        "gold200": ("kodak_gold_200", "still", "weak"),
        "ultramax400": ("kodak_ultramax_400", "still", "weak"),
        "ektar100": ("kodak_ektar_100", "still", "strong"),
        "velvia100": ("fujifilm_velvia_100", "still", "strong"),
        "provia100f": ("fujifilm_provia_100f", "still", "strong"),
        "kodachrome64": ("kodak_kodachrome_64", "still", "weak"),
        "pro400h": ("fujifilm_pro_400h", "still", "strong"),
        "vision3_250d": ("kodak_vision3_250d", "cine", "strong"),
        "vision3_500t": ("kodak_vision3_500t", "cine", "strong"),
    }
    for stock_id, (film, use, anti) in films.items():
        sigma, strength = presets[(use, anti)]
        rows = physics["grain"][stock_id]["levels"]
        peak = max(row["std_codes"][0] for row in rows)
        lines.append(
            f"| {stock_id} | {film} | {anti} | {sigma:.0f} "
            f"| {strength[0]:.3f} / {strength[1]:.3f} / {strength[2]:.3f} | {peak:.2f} |"
        )
    return "\n".join(lines)


def photo_table(report: dict | None) -> str:
    lines = [
        "| quantity | physical | shader |",
        "|---|---|---|",
    ]
    if not report or "physicsHalationPhoto" not in report.get("numbers", {}):
        return lines[0] + "\n(measurement missing)"
    entry = report["numbers"]["physicsHalationPhoto"]
    lines.append(f"| rms difference (code) | {entry['rms_code']:.4f} | {entry['shader_rms_code']:.4f} |")
    lines.append(f"| max difference (code) | {entry['max_abs_code']:.2f} | {entry['shader_max_abs_code']:.2f} |")
    lines.append(
        "| mean R/G/B difference (code) | "
        + " / ".join(f"{value:.4f}" for value in entry["mean_codes"])
        + " | "
        + " / ".join(f"{value:.4f}" for value in entry["shader_mean_codes"])
        + " |"
    )
    lines.append(
        f"| rms of (physical − shader) | {entry['difference_rms_code']:.4f} | |"
    )
    lines.append(
        f"| max of (physical − shader) | {entry['difference_max_code']:.2f} | |"
    )
    return "\n".join(lines)


def split_table(split: dict | None) -> str:
    lines = [
        "| term | rms (code) | max |",
        "|---|---|---|",
    ]
    if not split:
        return lines[0] + "\n(measurement missing)"
    for key, label in (("full", "full physical halation"),
                       ("scatter_only", "in-emulsion scatter only"),
                       ("backreflection_only", "back-reflection only")):
        entry = split[key]
        lines.append(f"| {label} | {entry['rms']:.4f} | {entry['max']:.3f} |")
    return "\n".join(lines)


def main() -> int:
    physics = load(PHYSICS)
    if physics is None:
        raise SystemExit(f"missing {PHYSICS}")
    report = load(REPORT)
    split = load(ROOT / "build" / "p5a" / "halation-split.json")
    tables = {
        "grain": grain_table(physics, ["portra400", "gold200", "velvia100", "vision3_500t"]),
        "autocorrelation": autocorrelation_table(physics),
        "halation": halation_table(physics),
        "photo": photo_table(report),
        "split": split_table(split),
    }
    if "--write" in sys.argv:
        path = ROOT / "docs" / "EFFECTS.md"
        text = path.read_text(encoding="utf-8")
        for name, table in tables.items():
            marker = f"<!--TABLE {name}-->"
            if marker not in text:
                continue
            text = text.replace(marker, table)
        path.write_text(text, encoding="utf-8")
        print(f"updated {path}")
        return 0
    print("### grain amplitude\n")
    print(tables["grain"])
    print("\n### autocorrelation\n")
    print(tables["autocorrelation"])
    print("\n### halation profile\n")
    print(tables["halation"])
    print("\n### photo\n")
    print(tables["photo"])
    print("\n### split\n")
    print(tables["split"])
    print("\n### per-stock constants\n")
    print(stock_table(physics))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
