"""Exercise the Stop hook under load and when process discovery stalls."""

import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).with_name("fixtures")
HOOK = Path(".claude/hooks/reap-orphans.sh")
TIMING_LINE = r"git_ms=\d+ ps_ms=\d+ awk_ms=\d+ kill_ms=\d+"


class ReapOrphansLoadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="statglass-reap-load-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.checkout = self.root / ".claude/worktrees/active"
        self.hook = self.checkout / HOOK
        self.hook.parent.mkdir(parents=True)
        shutil.copyfile(ROOT / HOOK, self.hook)
        self.listing = self.root / "ps.txt"
        self.listing.write_text(self.fixture("ps"), encoding="utf-8")
        self.timing = self.root / "timing.log"
        self.env = {
            key: value for key, value in os.environ.items()
            if key != "BASH_ENV" and not key.startswith(("GIT_", "REAP_ORPHANS_"))
        }
        self.env.update(
            REAP_ORPHANS_ROOTS=self.fixture("roots"),
            REAP_ORPHANS_SELF="99999",
            REAP_ORPHANS_DRY_RUN="1",
        )
        if sys.platform == "darwin":
            self.env["LC_ALL"] = "en_US.UTF-8"

    def fixture(self, suffix):
        return (FIXTURES / f"reap-load.{suffix}").read_text(encoding="utf-8").replace(
            "/reap-load", str(self.root)
        )

    def run_hook(self, **env):
        hook = subprocess.Popen(
            ["/bin/bash", str(self.hook)], cwd=self.checkout, env=dict(self.env, **env),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=True,
        )
        self.addCleanup(self.clean_hook, hook)
        stdout, stderr = hook.communicate("{}", timeout=10)
        self.assertEqual(hook.returncode, 0, stderr)
        self.assertEqual(stdout, "")
        return stderr

    @staticmethod
    def clean_hook(hook):
        # A broken watchdog can leave a separate process group in this session.
        processes = subprocess.check_output(["/bin/ps", "-axo", "pid=,pgid="], text=True, timeout=2)
        groups = set()
        for line in processes.splitlines():
            pid, group = map(int, line.split())
            if group in groups:
                continue
            try:
                if os.getsid(pid) == hook.pid:
                    groups.add(group)
            except (PermissionError, ProcessLookupError):
                pass
        for group in groups:
            try:
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                pass
        hook.stdin.close()
        hook.stdout.close()
        hook.stderr.close()
        hook.wait(timeout=2)

    def assert_timing_lines(self, count):
        self.assertTrue(self.timing.is_file(), "hook did not write its timing log")
        output = self.timing.read_text(encoding="utf-8")
        self.assertRegex(output, rf"\A({TIMING_LINE}\n){{{count}}}\Z")

    def test_keeps_the_original_victims_under_load(self):
        stderr = self.run_hook(REAP_ORPHANS_PS_FILE=str(self.listing))
        self.assertEqual(stderr, self.fixture("golden"))

    def test_reaps_the_launcher_and_its_descendants(self):
        launcher = subprocess.Popen(["/bin/sleep", "86400"])
        self.addCleanup(self.clean_child, launcher)
        child = subprocess.Popen(["/bin/sleep", "86400"])
        self.addCleanup(self.clean_child, child)
        self.listing.write_text(
            f"{launcher.pid} 1 05:00 bun {self.checkout}/scripts/check.js\n"
            f"{child.pid} {launcher.pid} 05:00 node {self.checkout}/node_modules/vitest/vitest.mjs\n",
            encoding="utf-8",
        )
        stderr = self.run_hook(REAP_ORPHANS_PS_FILE=str(self.listing), REAP_ORPHANS_DRY_RUN="")
        self.assertEqual(stderr, f"reap-orphans: killed orphaned dev processes: {launcher.pid} vitest\n")
        self.assertEqual(launcher.wait(timeout=2), -signal.SIGTERM)
        self.assertEqual(child.wait(timeout=2), -signal.SIGTERM)

    @staticmethod
    def clean_child(child):
        if child.poll() is None:
            child.kill()
        child.wait(timeout=2)

    @unittest.skipUnless(sys.platform == "darwin", "Darwin awk regression budget")
    def test_finishes_the_synthetic_listing_under_three_seconds(self):
        start = time.monotonic()
        self.run_hook(REAP_ORPHANS_PS_FILE=str(self.listing))
        elapsed = time.monotonic() - start
        self.assertLess(elapsed, 3, f"hook took {elapsed:.2f} s")

    def test_appends_one_timing_line_for_each_run_including_no_victims(self):
        env = dict(REAP_ORPHANS_TIMING=str(self.timing), REAP_ORPHANS_PS_FILE=str(self.listing))
        self.assertEqual(self.run_hook(**env), self.fixture("golden"))
        self.assert_timing_lines(1)
        previous = self.timing.read_text(encoding="utf-8")
        self.listing.write_text("", encoding="utf-8")
        self.assertEqual(self.run_hook(**env), "")
        self.assert_timing_lines(2)
        self.assertTrue(self.timing.read_text(encoding="utf-8").startswith(previous))

    def test_timing_destination_without_a_reader_cannot_stall_the_hook(self):
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        stub = bin_dir / "ps"
        stub.write_text('#!/bin/bash\nexec mkfifo "$REAP_ORPHANS_TIMING"\n', encoding="utf-8")
        stub.chmod(0o755)
        stderr = self.run_hook(PATH=f"{bin_dir}{os.pathsep}{os.defpath}", REAP_ORPHANS_TIMING=str(self.timing))
        self.assertEqual(stderr, "")
        self.assertTrue(self.timing.is_fifo())

    def test_times_out_a_stuck_ps_and_leaves_no_child(self):
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        pid_file = self.root / "ps.pid"
        stopped = self.root / "ps.stopped"
        stub = bin_dir / "ps"
        stub.write_text(
            '#!/bin/bash\nexec "$TEST_PYTHON" -c \'\n'
            'from pathlib import Path\nimport os, signal, sys, time\n'
            'def stop(*_):\n    Path(sys.argv[2]).touch()\n    sys.exit(0)\n'
            'signal.signal(signal.SIGTERM, stop)\n'
            'pid_file = Path(sys.argv[1])\n'
            'pid_file.write_text(str(os.getpid()))\n'
            'parent = os.getppid()\n'
            'deadline = time.monotonic() + 12\n'
            'while os.getppid() == parent and pid_file.parent.is_dir() and time.monotonic() < deadline:\n'
            '    time.sleep(0.05)\n'
            '\' "$PS_PID_FILE" "$PS_STOPPED_FILE"\n',
            encoding="utf-8",
        )
        stub.chmod(0o755)

        start = time.monotonic()
        stderr = self.run_hook(
            PATH=f"{bin_dir}{os.pathsep}{os.defpath}", PS_PID_FILE=str(pid_file),
            PS_STOPPED_FILE=str(stopped), TEST_PYTHON=sys.executable,
            REAP_ORPHANS_TIMING=str(self.timing),
        )
        elapsed = time.monotonic() - start
        self.assertGreaterEqual(elapsed, 8, f"hook returned after only {elapsed:.2f} s")
        self.assertLess(elapsed, 10, f"hook took {elapsed:.2f} s")
        self.assertEqual(stderr, "")
        self.assertTrue(pid_file.is_file(), "hook never ran the ps stub")
        pid = pid_file.read_text(encoding="utf-8").strip()
        result = subprocess.run(["/bin/ps", "-p", pid, "-o", "pid="], capture_output=True, text=True)
        self.assertEqual(result.stderr, "")
        self.assertEqual(result.stdout, "", f"ps stub {pid} survived hook exit")
        self.assertEqual(result.returncode, 1)
        self.assertTrue(stopped.is_file(), "ps did not get a chance to exit before the worker")
        self.assertEqual(self.timing.read_text(encoding="utf-8"), "status=interrupted\n")
