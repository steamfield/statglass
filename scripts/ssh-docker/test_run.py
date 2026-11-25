"""Exercise run.sh's setup and cleanup without starting Docker containers."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


RUN = Path(__file__).resolve().with_name("run.sh")
DOCKER = """#!/usr/bin/env python3
import os
from pathlib import Path
import signal
import sys

args = sys.argv[1:]
state = Path(os.environ["TEST_STATE"])
case = os.environ["TEST_CASE"]

if args[:2] == ["run", "--rm"]:
    (state / "build-cwd").write_text(os.getcwd())
    fixture = next(arg.removesuffix(":/fixture") for arg in args if arg.endswith(":/fixture"))
    (state / "fixture-path").write_text(fixture)
    sys.exit(41 if case == "cwd" else 0)
if args[:1] == ["build"]:
    if case == "hup":
        fixture = Path((state / "fixture-path").read_text())
        if not (fixture / "client.der").is_file():
            raise SystemExit("client key was never created")
        os.kill(os.getppid(), signal.SIGHUP)
    sys.exit(0)
if args[:2] == ["run", "--detach"]:
    name = args[args.index("--name") + 1] if "--name" in args else "unnamed"
    (state / "container").write_text(name)
    # Simulate Docker creating the container but failing before reporting the ID.
    sys.exit(42)
if args[:2] == ["rm", "-f"]:
    container = state / "container"
    if container.read_text() == args[2]:
        container.unlink()
    sys.exit(0)
raise SystemExit(f"unexpected docker invocation: {args}")
"""


class ShellHarness(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.fixtures = self.root / "fixtures"
        self.fixtures.mkdir()
        docker = self.root / "docker"
        docker.write_text(DOCKER)
        docker.chmod(0o700)

    def run_harness(self, case):
        env = dict(
            os.environ,
            PATH=f"{self.root}:{os.environ['PATH']}",
            TMPDIR=str(self.fixtures),
            TEST_STATE=str(self.root),
            TEST_CASE=case,
        )
        return subprocess.run(
            [str(RUN)], cwd=self.root, env=env, capture_output=True, timeout=10
        )

    def test_removes_a_container_created_before_docker_run_reports_its_id(self):
        result = self.run_harness("container")
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertFalse((self.root / "container").exists())
        self.assertEqual(list(self.fixtures.iterdir()), [])

    def test_hup_cleans_up_the_generated_keys(self):
        result = self.run_harness("hup")
        self.assertEqual(result.returncode, 129, result.stderr)
        self.assertFalse(Path((self.root / "fixture-path").read_text()).exists())
        self.assertEqual(list(self.fixtures.iterdir()), [])

    def test_uses_the_repo_root_when_invoked_from_another_directory(self):
        result = self.run_harness("cwd")
        self.assertEqual(result.returncode, 41, result.stderr)
        self.assertEqual(Path((self.root / "build-cwd").read_text()), RUN.parents[2])


if __name__ == "__main__":
    unittest.main()
