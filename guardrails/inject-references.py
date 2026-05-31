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
    """Build a per-field-per-line replacement string from a JSONL entry."""
    action = entry.get("action", "?")
    context = str(entry.get("actionContext", "") or "").strip()
    ratio = entry.get("ratio")
    tests = entry.get("tests", [])

    lines = [f"- fileName: {file_name}"]
    lines.append(f"  action: {action}")

    if context:
        lines.append(f"  context: {context}")

    if ratio and isinstance(ratio, str) and ratio.strip():
        lines.append(f"  ratio: {ratio.strip()}")

    if tests:
        test_names = [str(t) for t in tests if isinstance(t, str)]
        if test_names:
            lines.append(f"  tests: {', '.join(test_names)}")

    return "\n".join(lines)


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

    # Build the replacement block: all entries as per-field-per-line blocks
    replacement_lines = []
    for file_name in sorted(entries, key=len, reverse=True):
        replacement_lines.append(format_replacement(file_name, entries[file_name]))
    replacement_block = "\n".join(replacement_lines)

    # Replace markdown table under "**Affected file:" (or "**Affected files:")
    # Pattern: the heading line, then a markdown table (header row, separator row, data rows)
    # This regex captures everything after the heading until the next blank-line-delimited section
    # or end of string.
    table_pattern = re.compile(
        r'(\*\*Affected files?:\*\*)\n+'
        r'\|\s*fileName\s*\|.*\n'     # header row
        r'\|\s*:?--+:?\s*\|.*\n'        # separator row
        r'(?:\|.*\n)*',                  # data rows
        re.MULTILINE
    )

    plan_text = table_pattern.sub(
        lambda m: m.group(1) + "\n\n" + replacement_block,
        plan_text
    )

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
