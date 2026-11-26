"""scripts/pre-commit-restage.sh: formatter fixes to staged files are re-staged,
except for files pre-commit stashed unstaged changes from."""

import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "pre-commit-restage.sh"

# Stands in for a formatter: collapses runs of spaces in each file it is given,
# or in every *.txt file when given none (like cargo fmt --all).
FORMATTER = textwrap.dedent(
    """
    import pathlib, re, sys
    paths = sys.argv[1:] or [str(p) for p in pathlib.Path('.').glob('*.txt')]
    for p in paths:
        f = pathlib.Path(p)
        f.write_text(re.sub(' +', ' ', f.read_text()))
    """
)


def git(repo, *args, **kw):
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True, **kw
    ).stdout


class RepoFixture:
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "t@example.com")
        git(self.repo, "config", "user.name", "t")
        (self.repo / "base.txt").write_text("base\n")
        git(self.repo, "add", "base.txt")
        git(self.repo, "commit", "-qm", "base")
        self.store = self.tmp / "store"
        self.store.mkdir()
        self.formatter = self.tmp / "fmt.py"
        self.formatter.write_text(FORMATTER)

    def run_script(self, *args, files):
        env = {**os.environ, "PRE_COMMIT_HOME": str(self.store)}
        return subprocess.run(
            ["bash", str(SCRIPT), *args, "python3", str(self.formatter), "--", *files],
            cwd=self.repo,
            env=env,
            capture_output=True,
            text=True,
        )

    def stage(self, name, content):
        (self.repo / name).write_text(content)
        git(self.repo, "add", name)

    def stash_patch(self, pid, *names):
        """Write a patch the way pre-commit does, naming the parent's pid."""
        for name in names:
            (self.repo / name).write_text((self.repo / name).read_text() + "unstaged\n")
        diff = git(self.repo, "diff", "--binary", "--", *names)
        (self.store / f"patch1700000000-{pid}").write_text(diff)
        git(self.repo, "checkout", "--", *names)

    def staged(self, name):
        return git(self.repo, "show", f":{name}")


class RestageTest(RepoFixture, unittest.TestCase):
    def test_fixes_to_staged_files_are_restaged(self):
        self.stage("a.txt", "a  b\n")
        self.stage("c.txt", "c   d\n")
        result = self.run_script(files=["a.txt", "c.txt"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.staged("a.txt"), "a b\n")
        self.assertEqual(self.staged("c.txt"), "c d\n")
        self.assertEqual(git(self.repo, "diff", "--name-only"), "")

    def test_file_in_this_runs_stash_patch_is_not_restaged(self):
        self.stage("a.txt", "a  b\n")
        self.stage("c.txt", "c  d\n")
        self.stash_patch(os.getpid(), "c.txt")
        result = self.run_script(files=["a.txt", "c.txt"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.staged("a.txt"), "a b\n")
        self.assertEqual(self.staged("c.txt"), "c  d\n")
        self.assertEqual(git(self.repo, "diff", "--name-only"), "c.txt\n")

    def test_another_processes_stash_patch_is_ignored(self):
        self.stage("c.txt", "c  d\n")
        self.stash_patch(os.getpid() + 1, "c.txt")
        result = self.run_script(files=["c.txt"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.staged("c.txt"), "c d\n")

    def test_no_pass_runs_the_command_without_paths_and_restages_only_staged(self):
        self.stage("a.txt", "a  b\n")
        (self.repo / "base.txt").write_text("base  unstaged\n")
        result = self.run_script("--no-pass", files=["a.txt"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.staged("a.txt"), "a b\n")
        self.assertEqual(self.staged("base.txt"), "base\n")
        self.assertEqual((self.repo / "base.txt").read_text(), "base unstaged\n")

    def test_formatter_failure_is_returned_after_restaging(self):
        self.stage("a.txt", "a  b\n")
        self.formatter.write_text(FORMATTER + "\nsys.exit(3)\n")
        result = self.run_script(files=["a.txt"])
        self.assertEqual(result.returncode, 3)
        self.assertEqual(self.staged("a.txt"), "a b\n")


def pre_commit_cmd():
    if shutil.which("pre-commit"):
        return ["pre-commit"]
    if shutil.which("uvx"):
        return ["uvx", "pre-commit"]
    return None


@unittest.skipUnless(pre_commit_cmd(), "pre-commit is not installed")
class RealPreCommitTest(RepoFixture, unittest.TestCase):
    """Through a real `git commit`, so a pre-commit release that renames its
    stash patch fails here instead of losing unstaged edits."""

    def setUp(self):
        super().setUp()
        config = textwrap.dedent(
            f"""
            repos:
              - repo: local
                hooks:
                  - id: fmt
                    name: fmt
                    entry: bash {SCRIPT} python3 {self.formatter} --
                    language: system
                    files: \\.txt$
            """
        )
        (self.repo / ".pre-commit-config.yaml").write_text(config)
        git(self.repo, "add", ".pre-commit-config.yaml")
        git(self.repo, "commit", "-qm", "config")
        env = {**os.environ, "PRE_COMMIT_HOME": str(self.store)}
        subprocess.run(
            [*pre_commit_cmd(), "install"], cwd=self.repo, env=env, check=True, capture_output=True
        )
        self.env = env

    def commit(self):
        return subprocess.run(
            ["git", "commit", "-qm", "change"], cwd=self.repo, env=self.env, capture_output=True, text=True
        )

    def test_commit_lands_formatted(self):
        self.stage("a.txt", "a  b\n")
        result = self.commit()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(git(self.repo, "show", "HEAD:a.txt"), "a b\n")

    def test_partially_staged_file_fails_and_keeps_its_unstaged_edit(self):
        self.stage("a.txt", "a  b\n")
        (self.repo / "a.txt").write_text("a  b\nunstaged\n")
        result = self.commit()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("unexpected error", result.stdout + result.stderr)
        self.assertEqual(git(self.repo, "rev-list", "--count", "HEAD"), "2\n")
        self.assertEqual(self.staged("a.txt"), "a  b\n")
        self.assertEqual((self.repo / "a.txt").read_text(), "a  b\nunstaged\n")


if __name__ == "__main__":
    unittest.main()
