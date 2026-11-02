#!/usr/bin/env python3
"""Static Mini Program and package-size checks that require no AppID."""
from __future__ import annotations

import json
import re
import struct
from pathlib import Path

from embed_shaders import DESTINATION as SHADER_DESTINATION
from embed_shaders import generate as generate_shaders

ROOT = Path(__file__).resolve().parents[1]
MAIN_PACKAGE_LIMIT = 2 * 1024 * 1024
LUT_PACKAGE_LIMIT = 1_200_000
NODE_BUILTINS = {
    "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
    "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http",
    "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process",
    "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "timers",
    "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
}
REQUIRE_PATTERN = re.compile(r"\brequire\s*\(\s*['\"]([^'\"]+)['\"]\s*\)")
EXCLUDED_WALK_DIRS = {".git", "node_modules", "build", "__pycache__"}
WXML_TAG_PATTERN = re.compile(
    r"<(/?)([A-Za-z][\w-]*)((?:\"[^\"]*\"|'[^']*'|[^>\"'])*?)(/?)>", re.S
)
WXML_HANDLER_PATTERN = re.compile(r"\b(?:bind|catch|mut-bind)[a-zA-Z:-]*\s*=\s*\"([^\"]+)\"")
WXML_EXPRESSION_PATTERN = re.compile(r"\{\{([^{}]*)\}\}", re.S)
WXML_FOR_PATTERN = re.compile(r"wx:for\s*=\s*\"\{\{[^}]*\}\"")
WXML_FOR_ITEM_PATTERN = re.compile(r"wx:for-item\s*=\s*\"([^\"]+)\"")
WXML_FOR_INDEX_PATTERN = re.compile(r"wx:for-index\s*=\s*\"([^\"]+)\"")
IDENTIFIER_PATTERN = re.compile(r"(?<![.\w$])([A-Za-z_$][\w$]*)")
STRING_LITERAL_PATTERN = re.compile(r"'[^']*'|\"[^\"]*\"")
EXPRESSION_KEYWORDS = {"true", "false", "null", "undefined", "item", "index"}
WARNINGS: list[str] = []


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def source_json_files() -> list[Path]:
    result = []
    for path in ROOT.rglob("*.json"):
        relative = path.relative_to(ROOT)
        if any(part in EXCLUDED_WALK_DIRS for part in relative.parts):
            continue
        if relative.parts[:2] == ("harness", "out"):
            continue
        result.append(path)
    return sorted(result)


def page_entries(app: dict) -> list[str]:
    entries = list(app.get("pages", []))
    for package in app.get("subpackages", app.get("subPackages", [])):
        root = package["root"].rstrip("/")
        entries.extend(f"{root}/{page}" for page in package.get("pages", []))
    return entries


def package_ignores(project: dict) -> tuple[set[str], set[str]]:
    folders = set()
    files = set()
    for item in project.get("packOptions", {}).get("ignore", []):
        value = item.get("value", "").strip("/")
        if item.get("type") == "folder":
            folders.add(value)
        elif item.get("type") == "file":
            files.add(value)
    return folders, files


def is_ignored(relative: Path, folders: set[str], files: set[str]) -> bool:
    name = relative.as_posix()
    if name in files or any(part == "node_modules" for part in relative.parts):
        return True
    return any(name == folder or name.startswith(f"{folder}/") for folder in folders)


def package_files(root: Path, ignored_folders=set(), ignored_files=set()) -> list[Path]:
    files = []
    if not root.exists():
        return files
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(ROOT)
        if ".git" in relative.parts or "__pycache__" in relative.parts:
            continue
        if root == ROOT and is_ignored(relative, ignored_folders, ignored_files):
            continue
        files.append(path)
    return sorted(files)


def check_png_geometry(manifest: list[dict], package_root: Path, errors: list[str]) -> None:
    for stock in manifest:
        variants = [stock] + ([stock["extended"]] if stock.get("extended") else [])
        for variant in variants:
            path = package_root / variant["file"]
            try:
                with path.open("rb") as stream:
                    header = stream.read(26)
                if header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
                    raise ValueError("not a PNG")
                width, height = struct.unpack(">II", header[16:24])
                expected = (variant["cols"] * variant["size"], variant["rows"] * variant["size"])
                if (width, height) != expected:
                    raise ValueError(f"dimensions {width}x{height}, expected {expected[0]}x{expected[1]}")
                if header[24] != 8 or header[25] != 2:
                    raise ValueError("expected 8-bit RGB PNG (colour type 2)")
                if path.stat().st_size != variant["bytes"]:
                    raise ValueError("manifest byte count does not match file")
            except (OSError, ValueError, KeyError, struct.error) as error:
                errors.append(f"Invalid LUT {path.relative_to(ROOT)}: {error}")


def page_data_keys(script_path: Path) -> set[str]:
    """Top-level keys of the page's ``data`` object (best effort)."""
    text = script_path.read_text(encoding="utf-8")
    match = re.search(r"\bdata\s*:\s*\{", text)
    if not match:
        return set()
    start = match.end() - 1
    depth = 0
    end = None
    for index in range(start, len(text)):
        character = text[index]
        if character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                end = index
                break
    if end is None:
        return set()
    body = text[start + 1:end]
    keys = set()
    depth = 0
    for line in body.splitlines():
        stripped = line.strip()
        if depth == 0:
            key = re.match(r"([A-Za-z_$][\w$]*)\s*:", stripped)
            if key:
                keys.add(key.group(1))
        depth += (
            stripped.count("{") + stripped.count("[")
            - stripped.count("}") - stripped.count("]")
        )
    return keys


def defined_handlers(script_path: Path) -> set[str]:
    text = script_path.read_text(encoding="utf-8")
    names = set(re.findall(r"^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(", text, re.M))
    names.update(re.findall(r"^\s{2}([A-Za-z_$][\w$]*)\s*:", text, re.M))
    return names


def check_wxml_tags(text: str, label: str, errors: list[str]) -> None:
    stripped = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    stack: list[str] = []
    for match in WXML_TAG_PATTERN.finditer(stripped):
        closing, name, attributes, self_closing = match.groups()
        if closing:
            if not stack:
                errors.append(f"{label}: unexpected closing tag </{name}>")
            elif stack[-1] != name:
                errors.append(
                    f"{label}: closing tag </{name}> does not match open <{stack[-1]}>"
                )
                stack.pop()
            else:
                stack.pop()
        elif not self_closing:
            stack.append(name)
    for name in stack:
        errors.append(f"{label}: unclosed tag <{name}>")


def check_wxml_handlers(text: str, label: str, handlers: set[str], errors: list[str]) -> None:
    for handler in sorted(set(WXML_HANDLER_PATTERN.findall(text))):
        if handler not in handlers:
            errors.append(f"{label}: event handler '{handler}' is not defined on the page")


def check_wxml_identifiers(text: str, label: str, data_keys: set[str],
                          errors: list[str]) -> None:
    aliases = {"item", "index"}
    for match in WXML_FOR_ITEM_PATTERN.finditer(text):
        aliases.add(match.group(1))
    for match in WXML_FOR_INDEX_PATTERN.finditer(text):
        aliases.add(match.group(1))
    known = data_keys | aliases
    missing: set[str] = set()
    for expression in WXML_EXPRESSION_PATTERN.findall(text):
        cleaned = STRING_LITERAL_PATTERN.sub(" ", expression)
        for identifier in IDENTIFIER_PATTERN.findall(cleaned):
            if identifier in EXPRESSION_KEYWORDS or identifier in known:
                continue
            missing.add(identifier)
    for identifier in sorted(missing):
        errors.append(
            f"{label}: data identifier '{identifier}' is not in the page data or a wx:for alias"
        )


def check_wxss(path: Path, errors: list[str]) -> None:
    text = path.read_text(encoding="utf-8")
    for match in re.finditer(r"@import\s+([\"'])([^\"']+)\1", text):
        target = (path.parent / match.group(2)).resolve()
        if not target.is_file():
            errors.append(f"{path.relative_to(ROOT)}: @import target {match.group(2)} is missing")
    body = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    body = re.sub(r"@import[^;]+;", "", body)
    if re.search(r"(^|[\s,>+~])\*(?![\w-])", body):
        WARNINGS.append(f"{path.relative_to(ROOT)}: universal '*' selector is not reliable")
    if ":hover" in body:
        WARNINGS.append(f"{path.relative_to(ROOT)}: ':hover' has no effect in a Mini Program")


def main() -> int:
    errors = []
    json_files = source_json_files()
    for path in json_files:
        try:
            load_json(path)
        except (OSError, json.JSONDecodeError) as error:
            errors.append(f"JSON {path.relative_to(ROOT)}: {error}")
    try:
        app = load_json(ROOT / "app.json")
        project = load_json(ROOT / "project.config.json")
    except (OSError, json.JSONDecodeError) as error:
        print(f"Cannot continue: {error}")
        return 1

    packages = app.get("subpackages", app.get("subPackages", []))
    for package in packages:
        if not isinstance(package.get("pages"), list) or not package["pages"]:
            errors.append(f"Subpackage {package.get('root', '?')} must declare a nonempty pages list")

    # page_entries() prefixes each subpackage page with its root before these
    # existence checks, so both main-package and subpackage pages are covered.
    pages = page_entries(app)
    for entry in pages:
        for extension in ("js", "json", "wxml", "wxss"):
            path = ROOT / f"{entry}.{extension}"
            if not path.is_file():
                errors.append(f"Missing page file: {path.relative_to(ROOT)}")

    # WXML/WXSS consistency: handlers exist, tags balance, data identifiers
    # resolve, and no unsupported stylesheet constructs are used.
    for entry in pages:
        wxml_path = ROOT / f"{entry}.wxml"
        script_path = ROOT / f"{entry}.js"
        wxss_path = ROOT / f"{entry}.wxss"
        if wxml_path.is_file():
            wxml = wxml_path.read_text(encoding="utf-8")
            label = wxml_path.relative_to(ROOT)
            check_wxml_tags(wxml, str(label), errors)
            if script_path.is_file():
                check_wxml_handlers(wxml, str(label), defined_handlers(script_path), errors)
                check_wxml_identifiers(wxml, str(label), page_data_keys(script_path), errors)
        if wxss_path.is_file():
            check_wxss(wxss_path, errors)

    runtime_files = [ROOT / "app.js"]
    for directory in ("pages", "utils", "renderer"):
        runtime_files.extend((ROOT / directory).rglob("*.js"))
    for package in app.get("subpackages", app.get("subPackages", [])):
        runtime_files.extend((ROOT / package["root"]).rglob("*.js"))
    for path in runtime_files:
        if not path.is_file():
            continue
        for imported in REQUIRE_PATTERN.findall(path.read_text(encoding="utf-8")):
            normalized = imported.removeprefix("node:").split("/")[0]
            if imported.startswith("node:") or normalized in NODE_BUILTINS:
                errors.append(f"Node builtin require '{imported}' in {path.relative_to(ROOT)}")

    if not SHADER_DESTINATION.exists() or SHADER_DESTINATION.read_text(encoding="utf-8") != generate_shaders():
        errors.append("utils/shaders.js is stale; run python3 tools/embed_shaders.py")

    ignored_folders, ignored_files = package_ignores(project)
    for package in app.get("subpackages", app.get("subPackages", [])):
        root = package["root"].strip("/")
        ignored_folders.add(root)
    main_files = package_files(ROOT, ignored_folders, ignored_files)
    main_size = sum(path.stat().st_size for path in main_files)
    if main_size >= MAIN_PACKAGE_LIMIT:
        errors.append(f"Main package is {main_size} bytes; limit is < {MAIN_PACKAGE_LIMIT}")

    lut_sizes = {}
    for package in app.get("subpackages", app.get("subPackages", [])):
        root = ROOT / package["root"]
        size = sum(path.stat().st_size for path in package_files(root))
        lut_sizes[package.get("name", package["root"])] = size
        if package.get("name") == "luts":
            if size >= LUT_PACKAGE_LIMIT:
                errors.append(f"LUT subpackage is {size} bytes; limit is < {LUT_PACKAGE_LIMIT}")
            try:
                manifest = load_json(root / "luts.json")
                check_png_geometry(manifest, root, errors)
            except (OSError, json.JSONDecodeError) as error:
                errors.append(f"LUT manifest: {error}")

    print(f"JSON files parsed: {len(json_files)}")
    print(f"Page entries checked: {len(pages)}")
    for warning in WARNINGS:
        print(f"WARN: {warning}")
    print(f"Main package: {main_size} bytes ({main_size / 1024:.1f} KiB), {len(main_files)} files")
    for name, size in lut_sizes.items():
        print(f"Subpackage {name}: {size} bytes ({size / 1024:.1f} KiB)")
    print("Shader embedding: current" if not errors else "Shader embedding: see errors")
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        print("Static checks: FAIL")
        return 1
    print("Static checks: PASS (miniprogram-ci intentionally skipped: requires AppID/private key)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
