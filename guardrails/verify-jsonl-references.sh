#!/usr/bin/env bash
# Guardrail: verify that every fileName in affected_files.jsonl is referenced
# by its basename or full path in plan.md.
#
# Usage:
#   guardrails/verify-jsonl-references.sh [jsonl_path] [plan_path]
#
# Defaults:
#   jsonl_path = affected_files.jsonl
#   plan_path  = plan.md

set -euo pipefail

JSONL_PATH="${1:-affected_files.jsonl}"
PLAN_PATH="${2:-plan.md}"

if [[ ! -f "$JSONL_PATH" ]]; then
  echo "[guardrail] ERROR: missing JSONL file: $JSONL_PATH" >&2
  exit 1
fi

if [[ ! -f "$PLAN_PATH" ]]; then
  echo "[guardrail] ERROR: missing plan file: $PLAN_PATH" >&2
  exit 1
fi

python3 - "$JSONL_PATH" "$PLAN_PATH" <<'PY'
import json
import sys
from pathlib import Path

jsonl_path = Path(sys.argv[1])
plan_path = Path(sys.argv[2])

plan_text = plan_path.read_text(encoding="utf-8")

filenames = []
parse_errors = []

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

if parse_errors:
    for e in parse_errors:
        print(f"[guardrail] ERROR: JSONL parsing: {e}", file=sys.stderr)

if not filenames:
    print("[guardrail] ERROR: no fileName entries found in JSONL", file=sys.stderr)
    sys.exit(1)

missing = []

for fn in filenames:
    # The fileName may be a full path or just a basename.
    # Look for either the basename or the full path in plan.md.
    basename = Path(fn).name
    # Check if either the full path or the basename appears in the plan text.
    # Use word-boundary matching to avoid false positives (e.g., "foo" matching "foobar").
    import re
    full_match = re.search(rf'\b{re.escape(fn)}\b', plan_text) if fn != basename else None
    base_match = re.search(rf'\b{re.escape(basename)}\b', plan_text)

    if full_match or base_match:
        continue

    missing.append(fn)

if missing:
    print("[guardrail] ERROR: the following fileName(s) from affected_files.jsonl are NOT referenced in plan.md:", file=sys.stderr)
    for fn in missing:
        print(f"  - {fn}", file=sys.stderr)
    sys.exit(1)

print(f"[guardrail] OK: all {len(filenames)} fileName(s) from affected_files.jsonl are referenced in plan.md")
PY
