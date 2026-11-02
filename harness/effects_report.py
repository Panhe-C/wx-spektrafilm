"""Report and contact sheets for the Phase 5a spatial-effect harness."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "harness" / "out"
EFFECTS = OUT / "effects"


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


def load(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"), dtype=np.uint8)


def write_markdown(report: dict) -> None:
    lines = ["# Phase 5a spatial effects — harness report", ""]
    status = "PASS" if report.get("pass") else "FAIL"
    lines.append(f"Overall: **{status}**")
    lines.append("")
    lines.append(f"Photo: `{report.get('photo')}`")
    lines.append("")

    lines.append("## Checks")
    lines.append("")
    lines.append("| check | result | detail |")
    lines.append("|---|---|---|")
    identity = report["checks"]["identity"]
    lines.append(
        f"| identity (effects off vs `tools/lut_apply.py`) | {'PASS' if identity['pass'] else 'FAIL'} "
        f"| max {identity['maxCodeError']} code, mean {identity['meanCodeError']:.5f} |")
    lines.append(
        f"| determinism | {'PASS' if report['checks']['determinism']['pass'] else 'FAIL'} "
        f"| repeated renders are bit-identical |")
    scale = report["checks"]["scaleInvariance"]
    lines.append(
        f"| scale invariance | {'PASS' if scale['pass'] else 'FAIL'} "
        f"| std ratio {['%.4f' % r for r in scale['stdRatio']]}, "
        f"max autocorrelation delta {scale['maxCurveDelta']:.4f} |")
    mirror = report["checks"]["numpyMirror"]
    lines.append(
        f"| NumPy mirror of the shader grain | {'PASS' if mirror['pass'] else 'FAIL'} "
        f"| see the numbers below |")
    if "halationOrientation" in report["checks"]:
        orientation = report["checks"]["halationOrientation"]
        lines.append(
            f"| halation orientation (not mirrored) | "
            f"{'PASS' if orientation['pass'] else 'FAIL'} "
            f"| {orientation['nearPatch']:.4f} code near the bright patch, "
            f"{orientation['mirroredPatch']:.4f} code at the mirrored corner "
            f"(ratio {orientation['ratio']:.2f}) |")
    lines.append("")

    lines.append("## Grain statistics per output size")
    lines.append("")
    lines.append("| size | std R | std G | std B | rho(1,0) | rho(1,1) | rho(R,G) |")
    lines.append("|---|---|---|---|---|---|---|")
    for row in report["numbers"]["scale"]:
        auto = row["autocorr"]
        lines.append(
            f"| {row['width']}x{row['height']} | {row['std'][0]:.4f} | {row['std'][1]:.4f} "
            f"| {row['std'][2]:.4f} | {auto.get('1,0', 0):.4f} | {auto.get('1,1', 0):.4f} "
            f"| {row['cross']['rg']:.4f} |")
    lines.append("")

    lines.append("## Shader grain versus the NumPy mirror")
    lines.append("")
    mirror_numbers = report["numbers"]["mirror"]
    lines.append("| quantity | shader | NumPy mirror |")
    lines.append("|---|---|---|")
    for channel, name in enumerate("RGB"):
        lines.append(
            f"| std {name} (code) | {mirror_numbers['measured']['std'][channel]:.4f} "
            f"| {mirror_numbers['predicted']['std'][channel]:.4f} |")
    for lag, name in (("1,0", "rho(1,0)"), ("1,1", "rho(1,1)"), ("2,0", "rho(2,0)")):
        lines.append(
            f"| {name} | {mirror_numbers['measured']['autocorr'][0].get(lag, 0):.4f} "
            f"| {mirror_numbers['predicted']['autocorr'][0].get(lag, 0):.4f} |")
    for key, name in (("rg", "rho(R,G)"), ("rb", "rho(R,B)"), ("gb", "rho(G,B)")):
        lines.append(
            f"| {name} | {mirror_numbers['measured']['cross'][key]:.4f} "
            f"| {mirror_numbers['predicted']['cross'][key]:.4f} |")
    lines.append("")

    if "halationComparison" in report["numbers"]:
        lines.append("## Halation radial profile (physics versus shader)")
        lines.append("")
        lines.append("| radius px | radius um | physics R | shader R | physics G | shader G |")
        lines.append("|---|---|---|---|---|---|")
        for row in report["numbers"]["halationComparison"]:
            if row["radius_px"] % 3 and row["radius_px"] > 45:
                continue
            lines.append(
                f"| {row['radius_px']} | {row['radius_um']:.0f} "
                f"| {row['physics'][0]:.5f} | {row['shader'][0]:.5f} "
                f"| {row['physics'][1]:.5f} | {row['shader'][1]:.5f} |")
        lines.append("")

    if "physicsGrain" in report["numbers"]:
        lines.append("## Physical grain versus the shader grain (flat field)")
        lines.append("")
        physics = report["numbers"]["physicsGrain"]
        lines.append("| quantity | physical | shader |")
        lines.append("|---|---|---|")
        for channel, name in enumerate("RGB"):
            lines.append(
                f"| std {name} (code) | {physics['std'][channel]:.4f} "
                f"| {mirror_numbers['measured']['std'][channel]:.4f} |")
        for lag, name in (("1,0", "rho(1,0)"), ("1,1", "rho(1,1)"), ("2,0", "rho(2,0)")):
            lines.append(
                f"| {name} | {physics['autocorr'][0].get(lag, 0):.4f} "
                f"| {mirror_numbers['measured']['autocorr'][0].get(lag, 0):.4f} |")
        lines.append("")

    lines.append("## Effect timing at the preview size (SwiftShader)")
    lines.append("")
    lines.append("| effects | median ms | samples |")
    lines.append("|---|---|---|")
    for name, entry in report["numbers"]["timings"].items():
        samples = ", ".join(f"{value:.1f}" for value in entry["samples"])
        lines.append(f"| {name} | {entry['medianMs']:.2f} | {samples} |")
    lines.append("")
    lines.append("The timings are headless SwiftShader numbers, not device measurements.")
    lines.append("")
    (OUT / "effects-report.md").write_text("\n".join(lines))


def _crop(image: np.ndarray, x: int, y: int, size: int) -> Image.Image:
    patch = image[y:y + size, x:x + size]
    if patch.dtype != np.uint8:
        patch = np.clip(patch, 0, 255).astype(np.uint8)
    return Image.fromarray(patch)


def write_contact_sheets(cases: dict) -> None:
    """contact-effects.jpg and grain-compare.jpg."""
    write_contact_effects(cases)
    write_grain_compare()


def write_contact_effects(cases: dict) -> None:
    """Effects off/on crops at 100 % for three stocks."""
    source = load(EFFECTS / "effects-input.png")
    height, width = source.shape[:2]
    crop = 320
    x = max(0, width // 2 - crop // 2)
    y = max(0, height // 2 - crop // 2)
    tile = Image.new("RGB", (crop * 2 + 30, crop * 3 + 130), (17, 17, 17))
    draw = ImageDraw.Draw(tile)
    stocks = [("portra400", "Kodak Portra 400"), ("gold200", "Kodak Gold 200"),
              ("vision3_500t", "Kodak Vision3 500T")]
    # The harness rendered Portra only; the other two are rendered from the
    # same input by the browser script when available.
    rendered = {}
    for name in ("portra400", "gold200", "vision3_500t"):
        path = EFFECTS / f"contact-{name}-off.png"
        path_on = EFFECTS / f"contact-{name}-on.png"
        if path.is_file() and path_on.is_file():
            rendered[name] = (load(path), load(path_on))
    if not rendered:
        return
    for index, (stock_id, stock_name) in enumerate(stocks):
        if stock_id not in rendered:
            continue
        off, on = rendered[stock_id]
        top = 40 + index * (crop + 30)
        tile.paste(_crop(off, x, y, crop), (10, top))
        tile.paste(_crop(on, x, y, crop), (10 + crop + 10, top))
        label(draw, (12, top - 18), f"{stock_name} — effects off / on (100 %)", 15)
    tile.save(OUT / "contact-effects.jpg", quality=88)


def write_grain_compare() -> None:
    """A 1:1 crop of the physical grain next to the shader grain.

    Both panels show the *difference* between the grain-on and the grain-off
    render of the same flat field (Portra 400, 1280x192). The shader grain is
    scaled to the RMS of the physical grain, so that the two structures can be
    compared directly whatever gain the reference file was written with.
    """
    physics_path = EFFECTS / "physics-grain-diff.png"
    shader_path = EFFECTS / "grain-compare-on.png"
    shader_off = EFFECTS / "grain-compare-off.png"
    if not physics_path.is_file() or not shader_path.is_file():
        print("grain-compare.jpg: the physical reference is missing, sheet skipped")
        return
    physics = load(physics_path).astype(np.float64) - 128.0
    shader = load(shader_path).astype(np.float64)
    off = load(shader_off).astype(np.float64)
    grain = shader - off
    physics_std = float(np.std(physics))
    shader_std = float(np.std(grain))
    gain = physics_std / max(shader_std, 1e-9)
    height, width = physics.shape[:2]
    crop = min(320, height, width)
    x = max(0, width // 2 - crop // 2)
    y = max(0, height // 2 - crop // 2)
    tile = Image.new("RGB", (crop * 2 + 30, crop + 76), (17, 17, 17))
    draw = ImageDraw.Draw(tile)
    tile.paste(_crop(np.clip(128.0 + physics, 0, 255), x, y, crop), (10, 26))
    tile.paste(
        _crop(np.clip(128.0 + grain * gain, 0, 255).astype(np.uint8), x, y, crop),
        (10 + crop + 10, 26),
    )
    label(draw, (10, 6), "Portra 400 - flat field 1280x192 - grain difference", 13)
    label(draw, (10, 26 + crop + 6), "left: simulate() (physical)    right: shader", 13)
    label(draw, (10, 26 + crop + 24),
          "std {:.2f} / {:.2f} code, gain x{:.1f}".format(physics_std, shader_std, gain), 12)
    tile.save(OUT / "grain-compare.jpg", quality=90)
    print(f"grain-compare.jpg written (physical std {physics_std:.3f}, "
          f"shader std {shader_std:.3f}, gain x{gain:.1f})")
