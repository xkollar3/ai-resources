#!/usr/bin/env python3
"""
Inject rich file metadata from affected_files.jsonl into plan.md.

For every fileName reference found in plan.md, the reference is replaced
inline with the full metadata from the corresponding JSONL entry so the
plan becomes fully self-contained (no need to cross-reference the JSONL).

The expanded version is written to plan-full.md.

Usage:
  guardrails/inject-references.py [jsonl_path] [plan_path] [output_path]

Defaults:
  jsonl_path  = affected_files.jsonl
  plan_path   = plan.md
  output_path = plan-full.md
"""

import json
import re
import sys
from pathlib import Path


def collect_entries(jsonl_path: Path) -> dict[str, dict]:
    """Return {fileName: entry} for every row in the JSONL."""
    entries: dict[str, dict] = {}
    for line_no, raw_line in enumerate(
        jsonl_path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        line = raw_line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            print(f"[inject] WARNING: JSONL line {line_no} parse error: {e}", file=sys.stderr)
            continue

        fn = obj.get("fileName")
        if isinstance(fn, str) and fn.strip():
            entries[fn.strip()] = obj

    return entries


def format_replacement(file_name: str, entry: dict) -> str:
    """Build a compact inline replacement string from a JSONL entry."""
    action = entry.get("action", "?")
    context = str(entry.get("actionContext", "") or "").strip()
    ratio = entry.get("ratio")
    tests = entry.get("tests", [])

    parts = [f'{file_name} ({action}']

    if context:
        context_short = context if len(context) <= 100 else context[:97] + "..."
        parts.append(f' — "{context_short}"')

    if ratio and isinstance(ratio, str) and ratio.strip():
        ratio_short = ratio.strip() if len(ratio.strip()) <= 60 else ratio.strip()[:57] + "..."
        parts.append(f' | {ratio_short}')

    parts.append(")")

    if tests:
        test_names = ", ".join(str(t) for t in tests if isinstance(t, str))
        if test_names:
            parts.append(f" [tests: {test_names}]")

    return "".join(parts)


def inject(jsonl_path: Path, plan_path: Path, output_path: Path) -> None:
    if not jsonl_path.exists():
        print(f"[inject] ERROR: JSONL file not found: {jsonl_path}", file=sys.stderr)
        sys.exit(1)

    if not plan_path.exists():
        print(f"[inject] ERROR: plan file not found: {plan_path}", file=sys.stderr)
        sys.exit(1)

    entries = collect_entries(jsonl_path)
    if not entries:
        print("[inject] WARNING: no valid entries found in JSONL, copying plan as-is", file=sys.stderr)
        output_path.write_text(plan_path.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"[inject] plan-full written to {output_path} (no injections)")
        return

    plan_text = plan_path.read_text(encoding="utf-8")

    # Sort by length descending so longer paths match before shorter substrings
    # e.g. "src/foo/bar.ts" before "bar.ts"
    for file_name in sorted(entries, key=len, reverse=True):
        entry = entries[file_name]
        replacement = format_replacement(file_name, entry)
        escaped_fn = re.escape(file_name)

        # Try full-path match first, then basename match
        patterns = [rf'\b{escaped_fn}\b']
        basename = Path(file_name).name
        if basename != file_name:
            patterns.append(rf'\b{re.escape(basename)}\b')

        for pattern in patterns:
            new_text, count = re.subn(pattern, replacement, plan_text)
            if count > 0:
                plan_text = new_text
                break

    output_path.write_text(plan_text, encoding="utf-8")
    injected = len(entries)
    print(f"[inject] OK: {injected} reference(s) injected into {output_path}")


def main() -> None:
    jsonl_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("affected_files.jsonl")
    plan_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("plan.md")
    output_path = Path(sys.argv[3]) if len(sys.argv) > 3 else Path("plan-full.md")

    inject(jsonl_path, plan_path, output_path)


if __name__ == "__main__":
    main()
