#!/usr/bin/env bash
# Guardrail: hard-scope verification for implementation phase.
#
# Compares modified files against HEAD with allowed files from affected_files.jsonl.
# Excludes planner artifacts (plan.md, affected_files.jsonl) from changed-file checks.
#
# Fails (exit 1) if any modified file is outside planned scope.
#
# Usage:
#   guardrails/verify-changeset-scope.sh [jsonl_path] [base_ref]
#
# Defaults:
#   jsonl_path = affected_files.jsonl
#   base_ref   = HEAD

set -euo pipefail

JSONL_PATH="${1:-affected_files.jsonl}"
BASE_REF="${2:-HEAD}"

if [[ ! -f "$JSONL_PATH" ]]; then
  echo "[guardrail] ERROR: missing JSONL file: $JSONL_PATH" >&2
  exit 1
fi

if [[ ! -s "$JSONL_PATH" ]]; then
  echo "[guardrail] ERROR: JSONL file is empty: $JSONL_PATH" >&2
  exit 1
fi

CHANGED_TRACKED=$(git diff --name-only "$BASE_REF")
CHANGED_UNTRACKED=$(git ls-files --others --exclude-standard)
CHANGED_FILES=$(printf "%s\n%s\n" "$CHANGED_TRACKED" "$CHANGED_UNTRACKED" | awk 'NF' | sort -u)

CHANGED_FILES="$CHANGED_FILES" python3 - "$JSONL_PATH" <<'PY'
import json
import os
import sys
from pathlib import Path

jsonl_path = Path(sys.argv[1])
changed_raw = os.environ.get("CHANGED_FILES", "").splitlines()

# Planner/runtime artifact files to ignore from scope checks.
ignore_basenames = {
    "plan.md",
    "affected_files.jsonl",
    ".plan-and-implement-postcheck.log",
    "infeasibility-report.md",
}

changed = []
for p in changed_raw:
    p = p.strip()
    if not p:
        continue
    if os.path.basename(p) in ignore_basenames:
        continue
    changed.append(p)

allowed_exact = set()
allowed_basenames = set()
errors = []

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
        errors.append(f"line {line_no}: entry must be an object")
        continue

    file_name = obj.get("fileName")
    if not isinstance(file_name, str) or not file_name.strip():
        errors.append(f"line {line_no}: fileName must be a non-empty string")
        continue

    normalized = file_name.strip()
    allowed_exact.add(normalized)
    allowed_basenames.add(os.path.basename(normalized))

if errors:
    print("[guardrail] ERROR: could not parse allowed files from JSONL", file=sys.stderr)
    for err in errors:
        print(f"  - {err}", file=sys.stderr)
    sys.exit(1)

if not changed:
    print("[guardrail] OK: no modified files beyond planner artifacts")
    sys.exit(0)

out_of_scope = []
for f in changed:
    base = os.path.basename(f)
    if f in allowed_exact:
        continue
    # If planner emits only filename (no path), allow basename match.
    if base in allowed_basenames:
        continue
    out_of_scope.append(f)

if out_of_scope:
    print("[guardrail] ERROR: out-of-scope file modifications detected", file=sys.stderr)
    print("[guardrail] Allowed files (from affected_files.jsonl):", file=sys.stderr)
    for f in sorted(allowed_exact):
        print(f"  - {f}", file=sys.stderr)
    print("[guardrail] Modified files outside scope:", file=sys.stderr)
    for f in sorted(out_of_scope):
        print(f"  - {f}", file=sys.stderr)
    sys.exit(1)

print(f"[guardrail] OK: all modified files are within planned scope ({len(changed)} file(s))")
PY
