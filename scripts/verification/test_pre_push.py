"""Run the gate wrapper with real Git and Make in disposable checkouts."""

import os
import shutil
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "pre-push-check.sh"


class PrePushTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="statglass verification ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        # A real pre-push exports GIT_DIR and the pushed range; inherited, they would
        # point the fixture at the real repository.
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(("GIT_", "PRE_COMMIT_")) and k != "STATGLASS_PERF"}
        subprocess.run(["git", "init", "-q"], cwd=self.root, env=self.env, check=True)
        (self.root / ".gitignore").write_text("target/\n")
        self.write_makefile()
        subprocess.run(["git", "add", "."], cwd=self.root, env=self.env, check=True)
        self.commit("fixture")

    def commit(self, message):
        subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test",
             "-c", "user.email=test@example.com", "commit", "-qm", message],
            cwd=self.root, env=self.env, check=True,
        )
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=self.root, env=self.env, text=True,
        ).strip()

    def write_makefile(self, fail=False):
        (self.root / "Makefile").write_text(
            "check:\n\t@echo checked\n\t@echo diagnostic >&2\n"
            "bindings-check:\n\t@echo bindings\n"
            + ("\t@exit 17\n" if fail else "")
            + "rust-perf:\n\t@echo engine budgets\n"
            + "e2e-perf:\n\t@echo performance\n"
        )

    def push_changing(self, *paths):
        """The range pre-commit exports for a push of one commit touching `paths`."""
        base = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=self.root, env=self.env, text=True,
        ).strip()
        for path in paths:
            file = self.root / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("changed\n")
            subprocess.run(["git", "add", path], cwd=self.root, env=self.env, check=True)
        head = self.commit("change")
        return {"PRE_COMMIT_FROM_REF": base, "PRE_COMMIT_TO_REF": head}

    def run_gate(self, **env):
        nested = self.root / "nested"
        nested.mkdir(exist_ok=True)
        shutil.rmtree(self.root / "target/qa/pre-push", ignore_errors=True)
        result = subprocess.run(
            ["bash", str(SCRIPT)], cwd=nested, env={**self.env, **env},
            capture_output=True, text=True, timeout=20,
        )
        runs = list((self.root / "target/qa/pre-push").iterdir())
        self.assertEqual(len(runs), 1)
        return result, runs[0]

    def test_success_retains_each_stage_output_and_revision(self):
        result, evidence = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("checked", (evidence / "check.log").read_text())
        self.assertIn("diagnostic", (evidence / "check.log").read_text())
        self.assertIn("engine budgets", (evidence / "rust-perf.log").read_text())
        self.assertIn("performance", (evidence / "e2e-perf.log").read_text())
        revision = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=self.root, env=self.env, text=True,
        )
        self.assertEqual((evidence / "revision.txt").read_text(), revision)
        self.assertEqual((evidence / "working-tree.txt").read_text(), "")
        self.assertEqual((evidence / "result.txt").read_text(), "0\n")
        self.assertEqual((evidence / "stages.tsv").read_text(),
                         "check\t0\nbindings-check\t0\nrust-perf\t0\ne2e-perf\t0\n")
        self.assertEqual((evidence / "perf-scope.txt").read_text(), "all\n")
        self.assertIn(str(evidence), result.stdout)

    def test_failure_survives_tee_and_stops_later_stages(self):
        self.write_makefile(fail=True)
        result, evidence = self.run_gate()
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("Error 17", (evidence / "bindings-check.log").read_text())
        self.assertFalse((evidence / "rust-perf.log").exists())
        self.assertFalse((evidence / "e2e-perf.log").exists())
        self.assertEqual((evidence / "result.txt").read_text(), "2\n")
        self.assertEqual((evidence / "stages.tsv").read_text(),
                         "check\t0\nbindings-check\t2\n")
        self.assertIn("Makefile", (evidence / "working-tree.txt").read_text())

    def test_output_is_inspectable_before_the_gate_finishes(self):
        with (self.root / "Makefile").open("a") as makefile:
            makefile.write("\ncheck: wait-for-test\nwait-for-test:\n"
                           "\t@echo waiting\n"
                           "\t@while [ ! -f release ]; do sleep 0.01; done\n")
        process = subprocess.Popen(
            ["bash", str(SCRIPT)], cwd=self.root, env=self.env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                logs = list(self.root.glob("target/qa/pre-push/*/check.log"))
                if logs and "waiting" in logs[0].read_text():
                    break
                time.sleep(0.01)
            else:
                self.fail("stage output was not visible while Make was running")
            evidence = logs[0].parent
            self.assertIsNone(process.poll())
            self.assertEqual((evidence / "current-stage.txt").read_text(), "check\n")
            self.assertFalse((evidence / "result.txt").exists())
        finally:
            (self.root / "release").touch()
            process.communicate(timeout=10)
        self.assertEqual(process.returncode, 0)

    def stages_for_push(self, *paths, **env):
        result, evidence = self.run_gate(**self.push_changing(*paths), **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        stages = dict(
            line.split("\t") for line in (evidence / "stages.tsv").read_text().splitlines()
        )
        for stage, status in stages.items():
            self.assertEqual((evidence / f"{stage}.log").exists(), status != "skipped", stage)
        return stages

    def test_perf_stages_run_only_for_pushes_that_can_move_their_numbers(self):
        cases = [
            # The gating paths themselves: one row per path list, plus near misses.
            (("plan/notes.md", "scripts/release.sh"), "skipped", "skipped"),
            (("crates/statglass-engine/src/lib.rs",), "0", "skipped"),
            (("crates/statglass-proto/src/lib.rs",), "0", "skipped"),
            (("Cargo.lock",), "0", "skipped"),
            (("crates/statglass-remote/src/lib.rs",), "skipped", "skipped"),
            (("src/app/routes/popover/route.tsx",), "skipped", "0"),
            (("packages/core/src/format.ts",), "skipped", "0"),
            (("bun.lock",), "skipped", "0"),
            (("apps/mobile/src/app/index.tsx",), "skipped", "skipped"),
            (("tests/e2e/motion.spec.ts",), "skipped", "skipped"),
            (("perf-budget.json",), "0", "0"),
            (("scripts/pre-push-check.sh",), "0", "0"),
        ]
        for paths, rust, e2e in cases:
            with self.subTest(paths=paths):
                stages = self.stages_for_push(*paths)
                self.assertEqual(
                    stages,
                    {"check": "0", "bindings-check": "0", "rust-perf": rust, "e2e-perf": e2e},
                )

    def test_statglass_perf_runs_both_perf_stages_for_any_push(self):
        stages = self.stages_for_push("plan/notes.md", STATGLASS_PERF="1")
        self.assertEqual(stages["rust-perf"], "0")
        self.assertEqual(stages["e2e-perf"], "0")

    def test_a_skipped_stage_says_how_to_run_it(self):
        result, evidence = self.run_gate(**self.push_changing("plan/notes.md"))
        self.assertIn("Skipping rust-perf", result.stdout)
        self.assertIn("STATGLASS_PERF=1", result.stdout)
        self.assertEqual((evidence / "perf-scope.txt").read_text(), "paths\n")
        self.assertEqual((evidence / "changed-files.txt").read_text(), "plan/notes.md\n")


if __name__ == "__main__":
    unittest.main()
