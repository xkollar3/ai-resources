---
name: execute-maven-tests
description: Run Maven tests (all or a single class/method) while keeping the agent context small. Full output is written to a tmp file; only the build summary on success, or the actual root-cause exceptions of failing tests on failure (with Spring "ApplicationContext failure threshold" repeat-skip noise stripped), is returned.
license: MIT
metadata:
  language: java
  build-tool: maven
---

# execute-maven-tests

Use this skill whenever you need to run Maven tests in this project. It wraps
`mvn` so the agent never receives the full multi-megabyte surefire log.

## When to use

- "run the tests" / "run all tests" → all tests
- "run `FooServiceTest`" → single class
- "run `FooServiceTest#barShouldX`" → single method
- "run `FooServiceTest#methodA+methodB`" → multiple methods on same class

## How to invoke

This helper lives in a **system-wide skill directory**, not in the repository:
`~/.config/opencode/skills/execute-maven-tests/run.py`.

Run it from the project root. **Every invocation runs `mvn clean test` by
default** (a clean build before tests). Pass `--noClean` to skip the `clean`
phase when you know the previous build is still valid and want a faster
turnaround:

Pass `--noClean` sparingly at least have one clean execution on the start.

```bash
python3 ~/.config/opencode/skills/execute-maven-tests/run.py                       # mvn clean test
python3 ~/.config/opencode/skills/execute-maven-tests/run.py FooTest               # mvn clean test -Dtest=FooTest
python3 ~/.config/opencode/skills/execute-maven-tests/run.py 'FooTest#bar'         # mvn clean test -Dtest=FooTest#bar
python3 ~/.config/opencode/skills/execute-maven-tests/run.py --noClean             # mvn test
python3 ~/.config/opencode/skills/execute-maven-tests/run.py --noClean FooTest     # mvn test -Dtest=FooTest
```

`--noClean` may appear before or after the test selector.

When invoking this from the Bash tool, use a **5 minute timeout**
(`timeout: 300000`) to avoid short-run truncation while still failing fast on
hangs.

The script:

1. Streams the entire `mvn` invocation into a temp file under `/tmp` and
   prints that path so it can be inspected later if needed.
2. On `BUILD SUCCESS`: prints only the surefire summary lines
   (`Tests run: X, Failures: …`) and the `BUILD SUCCESS` line.
3. On `BUILD FAILURE`:
   - If Maven failed before the test phase, prints the last 50 lines of the log.
   - Otherwise, lists the failing test classes, then for each one prints the
     **actual** exception block from `target/surefire-reports/<FQCN>.txt`
     (falling back to the log if the report is missing).
   - Within each failing class, stack traces whose first line is
     `ApplicationContext failure threshold (N) exceeded: skipping repeated
     attempt to load context` are collapsed to a one-line placeholder so the
     real first-cause exception is visible.

## What you must NOT do

- Do not run `mvn test`, `mvn verify`, or `mvn clean test` directly through the
  Bash tool — always go through this script so the context stays small.
- Do not `cat` the full log file. If you need more detail than the script
  emitted, use `Grep` / `Read` against the printed `/tmp/maven-test-*.log`
  path to read only the section you need.
