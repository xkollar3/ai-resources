#!/usr/bin/env python3
"""Run Maven tests and produce a context-friendly summary.

Usage:
    run.py                              # mvn clean test
    run.py ClassName                    # mvn clean test -Dtest=ClassName
    run.py ClassName#method             # mvn clean test -Dtest=ClassName#method
    run.py 'ClassName#a+b'              # multiple methods
    run.py --noClean                    # mvn test (skip clean)
    run.py --noClean ClassName#method   # mvn test -Dtest=...

`--noClean` may be placed before or after the test selector.

Full mvn output is written to /tmp/maven-test-XXXXXX.log. Only a minimal
excerpt is printed to stdout:
  - On success:  the surefire summary line(s) and the BUILD SUCCESS line.
  - On failure:  per failing test class, the actual root-cause exception
                 taken from target/surefire-reports/<FQCN>.txt (falling back
                 to the inline maven log). Spring "ApplicationContext failure
                 threshold (N) exceeded" repeat-skip stack traces are
                 collapsed so the first real cause is visible.
"""
from __future__ import annotations

import glob
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

THRESHOLD_MARKER = "ApplicationContext failure threshold"
METHOD_HEADER_RE = re.compile(r"^\S.*\s--\sTime elapsed:.*<<<\s(ERROR|FAILURE)!")
SECTION_SEP_RE = re.compile(r"^-{5,}$")


def main() -> int:
    clean = True
    test_arg: str | None = None
    for raw in sys.argv[1:]:
        if raw in ("--noClean", "--no-clean"):
            clean = False
        elif raw.startswith("-"):
            print(f"Unknown flag: {raw}", file=sys.stderr)
            return 2
        elif test_arg is None:
            test_arg = raw
        else:
            print(f"Unexpected extra argument: {raw}", file=sys.stderr)
            return 2

    fd, log_path = tempfile.mkstemp(prefix="maven-test-", suffix=".log")
    os.close(fd)

    cmd = ["mvn"]
    if clean:
        cmd.append("clean")
    cmd.append("test")
    if test_arg:
        cmd.append(f"-Dtest={test_arg}")

    print(f"Running: {' '.join(cmd)}")
    print(f"Full log: {log_path}")
    print(flush=True)

    with open(log_path, "w") as out:
        proc = subprocess.run(cmd, stdout=out, stderr=subprocess.STDOUT)

    log = Path(log_path).read_text(errors="replace")
    lines = log.splitlines()

    build_line = next(
        (l for l in reversed(lines) if "BUILD SUCCESS" in l or "BUILD FAILURE" in l),
        "",
    )

    if proc.returncode == 0:
        emit_success(lines, build_line, log_path)
        return 0

    print("=== BUILD FAILURE ===")
    if build_line:
        print(build_line)
    print()

    reached_tests = any(
        "T E S T S" in l or l.startswith("[INFO] Results:") for l in lines
    )
    if not reached_tests:
        print("Maven did not reach the test phase. Last 50 lines:")
        print("-" * 60)
        print("\n".join(lines[-50:]))
        print("-" * 60)
        print(f"Full log: {log_path}")
        return proc.returncode

    failing = find_failing_classes(lines, log)

    if not failing:
        print("Build failed but no specific failing test class was identified.")
        print("Last 80 lines of log:")
        print("-" * 60)
        print("\n".join(lines[-80:]))
        print("-" * 60)
        print(f"Full log: {log_path}")
        return proc.returncode

    print(f"Failing test classes ({len(failing)}):")
    for cls in failing:
        print(f"  - {cls}")
    print()

    for cls in failing:
        body = load_failure_body(cls, log)
        print("=" * 70)
        print(f"FAILED: {cls}")
        print("=" * 70)
        if body:
            print(collapse_threshold_blocks(body).rstrip())
        else:
            print("(no detailed output found in surefire reports or log)")
        print()

    print(f"Full log preserved at: {log_path}")
    return proc.returncode


def emit_success(lines: list[str], build_line: str, log_path: str) -> None:
    print("=== BUILD SUCCESS ===")
    summary = [
        l for l in lines
        if l.startswith("[INFO] Tests run:") and "Failures" in l
    ]
    if summary:
        # The aggregate from `[INFO] Results:` is the most useful one; it
        # appears last in the log.
        for l in summary[-3:]:
            print(l)
    if build_line:
        print()
        print(build_line)
    print(f"\nFull log preserved at: {log_path}")


def find_failing_classes(lines: list[str], log: str) -> list[str]:
    """Return a de-duplicated list of fully qualified class names that failed."""
    fqcns: list[str] = []

    # Primary source: inline `<<< FAILURE! -- in <FQCN>` / `<<< ERROR! -- in <FQCN>`
    # surefire markers. These always carry the fully qualified class name and
    # appear once per failing test class.
    fqcns.extend(re.findall(r"<<<\s+(?:FAILURE|ERROR)!\s+--\s+in\s+([\w.$]+)", log))

    # Fallback: the final `[ERROR] Failures:` / `[ERROR] Errors:` summary block.
    # Some surefire configurations only emit short class names here; we still
    # collect anything FQCN-shaped (contains a `.` in the class portion).
    if not fqcns:
        in_block = False
        for line in lines:
            if re.match(r"^\[ERROR\]\s+(Failures|Errors):\s*$", line):
                in_block = True
                continue
            if in_block:
                if not line.startswith("[ERROR]"):
                    in_block = False
                    continue
                m = re.match(r"^\[ERROR\]\s+([\w.$]+)\.([\w$]+)[\s(:]", line)
                if m and "." in m.group(1):
                    fqcns.append(m.group(1))

    # De-dupe preserving order
    seen: set[str] = set()
    out: list[str] = []
    for f in fqcns:
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


def load_failure_body(fqcn: str, log: str) -> str | None:
    """Return the failure detail for a class: prefer surefire .txt report."""
    candidates: list[str] = []
    candidates.extend(glob.glob(f"target/surefire-reports/{fqcn}.txt"))
    candidates.extend(glob.glob(f"**/target/surefire-reports/{fqcn}.txt", recursive=True))
    # Some surefire runs use the short name; tolerate that too.
    short = fqcn.rsplit(".", 1)[-1]
    candidates.extend(glob.glob(f"target/surefire-reports/*{short}.txt"))

    for c in candidates:
        p = Path(c)
        if p.is_file():
            text = p.read_text(errors="replace")
            # If the report only shows the all-passing summary somehow,
            # ignore it and fall back to the log scan.
            if "<<<" in text:
                return text

    return extract_class_block_from_log(log, fqcn)


def extract_class_block_from_log(log: str, fqcn: str) -> str | None:
    """Find the failure section for `fqcn` inside the raw maven log.

    Returns the slice that starts with the surefire failure header
    (`[ERROR] Tests run: ... <<< FAILURE! -- in <FQCN>`) and ends at the
    next `[INFO] Running ` or `[INFO] Results:` boundary. Everything before
    that header (Spring Boot / Testcontainers startup noise) is dropped to
    keep the output context-friendly.

    Falls back to the full `[INFO] Running <FQCN>` block if no inline
    failure header is present for that class.
    """
    short = re.escape(fqcn.rsplit(".", 1)[-1])
    fqcn_esc = re.escape(fqcn)

    # Find the [INFO] Running <FQCN> anchor so we know which section we're in.
    running_re = re.compile(
        rf"\[INFO\] Running (?:\S*\.)?{short}\b", re.MULTILINE
    )
    running = running_re.search(log)
    if not running:
        return None

    section_end_re = re.compile(
        r"\n\[INFO\] Running |\n\[INFO\] Results:", re.MULTILINE
    )
    end_match = section_end_re.search(log, running.end())
    end_idx = end_match.start() if end_match else len(log)

    # Prefer the failure header inside this section.
    failure_re = re.compile(
        rf"\[ERROR\] Tests run:.*?<<<\s+(?:FAILURE|ERROR)!\s+--\s+in\s+{fqcn_esc}\b",
        re.MULTILINE,
    )
    fail_match = failure_re.search(log, running.start(), end_idx)
    if fail_match:
        return log[fail_match.start():end_idx]

    # No inline failure header (rare): fall back to the whole section.
    return log[running.start():end_idx]


def collapse_threshold_blocks(text: str) -> str:
    """Replace per-method `ApplicationContext failure threshold` stack traces with a one-liner.

    Surefire writes one error block per failing test method. When a Spring
    context fails to load, only the FIRST method has the real exception;
    subsequent methods just say "ApplicationContext failure threshold (N)
    exceeded: skipping repeated attempt to load context". Those are noise -
    collapse them so the real first-cause exception is easy to find.
    """
    lines = text.splitlines()
    out: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if METHOD_HEADER_RE.match(line):
            # Peek at the body to decide if this is a threshold-repeat block
            j = i + 1
            while j < n and not lines[j].strip():
                j += 1
            if j < n and THRESHOLD_MARKER in lines[j]:
                # Find the end of this block: next method header or section
                # separator or blank-line-followed-by-non-trace boundary.
                k = j + 1
                while k < n:
                    if METHOD_HEADER_RE.match(lines[k]) or SECTION_SEP_RE.match(lines[k]):
                        break
                    k += 1
                out.append(line)
                out.append(
                    f"    (suppressed: {THRESHOLD_MARKER} repeat-skip - "
                    f"see first failing method above for the real cause)"
                )
                out.append("")
                i = k
                continue
        out.append(line)
        i += 1
    return "\n".join(out)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
