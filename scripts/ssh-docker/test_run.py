"""Exercise the fixture scripts with Docker and SSH faked at the CLI."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


RUN = Path(__file__).resolve().with_name("run.sh")
SERVE = RUN.with_name("serve.sh")
DOCKER = """#!/usr/bin/env python3
import os
from pathlib import Path
import shlex
import signal
import sqlite3
import subprocess
import sys

args = sys.argv[1:]
state = Path(os.environ["TEST_STATE"])
case = os.environ["TEST_CASE"]

if args[:2] == ["run", "--rm"]:
    (state / "build-cwd").write_text(os.getcwd())
    fixture = next(arg.removesuffix(":/fixture") for arg in args if arg.endswith(":/fixture"))
    (state / "fixture-path").write_text(fixture)
    if case == "cwd":
        sys.exit(41)
    builder = args[-3].replace("/fixture", shlex.quote(fixture))
    subprocess.run(["sh", "-ec", builder, "sh", args[-1]],
                   env=dict(os.environ, CARGO_TARGET_DIR=str(state)), check=True)
    sys.exit(0)
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
    sys.exit(42 if case == "container" else 0)
if args[:1] == ["port"]:
    print("127.0.0.1:44222")
    sys.exit(0)
if args[:2] == ["exec", "--detach"]:
    assert not (state / "agent-running").exists()
    runtime = state / "agent-runtime"
    subprocess.run(
        ["sh", "-ec", args[args.index("-ec") + 1], "sh",
         str(state / "agent.log"), str(runtime / "agent.pid"), "/usr/bin/true"],
        umask=0,
        check=True,
    )
    assert runtime.stat().st_mode & 0o777 == 0o700, "agent requires a private socket directory"
    (state / "agent-running").touch()
    sys.exit(0)
if args[:5] == ["exec", "--user", "statglass", (state / "container").read_text(), "sh"]:
    signals = '''
kill() {
    case "$1" in
        -TERM) rm "$TEST_STATE/agent-running" ;;
        -0) test -e "$TEST_STATE/agent-running" ;;
        *) exit 1 ;;
    esac
}
'''
    subprocess.run(["sh", "-ec", signals + args[args.index("-ec") + 1], "sh",
                    str(state / "agent-runtime" / "agent.pid")], check=True)
    sys.exit(0)
if args[:5] == ["exec", "--user", "statglass", (state / "container").read_text(), "grep"]:
    assert args[5:] == ["-q", "engine minute", "/home/statglass/.local/state/statglass-agent/fixture-agent.log"]
    assert (state / "agent-running").exists()
    if not (state / "sample-started").exists():
        (state / "sample-started").touch()
        sys.exit(1)
    (state / "ready-sample").touch()
    sys.exit(0)
if args[:1] == ["exec"]:
    assert args[1:] == [
        "--user", "statglass", (state / "container").read_text(),
        "/usr/local/bin/statglass-seed",
        "--dir", "/home/statglass/.local/state/statglass-agent", "--days", "30",
    ], args
    assert (Path((state / "fixture-path").read_text()) / "server" / "seed").is_file()
    assert not (state / "agent-running").exists()
    assert (state / "ready-sample").exists()
    (state / "seeded").touch()
    sys.exit(0)
if args[:1] == ["cp"]:
    assert (state / "seeded").exists()
    database_path = (state / "container").read_text() + ":/home/statglass/.local/state/statglass-agent/history.sqlite"
    assert args[1] == database_path, args
    with sqlite3.connect(args[2]) as database:
        for table in ("tier_10s", "tier_1m", "tier_15m"):
            database.execute(f"CREATE TABLE {table} (bucket INTEGER)")
            database.execute(f"INSERT INTO {table} VALUES (1)")
    sys.exit(0)
if args[:2] == ["rm", "-f"]:
    container = state / "container"
    if container.read_text() == args[2]:
        container.unlink()
        (state / "agent-running").unlink(missing_ok=True)
    sys.exit(0)
raise SystemExit(f"unexpected docker invocation: {args}")
"""
SSH = """#!/bin/sh
case "$*" in
    *"status --json"*) printf '%s\\n' '{"running":true,"host_id":"fixture-host"}' ;;
esac
"""
CARGO = """#!/usr/bin/env python3
from pathlib import Path
import sys

args = sys.argv[1:]
target = Path(args[args.index("--target-dir") + 1]) / "debug"
if args[:4] == ["build", "--locked", "-p", "statglass-agent"]:
    artifact = target / "statglass-agent"
elif args[:6] == ["build", "--locked", "-p", "statglass-store", "--example", "seed"]:
    artifact = target / "examples" / "seed"
else:
    raise SystemExit(f"unexpected cargo invocation: {args}")
artifact.parent.mkdir(parents=True, exist_ok=True)
artifact.touch()
"""


class ShellHarness(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.fixtures = self.root / "fixtures"
        self.fixtures.mkdir()
        for name, contents in (
            ("docker", DOCKER),
            ("ssh", SSH),
            ("sleep", "#!/bin/sh\n"),
            ("cargo", CARGO),
        ):
            command = self.root / name
            command.write_text(contents)
            command.chmod(0o700)

    def run_harness(self, case, script=RUN, *args):
        env = dict(
            os.environ,
            PATH=f"{self.root}:{os.environ['PATH']}",
            TMPDIR=str(self.fixtures),
            TEST_STATE=str(self.root),
            TEST_CASE=case,
        )
        return subprocess.run(
            [str(script), *args], cwd=self.root, env=env, capture_output=True, timeout=10
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

    def test_serve_rejects_invalid_arguments_before_starting_docker(self):
        for args in (("--stop",), ("--stop", "unrelated"), ("--seed", "extra"), ("--bogus",)):
            with self.subTest(args=args):
                result = self.run_harness("serve", SERVE, *args)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(b"usage: serve.sh", result.stderr)
                self.assertFalse((self.root / "build-cwd").exists())

    def test_serve_prints_the_connection_and_leaves_the_container_until_stop(self):
        result = self.run_harness("serve", SERVE)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(self.fixtures.iterdir()), [])
        self.assertTrue((self.root / "container").is_file())
        container = (self.root / "container").read_text()
        self.assertEqual(result.stdout.decode().splitlines(), [
            "host=127.0.0.1", "port=44222", f"container={container}",
            "agent=/usr/local/bin/statglass-agent",
        ])
        self.assertIn(f"docker exec -it --user statglass {container}".encode(), result.stderr)
        stopped = self.run_harness("serve", SERVE, "--stop", container)
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertFalse((self.root / "container").exists())

    def test_seed_stops_the_agent_seeds_as_its_user_and_restarts_it(self):
        result = self.run_harness("serve", SERVE, "--seed")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.decode().splitlines()[:3], [
            "S10 rows: 1", "M1 rows: 1", "M15 rows: 1",
        ])
        self.assertTrue((self.root / "seeded").exists())
        self.assertTrue((self.root / "agent-running").exists())
        self.assertEqual(list(self.fixtures.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
