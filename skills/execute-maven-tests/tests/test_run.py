"""Tests for the log-extraction logic in `run.py`.

These tests drive the pure-function parts of `run.py` against the real
`test_output.txt` fixture captured from a `mvn clean test` invocation in
which two tests were intentionally broken:

  - `com.usu.usaas.coreservice.shared.persistence.SortTranslatorTest`
      method `toOrderSpecifiersShouldPreserveDescDirection`
      -> AssertionFailedError ("expected: ASC but was: DESC")

  - `com.usu.usaas.coreservice.shared.web.PathVariableExistenceCheckSystemTest`
      9 methods all error because the Spring context fails to load
      (a @TestConfiguration bean throws on init); the first method gets
      the real cause, the remaining 8 get the
      "ApplicationContext failure threshold (1) exceeded" repeat-skip.

Run from any directory:
    python -m unittest discover -s ~/.config/opencode/skills/execute-maven-tests/tests
or simply:
    python ~/.config/opencode/skills/execute-maven-tests/tests/test_run.py
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL_DIR = HERE.parent
RUN_PY = SKILL_DIR / "run.py"
FIXTURE = HERE / "test_output.txt"

_spec = importlib.util.spec_from_file_location("run_under_test", RUN_PY)
run = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(run)

SORT_FQCN = "com.usu.usaas.coreservice.shared.persistence.SortTranslatorTest"
PATH_FQCN = "com.usu.usaas.coreservice.shared.web.PathVariableExistenceCheckSystemTest"
ROOT_CAUSE_MSG = "intentional break for execute-maven-tests skill log fixture"
THRESHOLD_MARKER = "ApplicationContext failure threshold"


class FixtureMixin:
    """Loads the captured maven log once for the whole test run."""

    log: str
    lines: list[str]

    @classmethod
    def setUpClass(cls) -> None:  # type: ignore[override]
        assert FIXTURE.is_file(), f"missing fixture: {FIXTURE}"
        cls.log = FIXTURE.read_text(errors="replace")
        cls.lines = cls.log.splitlines()


class TestFindFailingClasses(FixtureMixin, unittest.TestCase):
    def test_returns_both_broken_fqcns(self) -> None:
        result = run.find_failing_classes(self.lines, self.log)
        self.assertIn(SORT_FQCN, result)
        self.assertIn(PATH_FQCN, result)

    def test_returns_exactly_two_classes(self) -> None:
        result = run.find_failing_classes(self.lines, self.log)
        self.assertEqual(
            len(result),
            2,
            f"expected exactly two failing classes, got: {result}",
        )

    def test_results_are_deduplicated(self) -> None:
        result = run.find_failing_classes(self.lines, self.log)
        self.assertEqual(len(result), len(set(result)))

    def test_results_are_fqcns_not_short_names(self) -> None:
        for fqcn in run.find_failing_classes(self.lines, self.log):
            self.assertIn(".", fqcn, f"expected FQCN, got short name: {fqcn}")


class TestExtractClassBlockFromLog(FixtureMixin, unittest.TestCase):
    def test_sort_translator_block_contains_assertion_failure(self) -> None:
        block = run.extract_class_block_from_log(self.log, SORT_FQCN)
        self.assertIsNotNone(block)
        assert block is not None  # for type checker
        self.assertIn("AssertionFailedError", block)
        self.assertIn("expected: ASC", block)
        self.assertIn("but was: DESC", block)
        self.assertIn("SortTranslatorTest.java:", block)

    def test_sort_translator_block_does_not_leak_into_next_class(self) -> None:
        block = run.extract_class_block_from_log(self.log, SORT_FQCN)
        assert block is not None
        # Block must end before the next `[INFO] Running ...` line.
        self.assertNotIn(
            "[INFO] Running com.usu.usaas.coreservice.shared.persistence.PessimisticLockingRepositoryTest",
            block,
        )

    def test_path_variable_block_contains_real_root_cause(self) -> None:
        block = run.extract_class_block_from_log(self.log, PATH_FQCN)
        self.assertIsNotNone(block)
        assert block is not None
        # The actual root cause we planted must survive somewhere in the block,
        # even though it sits below several "Caused by:" frames.
        self.assertIn(ROOT_CAUSE_MSG, block)
        # And the first failing method's real exception type must be there.
        self.assertIn("Failed to load ApplicationContext", block)

    def test_path_variable_block_contains_threshold_noise_unprocessed(self) -> None:
        """Sanity check: before collapsing, the threshold-repeat lines exist."""
        block = run.extract_class_block_from_log(self.log, PATH_FQCN)
        assert block is not None
        # Without collapsing, the block contains many threshold-skip lines
        # (one per repeat-skipped method).
        self.assertGreaterEqual(block.count(THRESHOLD_MARKER), 2)

    def test_unknown_class_returns_none(self) -> None:
        self.assertIsNone(
            run.extract_class_block_from_log(self.log, "com.usu.does.not.Exist")
        )


class TestCollapseThresholdBlocks(FixtureMixin, unittest.TestCase):
    def test_collapses_repeat_skip_blocks_in_real_log(self) -> None:
        block = run.extract_class_block_from_log(self.log, PATH_FQCN)
        assert block is not None
        before = block.count(THRESHOLD_MARKER)
        collapsed = run.collapse_threshold_blocks(block)
        after_full_traces = collapsed.count(THRESHOLD_MARKER + " (")
        # The original block has the marker N+ times (in stack traces).
        # After collapsing, only the one-line placeholder mentions it.
        self.assertGreater(before, after_full_traces)
        # The placeholder appears once per suppressed method (8 of 9 methods
        # are threshold-skip repeats in this fixture).
        self.assertIn("(suppressed: " + THRESHOLD_MARKER, collapsed)
        self.assertGreaterEqual(collapsed.count("(suppressed: " + THRESHOLD_MARKER), 2)

    def test_preserves_real_root_cause_after_collapse(self) -> None:
        block = run.extract_class_block_from_log(self.log, PATH_FQCN)
        assert block is not None
        collapsed = run.collapse_threshold_blocks(block)
        self.assertIn(ROOT_CAUSE_MSG, collapsed)
        # The first failing method header must remain in the output.
        self.assertIn(
            "PathVariableExistenceCheckSystemTest.shouldReturn404WhenDashboardDoesNotExist",
            collapsed,
        )

    def test_preserves_method_headers_for_suppressed_blocks(self) -> None:
        """Even when a block's stack trace is collapsed, the method header
        line itself stays so the reader sees which methods were skipped."""
        block = run.extract_class_block_from_log(self.log, PATH_FQCN)
        assert block is not None
        collapsed = run.collapse_threshold_blocks(block)
        # All 9 method names should still appear as headers somewhere.
        method_names = [
            "shouldReturn404WhenDashboardDoesNotExist",
            "shouldReturn404WhenUserDoesNotExist",
            "shouldReturn404WhenAssignableDoesNotExistForApplication",
            "shouldReturn404WhenTenantDoesNotExist",
            "shouldReturn200WhenApplicationExists",
            "shouldReturn404WhenApplicationDoesNotExist",
            "shouldReturn400WhenApplicationIdIsNotAValidUuid",
            "shouldReturn404WhenAccountDoesNotExistForApplication",
            "shouldReturn404WhenApplicationDoesNotExistForAccountRequest",
        ]
        for name in method_names:
            self.assertIn(name, collapsed, f"method header missing: {name}")

    def test_strips_threshold_stack_frames(self) -> None:
        """The suppressed blocks must not leave behind their long stack
        traces (lines starting with `\\tat org.springframework...`)."""
        block = run.extract_class_block_from_log(self.log, PATH_FQCN)
        assert block is not None
        before = sum(
            1
            for l in block.splitlines()
            if l.startswith("\tat org.springframework.test.context.")
        )
        after = sum(
            1
            for l in run.collapse_threshold_blocks(block).splitlines()
            if l.startswith("\tat org.springframework.test.context.")
        )
        self.assertLess(
            after,
            before,
            f"expected fewer Spring trace frames after collapse, "
            f"got before={before} after={after}",
        )

    def test_is_noop_when_no_threshold_blocks(self) -> None:
        block = run.extract_class_block_from_log(self.log, SORT_FQCN)
        assert block is not None
        # The collapse is a no-op for blocks with no threshold-skip markers.
        # `splitlines()` + `"\n".join()` may drop a trailing newline, so
        # compare after stripping trailing whitespace.
        self.assertEqual(
            block.rstrip("\n"),
            run.collapse_threshold_blocks(block).rstrip("\n"),
        )


class TestEndToEndExtractionForBrokenContext(FixtureMixin, unittest.TestCase):
    """One realistic check: the final reported text for the context-load
    failure must show the real root cause and not be drowned in noise."""

    def test_collapsed_output_is_substantially_shorter(self) -> None:
        block = run.extract_class_block_from_log(self.log, PATH_FQCN)
        assert block is not None
        collapsed = run.collapse_threshold_blocks(block)
        self.assertLess(
            len(collapsed),
            len(block) * 0.6,
            "collapse should remove at least 40% of the bytes for a class "
            "where 8 of 9 methods are threshold-repeat skips",
        )

    def test_collapsed_output_root_cause_appears_before_first_suppression(self) -> None:
        block = run.extract_class_block_from_log(self.log, PATH_FQCN)
        assert block is not None
        collapsed = run.collapse_threshold_blocks(block)
        cause_idx = collapsed.find(ROOT_CAUSE_MSG)
        suppress_idx = collapsed.find("(suppressed: " + THRESHOLD_MARKER)
        self.assertGreater(cause_idx, -1)
        self.assertGreater(suppress_idx, -1)
        self.assertLess(
            cause_idx,
            suppress_idx,
            "the real root cause must be reported before any suppression "
            "placeholder so the reader sees it first",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
