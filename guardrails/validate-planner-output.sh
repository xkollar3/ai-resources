#!/usr/bin/env bash
# Guardrail: validate planner phase artifacts.
#
# Checks:
#   1) plan.md exists and is non-empty
#   2) affected_files.jsonl exists and each line matches expected schema
#
# Usage:
#   hooks/guardrail-validate-planner-output.sh [plan_path] [jsonl_path]
#
# Defaults:
#   plan_path  = plan.md
#   jsonl_path = affected_files.jsonl

set -euo pipefail

PLAN_PATH="${1:-plan.md}"
JSONL_PATH="${2:-affected_files.jsonl}"

if [[ ! -f "$PLAN_PATH" ]]; then
  echo "[guardrail] ERROR: missing required file: $PLAN_PATH" >&2
  exit 1
fi

if [[ ! -s "$PLAN_PATH" ]]; then
  echo "[guardrail] ERROR: plan file exists but is empty: $PLAN_PATH" >&2
  exit 1
fi

if [[ ! -f "$JSONL_PATH" ]]; then
  echo "[guardrail] ERROR: missing required file: $JSONL_PATH" >&2
  exit 1
fi

if [[ ! -s "$JSONL_PATH" ]]; then
  echo "[guardrail] ERROR: jsonl file exists but is empty: $JSONL_PATH" >&2
  exit 1
fi

python3 - "$JSONL_PATH" <<'PY'
import json
import sys
from pathlib import Path

jsonl_path = Path(sys.argv[1])

required_keys = {"fileName", "action", "actionContext", "ratio", "tests"}
allowed_actions = {"edit", "create", "delete"}

errors = []
valid_rows = 0

for line_no, raw_line in enumerate(jsonl_path.read_text(encoding="utf-8").splitlines(), start=1):
    line = raw_line.strip()

    if not line:
        continue

    try:
        obj = json.loads(line)
    except json.JSONDecodeError as e:
        errors.append(f"line {line_no}: invalid JSON ({e.msg})")
        continue

    if not isinstance(obj, dict):
        errors.append(f"line {line_no}: top-level JSON must be an object")
        continue

    keys = set(obj.keys())
    missing = sorted(required_keys - keys)
    extra = sorted(keys - required_keys)

    if missing:
        errors.append(f"line {line_no}: missing required keys: {', '.join(missing)}")
    if extra:
        errors.append(f"line {line_no}: unknown keys: {', '.join(extra)}")

    file_name = obj.get("fileName")
    if not isinstance(file_name, str) or not file_name.strip():
        errors.append(f"line {line_no}: fileName must be a non-empty string")

    action = obj.get("action")
    if action not in allowed_actions:
        errors.append(
            f"line {line_no}: action must be one of {sorted(allowed_actions)}"
        )

    action_context = obj.get("actionContext")
    if not isinstance(action_context, str) or not action_context.strip():
        errors.append(f"line {line_no}: actionContext must be a non-empty string")

    ratio = obj.get("ratio")
    ratio_ok = (
        ratio is None
        or (isinstance(ratio, str) and ratio.strip() != "")
        or ratio == "none"
    )
    if not ratio_ok:
        errors.append(
            f"line {line_no}: ratio must be null, 'none', or a non-empty string"
        )

    tests = obj.get("tests")
    if not isinstance(tests, list):
        errors.append(f"line {line_no}: tests must be an array of strings")
    else:
        for i, test_name in enumerate(tests):
            if not isinstance(test_name, str) or not test_name.strip():
                errors.append(
                    f"line {line_no}: tests[{i}] must be a non-empty string"
                )

    valid_rows += 1

if valid_rows == 0:
    errors.append("no non-empty JSONL entries found")

if errors:
    print("[guardrail] ERROR: planner output validation failed", file=sys.stderr)
    for err in errors:
        print(f"  - {err}", file=sys.stderr)
    sys.exit(1)

print(f"[guardrail] OK: {jsonl_path} schema is valid")
PY

echo "[guardrail] OK: planner artifacts validated ($PLAN_PATH, $JSONL_PATH)"
