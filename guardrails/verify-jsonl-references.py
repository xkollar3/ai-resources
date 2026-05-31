#!/usr/bin/env python3
"""
Guardrail: verify that every fileName in affected_files.jsonl is referenced
by its basename or full path in plan.md.

Usage:
  guardrails/verify-jsonl-references.sh [jsonl_path] [plan_path]

Defaults:
  jsonl_path = affected_files.jsonl
  plan_path  = plan.md
"""

import json
import re
import sys
from pathlib import Path


def main() -> None:
    jsonl_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("affected_files.jsonl")
    plan_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("plan.md")

    if not jsonl_path.exists():
        print(f"[guardrail] ERROR: missing JSONL file: {jsonl_path}", file=sys.stderr)
        sys.exit(1)

    if not plan_path.exists():
        print(f"[guardrail] ERROR: missing plan file: {plan_path}", file=sys.stderr)
        sys.exit(1)

    plan_text = plan_path.read_text(encoding="utf-8")

    filenames: list[str] = []
    parse_errors: list[str] = []

    for line_no, raw_line in enumerate(jsonl_path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue

        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            parse_errors.append(f"line {line_no}: invalid JSON ({e.msg})")
            continue

        file_name = obj.get("fileName")
        if not isinstance(file_name, str) or not file_name.strip():
            parse_errors.append(f"line {line_no}: fileName must be a non-empty string")
            continue

        filenames.append(file_name.strip())

    for e in parse_errors:
        print(f"[guardrail] ERROR: JSONL parsing: {e}", file=sys.stderr)

    if not filenames:
        print("[guardrail] ERROR: no fileName entries found in JSONL", file=sys.stderr)
        sys.exit(1)

    missing: list[str] = []

    for fn in filenames:
        basename = Path(fn).name
        # Full path match (only if fn differs from basename)
        full_match = bool(re.search(rf'\b{re.escape(fn)}\b', plan_text)) if fn != basename else None
        base_match = bool(re.search(rf'\b{re.escape(basename)}\b', plan_text))

        if full_match or base_match:
            continue

        missing.append(fn)

    if missing:
        print(
            "[guardrail] ERROR: the following fileName(s) from affected_files.jsonl "
            "are NOT referenced in plan.md:",
            file=sys.stderr,
        )
        for fn in missing:
            print(f"  - {fn}", file=sys.stderr)
        sys.exit(1)

    print(f"[guardrail] OK: all {len(filenames)} fileName(s) from affected_files.jsonl are referenced in plan.md")


if __name__ == "__main__":
    main()