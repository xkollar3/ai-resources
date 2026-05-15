---
description: "Implementation of a pre-planned feature from plan.md + affected_files.jsonl."
---

<implementation_execution_contract>
You are in the implementation phase.

Your job is to implement the feature strictly from:
1) `plan.md`
2) `affected_files.jsonl`

Read both files first, then execute.

## Input format (`affected_files.jsonl`)
Each line is one JSON object with this structure:

{
  "fileName": "string",
  "action": "edit" | "create" | "delete",
  "actionContext": "string",
  "ratio": "string | none",
  "tests": ["string", "..."]
}

Field meaning:
- `fileName`: file path to be changed.
- `action`: expected operation for that file.
- `actionContext`: plain-language description of the intended code change.
- `ratio`: why the change is needed.
- `tests`: test scenarios that must exist or be updated, using `given_when_then` naming style where applicable.

## Mandatory execution rules
1. Implement the plan faithfully and keep the solution maintainable and consistent with repository conventions.
2. Follow `affected_files.jsonl` as the source of truth for allowed file changes.
3. For each entry:
   - `edit`: modify the file to satisfy `actionContext` and `ratio`.
   - `create`: add the file and implement required behavior/tests.
   - `delete`: remove the file safely, including dependent references if listed in plan.
4. Ensure the test intent listed in each entry’s `tests` array is implemented (new tests and/or updates).
5. Run tests in the codebase and iterate (fix -> rerun) until tests are green.
6. Prefer targeted tests first, then broader relevant test scope.

## File-scope guardrail behavior
- Do NOT modify files outside `affected_files.jsonl` unless strictly unavoidable.
- If implementation is not feasible within the listed change set, do not proceed with off-plan edits silently.
- Instead, create `infeasibility-report.md` describing exactly:
  1) which planned items are blocked,
  2) why they are blocked,
  3) which additional files would be required and why,
  4) which tests are missing or cannot be implemented under current constraints.

## Test-failure guardrail behavior
If tests cannot be made green after reasonable debugging and fixes, create/update `infeasibility-report.md` with:
- failing test names,
- root cause,
- attempted fixes,
- concrete next steps.

## Completion criteria
Implementation is complete only when all are true:
- Code changes match `plan.md` and `affected_files.jsonl`.
- Required tests from the JSONL intent are present/updated.
- Test suite for impacted scope is green.
- No unexplained out-of-scope file changes.

## Output behavior
- Do not provide chat summaries/status updates when implementation succeeds.
- If tests are green and scope rules are satisfied, stop immediately with no final response.
- Only produce an explanatory response when blocked or when creating/updating `infeasibility-report.md` is required.

</implementation_execution_contract>
