#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Fill cordis.yml plugin entries from src/ files.

Scans <root>/src for plugin modules and ensures <root>/cordis.yml has a
matching `- insert:` entry per file, with `name:` set to the file's absolute
path (the Cordis loader resolves `- insert:` rows via plain `import()`, so a
bare `src/foo.ts` does not resolve on its own; absolute paths always work and
`./`-prefixed relative paths resolve against the config directory).

Existing rows are matched by `id` and left otherwise untouched, so per-row
`config:`, `disabled:`, `inject:`, comments and layout survive. New rows are
appended to the `- insert:` block (created when missing).

Usage:
    uv run --script sync_cordis.py [--root DIR] [--check] [--prune] [--relative]
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

PLUGIN_EXTS = {".ts", ".mts", ".js", ".mjs", ".cjs"}
NAME_RE = re.compile(r"export\s+(?:const|let|var)\s+name\s*=\s*['\"]([^'\"]+)['\"]")
ID_LINE_RE = re.compile(r"^    - id:\s*(?P<id>.*?)\s*$")
NAME_LINE_RE = re.compile(r"^(?P<indent>\s*)name:(?P<gap>\s*)(?P<value>.*?)(?P<comment>\s+#.*)?$")
TOP_ITEM_RE = re.compile(r"^-\s")


def iter_plugin_files(src: Path) -> list[Path]:
    """Collect plugin modules under src/, skipping type/test files."""
    found = []
    for path in sorted(src.rglob("*")):
        if not path.is_file() or path.suffix not in PLUGIN_EXTS:
            continue
        name = path.name
        if name.endswith((".d.ts", ".d.mts", ".d.cts")):
            continue
        if ".test." in name or ".spec." in name:
            continue
        found.append(path)
    return found


def sanitize(stem: str) -> str:
    """Fall back to a loader-safe id derived from the file name."""
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "-", stem).strip("-")
    return cleaned or "plugin"


def plugin_id_for(path: Path, taken: set[str]) -> str:
    """Prefer the module's `export const name = '...'`; dedupe on clash."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        text = ""
    match = NAME_RE.search(text)
    base = match.group(1) if match else sanitize(path.stem)
    candidate, n = base, 2
    while candidate in taken:
        candidate = f"{base}-{n}"
        n += 1
    taken.add(candidate)
    return candidate


def quote(value: str) -> str:
    """Single-quote a YAML scalar, doubling embedded quotes."""
    return "'" + value.replace("'", "''") + "'"


def unquote(value: str) -> str:
    """Strip one layer of YAML single/double quotes for comparison."""
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        inner = value[1:-1]
        return inner.replace("''", "'") if value[0] == "'" else inner
    return value


def find_insert_block(lines: list[str]) -> int | None:
    """Return the line index of the top-level `- insert:` item, if any."""
    for i, line in enumerate(lines):
        if line.strip() == "- insert:":
            return i
    return None


def insert_block_end(lines: list[str], insert_idx: int) -> int:
    """Return the first line index past the `- insert:` block."""
    for i in range(insert_idx + 1, len(lines)):
        if TOP_ITEM_RE.match(lines[i]):
            return i
    return len(lines)


def parse_insert_entries(lines: list[str], insert_idx: int) -> dict[str, dict]:
    """Map entry id -> line spans for rows inside the `- insert:` block."""
    entries: dict[str, dict] = {}
    end = insert_block_end(lines, insert_idx)
    i = insert_idx + 1
    while i < end:
        match = ID_LINE_RE.match(lines[i])
        if not match:
            i += 1
            continue
        entry_id = unquote(match.group("id"))
        name_line = None
        j = i + 1
        while j < end and not ID_LINE_RE.match(lines[j]):
            if name_line is None and NAME_LINE_RE.match(lines[j]):
                name_line = j
            j += 1
        entries[entry_id] = {"id_line": i, "name_line": name_line, "end": j}
        i = j
    return entries


def spec_for(path: Path, yml_dir: Path, relative: bool) -> str:
    """Render the `name:` value for a plugin file."""
    if relative:
        return "./" + path.resolve().relative_to(yml_dir.resolve()).as_posix()
    return str(path.resolve())


def looks_filesystem_target(value: str) -> bool:
    """True when a name value is a file path rather than a package specifier."""
    v = unquote(value)
    return v.startswith(("/", ".", "~")) or "/" in v or v.endswith(tuple(PLUGIN_EXTS))


def plan(
    root: Path, src: Path, yml: Path, relative: bool, prune: bool
) -> tuple[list[Path], list[tuple], dict[str, dict], list[str], list[tuple], list[tuple]]:
    """Compute (plugins, additions, entries, lines, updates, removals)."""
    plugins = iter_plugin_files(src)
    taken: set[str] = set()
    desired = [(plugin_id_for(p, taken), p) for p in plugins]
    lines = yml.read_text(encoding="utf-8").splitlines() if yml.exists() else []
    insert_idx = find_insert_block(lines) if lines else None
    entries = parse_insert_entries(lines, insert_idx) if insert_idx is not None else {}
    additions = [(i, p) for i, p in desired if i not in entries]
    updates = []
    for entry_id, path in desired:
        if entry_id not in entries:
            continue
        want = spec_for(path, yml.parent, relative)
        name_line = entries[entry_id]["name_line"]
        if name_line is None:
            updates.append((entry_id, None, want))
        elif unquote(NAME_LINE_RE.match(lines[name_line]).group("value")) != want:  # type: ignore[union-attr]
            updates.append((entry_id, lines[name_line].strip(), want))
    removals = []
    if prune and insert_idx is not None:
        wanted_ids = {i for i, _ in desired}
        for entry_id, span in entries.items():
            if entry_id in wanted_ids or span["name_line"] is None:
                continue
            raw = NAME_LINE_RE.match(lines[span["name_line"]]).group("value")  # type: ignore[union-attr]
            if not looks_filesystem_target(raw):
                continue
            target = (yml.parent / unquote(raw)).resolve()
            try:
                inside = target.is_relative_to(root.resolve())
            except AttributeError:  # Python 3.8 fallback, unreachable on >=3.11
                inside = str(target).startswith(str(root.resolve()))
            if inside and not target.exists():
                removals.append((entry_id, span))
    return plugins, additions, entries, lines, updates, removals


def apply(
    lines: list[str], yml: Path, relative: bool, additions: list[tuple],
    updates: list[tuple], removals: list[tuple], entries: dict[str, dict],
) -> list[str]:
    """Apply removals, updates and additions to the line buffer."""
    for _entry_id, span in sorted(removals, key=lambda r: r[1]["id_line"], reverse=True):
        del lines[span["id_line"] : span["end"]]
    # Re-parse spans after removal.
    insert_idx = find_insert_block(lines)
    if insert_idx is not None and not parse_insert_entries(lines, insert_idx) and not additions:
        # Pruning emptied the block: drop the dangling `- insert:` header too,
        # since `- insert:` with a null value is not a valid patch row.
        end = insert_block_end(lines, insert_idx)
        if all(not lines[i].strip() or lines[i].startswith((" ", "\t")) for i in range(insert_idx + 1, end)):
            del lines[insert_idx:end]
            insert_idx = None
    if insert_idx is not None:
        entries = parse_insert_entries(lines, insert_idx)
    for entry_id, _old, want in updates:
        span = entries[entry_id]
        if span["name_line"] is None:
            lines.insert(span["id_line"] + 1, f"      name: {quote(want)}")
            entries = parse_insert_entries(lines, insert_idx)  # type: ignore[arg-type]
        else:
            match = NAME_LINE_RE.match(lines[span["name_line"]])
            assert match is not None
            comment = match.group("comment") or ""
            lines[span["name_line"]] = f"{match.group('indent')}name:{match.group('gap')}{quote(want)}{comment}"
    if additions:
        block = [f"    - id: {i}\n      name: {quote(spec_for(p, yml.parent, relative))}" for i, p in additions]
        if insert_idx is None:
            if lines and lines[-1].strip():
                lines.append("")
            lines.append("- insert:")
            lines.extend(block)
        else:
            end = insert_block_end(lines, insert_idx)
            lines[end:end] = block
    return lines


def main(argv: list[str] | None = None) -> int:
    """Parse args, report or write the synced cordis.yml."""
    default_root = Path(__file__).resolve().parent
    if not (default_root / "cordis.yml").exists() and not (default_root / "src").exists():
        default_root = Path.cwd()
    parser = argparse.ArgumentParser(description="Sync cordis.yml - insert: rows from src/ plugin files.")
    parser.add_argument("--root", type=Path, default=default_root, help="project dir holding src/ and cordis.yml")
    parser.add_argument("--src", type=Path, default=None, help="plugin source dir (default: <root>/src)")
    parser.add_argument("--yml", type=Path, default=None, help="loader file to fill (default: <root>/cordis.yml)")
    parser.add_argument("--relative", action="store_true", help="emit ./-relative names instead of absolute paths")
    parser.add_argument("--prune", action="store_true", help="drop rows whose in-root target file is gone")
    parser.add_argument("--check", action="store_true", help="report pending changes without writing")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    src = args.src or args.root / "src"
    yml = args.yml or args.root / "cordis.yml"
    if not src.is_dir():
        print(f"error: src dir not found: {src}", file=sys.stderr)
        return 2

    _plugins, additions, entries, lines, updates, removals = plan(args.root, src, yml, args.relative, args.prune)
    if args.verbose:
        taken: set[str] = set()
        for path in iter_plugin_files(src):
            print(f"found: {plugin_id_for(path, taken)} <- {path}")

    for entry_id, _path in additions:
        print(f"add: {entry_id}")
    for entry_id, old, want in updates:
        print(f"update: {entry_id}: {old} -> {quote(want)}")
    for entry_id, _span in removals:
        print(f"prune: {entry_id}")
    if not additions and not updates and not removals:
        print("cordis.yml is up to date")
        return 0
    if args.check:
        return 1
    lines = apply(lines, yml, args.relative, additions, updates, removals, entries)
    yml.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {yml}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
