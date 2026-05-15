#!/usr/bin/env bash
# Guardrail: report missing planned tests from affected_files.jsonl.
#
# Compares expected test names in affected_files.jsonl against added lines in diff vs HEAD.
# This script NEVER fails the pipeline; it reports warnings only.
#
# Usage:
#   guardrails/report-missing-tests.sh [jsonl_path] [base_ref]
#
# Defaults:
#   jsonl_path = affected_files.jsonl
#   base_ref   = HEAD

set -euo pipefail

JSONL_PATH="${1:-affected_files.jsonl}"
BASE_REF="${2:-HEAD}"

if [[ ! -f "$JSONL_PATH" ]]; then
  echo "[guardrail] WARNING: missing JSONL file: $JSONL_PATH"
  exit 0
fi

if [[ ! -s "$JSONL_PATH" ]]; then
  echo "[guardrail] WARNING: JSONL file is empty: $JSONL_PATH"
  exit 0
fi

DIFF_CONTENT=$(git diff --unified=0 "$BASE_REF")

# Include untracked files so newly created tests are visible to this report.
UNTRACKED_FILES=$(git ls-files --others --exclude-standard)
if [[ -n "$UNTRACKED_FILES" ]]; then
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    [[ ! -f "$f" ]] && continue
    DIFF_CONTENT+=$'\n'
    DIFF_CONTENT+="+++ b/$f"
    DIFF_CONTENT+=$'\n'
    while IFS= read -r line || [[ -n "$line" ]]; do
      DIFF_CONTENT+="+$line"
      DIFF_CONTENT+=$'\n'
    done < "$f"
  done <<< "$UNTRACKED_FILES"
fi

DIFF_CONTENT="$DIFF_CONTENT" python3 - "$JSONL_PATH" <<'PY'
import json
import os
import re
import sys
from pathlib import Path

jsonl_path = Path(sys.argv[1])
diff_text = os.environ.get("DIFF_CONTENT", "")

expected_tests = []
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

    if not isinstance(obj, dict):
        parse_errors.append(f"line {line_no}: entry must be an object")
        continue

    tests = obj.get("tests", [])
    if tests is None:
        tests = []
    if not isinstance(tests, list):
        parse_errors.append(f"line {line_no}: tests must be an array")
        continue

    for idx, t in enumerate(tests):
        if isinstance(t, str) and t.strip():
            expected_tests.append(t.strip())
        elif t is not None:
            parse_errors.append(f"line {line_no}: tests[{idx}] must be a non-empty string")

if parse_errors:
    print("[guardrail] WARNING: JSONL parsing issues while checking tests:")
    for e in parse_errors:
        print(f"  - {e}")

expected_unique = []
seen = set()
for t in expected_tests:
    if t not in seen:
        seen.add(t)
        expected_unique.append(t)

if not expected_unique:
    print("[guardrail] INFO: no expected tests listed in affected_files.jsonl")
    sys.exit(0)

added_lines = []
for line in diff_text.splitlines():
    if line.startswith("+++"):
        continue
    if line.startswith("+"):
        added_lines.append(line[1:])

implemented = []
missing = []

for test_name in expected_unique:
    # Look for exact token or quoted occurrence in added lines.
    escaped = re.escape(test_name)
    patterns = [
        re.compile(rf"\b{escaped}\b"),
        re.compile(rf"['\"`]{escaped}['\"`]"),
    ]

    found = False
    for l in added_lines:
        if any(p.search(l) for p in patterns):
            found = True
            break

    if found:
        implemented.append(test_name)
    else:
        missing.append(test_name)

print(f"[guardrail] INFO: expected tests: {len(expected_unique)}")
print(f"[guardrail] INFO: detected in diff: {len(implemented)}")

if implemented:
    print("[guardrail] INFO: detected test implementations:")
    for t in implemented:
        print(f"  - {t}")

if missing:
    print("[guardrail] WARNING: planned tests not detected in current diff:")
    for t in missing:
        print(f"  - {t}")
else:
    print("[guardrail] OK: all planned tests were detected in diff additions")

# Always non-blocking.
sys.exit(0)
PY
