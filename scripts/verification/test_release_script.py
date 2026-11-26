"""Run `scripts/release.sh cut` with real Git against a disposable origin.

The pre-push gate takes minutes, and another session sharing the checkout can move
HEAD while it runs; the release commit is still the one pushed and tagged.
"""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "release.sh"

IDENTITY = {
    "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.com",
}

FILES = {
    "Cargo.toml": '[workspace.package]\nversion = "0.1.0"\n',
    "Cargo.lock": "# lock\n",
    "package.json": '{\n  "version": "0.1.0"\n}\n',
    "src-tauri/tauri.conf.json": '{\n  "version": "0.1.0"\n}\n',
    "scripts/release-manifest.py": "",
    "scripts/test-release-manifest.py": "",
    "RELEASE_NOTES.md": "# StatGlass 0.1.0\n",
    "CHANGELOG.md": "## [0.1.0](x) - 2026-01-01\n",
}

# Stand-ins for tools the cut calls that are not under test: cargo update, and gh,
# which reports a run URL at once so the wait loop ends.
STUBS = {
    "cargo": "#!/bin/sh\nexit 0\n",
    "gh": "#!/bin/sh\necho https://example.invalid/run\n",
}


class ReleaseCutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="statglass release ")
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.origin = root / "origin.git"
        self.work = root / "work"
        bin_dir = root / "bin"
        bin_dir.mkdir()
        for name, body in STUBS.items():
            (bin_dir / name).write_text(body)
            (bin_dir / name).chmod(0o755)
        base = {k: v for k, v in os.environ.items()
                if not k.startswith(("GIT_", "PRE_COMMIT_")) and k != "STATGLASS_PERF"}
        self.env = {**base, **IDENTITY, "PATH": f"{bin_dir}:{base['PATH']}"}

        self.git(root, "init", "-q", "--bare", "-b", "main", str(self.origin))
        self.git(root, "init", "-q", "-b", "main", str(self.work))
        self.git(self.work, "config", "core.hooksPath", ".git/hooks")
        for path, body in FILES.items():
            (self.work / path).parent.mkdir(parents=True, exist_ok=True)
            (self.work / path).write_text(body)
        shutil.copy(SCRIPT, self.work / "scripts/release.sh")
        self.git(self.work, "add", ".")
        self.git(self.work, "commit", "-qm", "base")
        self.git(self.work, "tag", "-a", "v0.1.0", "-m", "StatGlass 0.1.0")
        self.git(self.work, "remote", "add", "origin", str(self.origin))
        self.git(self.work, "push", "-q", "origin", "main", "v0.1.0")
        (self.work / "RELEASE_NOTES.md").write_text("# StatGlass 0.2.0\n")
        (self.work / "CHANGELOG.md").write_text("## [0.2.0](x) - 2026-01-02\n" + FILES["CHANGELOG.md"])

    def git(self, cwd, *args):
        return subprocess.run(
            ["git", *args], cwd=cwd, env=self.env, check=True, capture_output=True, text=True,
        ).stdout.strip()

    def install_pre_push(self, during_main_push):
        """A pre-push hook that runs `during_main_push` once, while main is pushed."""
        hook = self.work / ".git/hooks/pre-push"
        hook.write_text(textwrap.dedent(f"""\
            #!/bin/sh
            grep -q ' refs/heads/main ' || exit 0
            [ -e .git/moved ] && exit 0
            touch .git/moved
            {during_main_push}
            """))
        hook.chmod(0o755)

    def cut(self):
        result = subprocess.run(
            ["bash", "scripts/release.sh", "cut", "0.2.0"], cwd=self.work, env=self.env,
            input="y\n", capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def released(self):
        release = self.git(self.origin, "rev-parse", "main")
        self.assertEqual(self.git(self.origin, "log", "-1", "--format=%s", release),
                         "chore(release): 0.2.0")
        self.assertEqual(self.git(self.origin, "show", f"{release}:package.json"),
                         '{\n  "version": "0.2.0"\n}')
        return release

    def test_cut_pushes_and_tags_the_release_commit(self):
        self.cut()
        release = self.released()
        self.assertEqual(self.git(self.origin, "rev-parse", "v0.2.0^{commit}"), release)
        self.assertEqual(self.git(self.origin, "cat-file", "-t", "v0.2.0"), "tag")

    def test_cut_runs_the_perf_gates_on_its_main_push(self):
        self.install_pre_push('echo "${STATGLASS_PERF:-unset}" > .git/perf-env')
        self.cut()
        self.assertEqual((self.work / ".git/perf-env").read_text(), "1\n")

    def test_tag_stays_on_the_release_commit_when_another_session_switches_branch(self):
        self.install_pre_push(
            "git switch -q -c other && git commit -q --allow-empty -m other"
        )
        self.cut()
        release = self.released()
        self.assertEqual(self.git(self.origin, "rev-parse", "v0.2.0^{commit}"), release)
        self.assertEqual(self.git(self.work, "log", "-1", "--format=%s", "other"), "other")

    def test_tag_stays_on_the_release_commit_when_another_session_commits_to_main(self):
        self.install_pre_push("git commit -q --allow-empty -m later")
        self.cut()
        release = self.released()
        self.assertEqual(self.git(self.origin, "rev-parse", "v0.2.0^{commit}"), release)
        self.assertEqual(self.git(self.work, "log", "-1", "--format=%s", "main"), "later")


if __name__ == "__main__":
    unittest.main()
