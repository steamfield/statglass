"""Exercise hook decisions, never execute submitted commands or send signals."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


class HookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="statglass-hook-tests-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.hooks = self.root / ".claude/hooks"
        shutil.copytree(ROOT / ".claude/hooks", self.hooks)
        # Git hooks export repository paths; fixtures must never inherit them.
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        self.env["CLAUDE_CODE_SESSION_ID"] = "hook-test"
        subprocess.run(["git", "init", "-q", str(self.root)], env=self.env, check=True)
        self.env["TMPDIR"] = str(self.root)
        self.marker = Path("/tmp/.wt-anchored-" + str(self.root).replace("/", "-") + "-hook-test")
        self.addCleanup(self.marker.unlink, missing_ok=True)

    def hook(self, name, payload=None, **env):
        return subprocess.run(
            ["bash", str(self.hooks / name)], input=json.dumps(payload or {}),
            text=True, capture_output=True, cwd=self.root,
            env=dict(self.env, **env), check=True,
        )

    def decision(self, hook, command):
        result = self.hook(hook, {"tool_name": "Bash", "tool_input": {"command": command}})
        return json.loads(result.stdout or "{}").get("hookSpecificOutput", {})

    def test_destructive_git_options_are_denied_and_never_approved(self):
        for command in [
            "git -C /tmp/example reset --hard",
            "git -c core.foo=bar clean -fd",
            "git --git-dir=/tmp/example push -f",
            "git --work-tree='/tmp/with space' --no-pager checkout .",
            "git -P -C '/tmp/with space' restore .",
            "env RUST_LOG=debug timeout 120 git -C /tmp/example stash clear",
            "bash -c 'git -C /tmp/example reset --hard'",
            "git -C/tmp/example -ccore.foo=bar reset --hard",
            "xargs -0 -I '{}' git --no-pager --git-dir=/tmp/example clean -fd",
            "git --literal-pathspecs reset --hard", "git --exec-path=/x reset --hard",
            "git --no-replace-objects reset --hard", "git --no-advice clean -fd",
            "git push origin main --force", "git push origin +main", "git -C /tmp/example push -u origin -f",
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.decision("pre-bash.sh", command).get("permissionDecision"), "deny")
                self.assertNotEqual(self.decision("auto-approve.sh", command).get("permissionDecision"), "allow")

    def test_development_commands_and_wrappers_stay_autonomous(self):
        commands = [
            "git status", "git -C '/tmp/with space' diff", "git push --force-with-lease",
            "bun install", "cargo test", "make check", "node -e 'console.log(1)'",
            "bash -c 'bun run test'", "sh -c 'bun run test'", "python3 -c 'print(1)'",
            "env RUST_LOG=debug cargo test", "env -u NODE_OPTIONS bun run test",
            "env --chdir='/tmp/with space' bun run test", "timeout -k 5 120 bun run test",
            "time -p cargo check", "nohup bun run test", "command -- git status",
            "xargs -0 -n 1 -P 2 git status", "xargs -I '{}' bun run test '{}'",
            "env A='two words' timeout --signal=TERM 120 command bun run test",
            "env -S 'bun run test'", "env --split-string='bun run test'",
            "xargs --max-args=1 --max-procs 2 bun run test",
            "timeout 30 rm -f /tmp/statglass-build.json", "env", "env A=1", "time", "xargs -0",
        ]
        for command in commands:
            with self.subTest(command=command):
                self.assertEqual(self.decision("auto-approve.sh", command).get("permissionDecision"), "allow")

    def test_wrappers_classify_inner_command(self):
        result = self.decision("auto-approve.sh", "env python3 -c 'print(1)'")
        self.assertEqual(result.get("permissionDecision"), "allow")
        self.assertNotIn("Read-only", result.get("permissionDecisionReason", ""))
        for command in ["env unknown-tool", "timeout 3 unknown-tool", "command unknown-tool", "xargs unknown-tool"]:
            with self.subTest(command=command):
                self.assertNotEqual(self.decision("auto-approve.sh", command).get("permissionDecision"), "allow")

    def test_rm_with_dangerous_target_prompts_bare_or_wrapped(self):
        for command in [
            "rm -rf $HOME", 'rm -rf "$HOME"', "rm -rf ~/x", "rm -rf /Users/example/Projects", "rm -rf ..",
            "timeout 30 rm -rf $HOME", "timeout 30 rm -rf ~/Projects", "env rm -rf $HOME",
            "nohup rm -rf ~/x", "command rm -rf ~/x", "env -S 'rm -rf ~'", "env --split-string='rm -rf ~/x'",
            "bash -c 'rm -rf ${TARGET}'", "xargs rm -rf /Users/example",
        ]:
            with self.subTest(command=command):
                self.assertNotEqual(self.decision("auto-approve.sh", command).get("permissionDecision"), "allow")
        for command in [
            "rm -rf build dist", "rm -f src/stale.ts", "rm -rf /tmp/statglass-x", "rm -rf /private/tmp/statglass-x",
            "bash -c 'rm -rf build dist'", "timeout 30 rm -f /tmp/statglass-build.json", "git push origin main",
            "git push --force-with-lease origin feature", "git --no-pager log -1",
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.decision("auto-approve.sh", command).get("permissionDecision"), "allow")

    def test_existing_denials_and_inert_rm_arguments(self):
        for command in ["rm -rf /", "env A=1 rm -rf ~", "timeout 2 git reset --hard", "git clean -fd", "bun publish"]:
            with self.subTest(command=command):
                self.assertEqual(self.decision("pre-bash.sh", command).get("permissionDecision"), "deny")
        for command in ["grep 'rm -rf ~' README.md", "git log --grep='rm -rf /'", "find scripts -name '*.pyc' -delete"]:
            with self.subTest(command=command):
                self.assertEqual(self.decision("auto-approve.sh", command).get("permissionDecision"), "allow")

    def test_reaping_is_checkout_scoped_and_leaves_active_or_intentional_work(self):
        sibling = self.root / "sibling"
        fixture = self.root / "ps.txt"
        fixture.write_text(f"""91001 1 05:00 node {self.root}/node_modules/vitest/vitest.mjs
91002 1 05:00 node {sibling}/node_modules/vitest/vitest.mjs
91003 1 00:30 node {self.root}/node_modules/vitest/vitest.mjs
91004 1 05:00 node {self.root}/node_modules/vite/bin/vite.js dev
91005 91006 05:00 node {self.root}/node_modules/vitest/vitest.mjs
91006 1 05:00 tmux
91007 1 05:00 node {self.root}-other/node_modules/vitest/vitest.mjs
91008 1 05:00 bun {self.root}/scripts/check.js
91009 91008 05:00 node {self.root}/node_modules/vitest/vitest.mjs
91010 1 05:00 bun {self.root}/scripts/check.js
91011 91010 05:00 node {self.root}/node_modules/vitest/vitest.mjs
91012 91010 05:00 node {sibling}/node_modules/vitest/vitest.mjs
""")
        result = self.hook("reap-orphans.sh", REAP_ORPHANS_PS_FILE=str(fixture),
                           REAP_ORPHANS_ROOTS=f"{self.root}\n{sibling}",
                           REAP_ORPHANS_SELF="92001", REAP_ORPHANS_DRY_RUN="1")
        self.assertIn("would reap", result.stderr)
        self.assertIn("91001", result.stderr)
        self.assertIn("left sibling", result.stderr)
        self.assertIn("91002", result.stderr)
        self.assertIn("91008", result.stderr)
        self.assertIn("left sibling-worktree orphan alone: 91010", result.stderr)
        own_line = next(line for line in result.stderr.splitlines() if "would reap" in line)
        self.assertNotIn("91002", own_line)
        self.assertNotIn("91010", own_line)
        for pid in ["91003", "91004", "91005", "91006", "91007"]:
            self.assertNotIn(pid, result.stderr)

    def test_reaping_checks_each_checkout_occurrence_in_one_command(self):
        parent = self.root.parent
        nested = self.root / "nested-worktree"
        tool = f"{self.root}/node_modules/vitest/vitest.mjs"
        fixture = self.root / "mixed-paths-ps.txt"
        fixture.write_text(f"""91101 1 05:00 node {tool}
91102 1 05:00 node {tool} --config {parent}/sibling-config.ts
91103 1 05:00 node {parent}/node_modules/vitest/vitest.mjs --config {self.root}/config.ts
91104 1 05:00 node {nested}/node_modules/vitest/vitest.mjs
91105 1 05:00 node {tool} --config {nested}/config.ts
""")
        result = self.hook("reap-orphans.sh", REAP_ORPHANS_PS_FILE=str(fixture),
                           REAP_ORPHANS_ROOTS=f"{parent}\n{self.root}\n{nested}",
                           REAP_ORPHANS_SELF="92001", REAP_ORPHANS_DRY_RUN="1")
        own_line = next(line for line in result.stderr.splitlines() if "would reap" in line)
        self.assertIn("91101", own_line, "an enclosing checkout prefix is not a separate path")
        for pid in ["91102", "91103", "91104", "91105"]:
            with self.subTest(pid=pid):
                self.assertIn(f"left sibling-worktree orphan alone: {pid}", result.stderr)
                self.assertNotIn(pid, own_line)

    def write_decision(self, hook, path, text="export const value = 1;\n", tool="Write"):
        tool_input = {"file_path": path}
        if tool == "Edit":
            tool_input.update(old_string="x", new_string=text)
        else:
            tool_input["content"] = text
        result = self.hook(hook, {"tool_name": tool, "tool_input": tool_input})
        return json.loads(result.stdout or "{}").get("hookSpecificOutput", {}).get("permissionDecision")

    def test_shared_core_rejects_framework_and_platform_imports(self):
        core = str(self.root / "packages/core/src/x.ts")
        for text in [
            'import { useState } from "react";',
            "import { View } from 'react-native';",
            'import Svg from "react-native-svg";',
            'import { CameraView } from "expo-camera";',
            'import { invoke } from "@tauri-apps/api/core";',
            'import type { GifTheme } from "@steamfield/ui/gif";',
            'import { commands } from "@desktop/commands";',
            'import { cn } from "~/lib/utils";',
        ]:
            with self.subTest(text=text):
                self.assertEqual(self.write_decision("enforce-boundaries.sh", core, text), "deny")
        self.assertEqual(self.write_decision(
            "enforce-boundaries.sh", core, 'import { useState } from "react";', tool="Edit"), "deny")
        for path, text in [
            (core, 'import { formatBytes } from "@core/format";\nimport { reactive } from "reactivity";'),
            (core, 'import type { LiveMsg } from "@core/generated/types";\nexport const expose = 1;'),
            ("packages/core/src/format.ts", 'import { hierarchy } from "d3-hierarchy";'),
        ]:
            with self.subTest(path=path, text=text):
                self.assertIsNone(self.write_decision("enforce-boundaries.sh", path, text))

    def test_mobile_app_rejects_desktop_imports_and_leaving_the_app(self):
        screen = str(self.root / "apps/mobile/src/app/x.tsx")
        for text in [
            'import { createRoot } from "react-dom/client";',
            'import { listen } from "@tauri-apps/api/event";',
            'import { createAppTransport } from "@desktop/app-transport";',
            'import { Card } from "~/widgets/card";',
            'import { CpuCard } from "../../../../src/app/widgets/cpu-card";',
            'import { formatBytes } from "../../../../packages/core/src/format";',
        ]:
            with self.subTest(text=text):
                self.assertEqual(self.write_decision("enforce-boundaries.sh", screen, text), "deny")
        allowed = ('import { View } from "react-native";\nimport { formatBytes } from "@core/format";\n'
                   'import { Providers } from "../../lib/providers";\nimport { theme } from "../theme";')
        for path in [screen, "apps/mobile/src/app/x.tsx"]:
            with self.subTest(path=path):
                self.assertIsNone(self.write_decision("enforce-boundaries.sh", path, allowed))
        config = str(self.root / "apps/mobile/app.config.ts")
        self.assertEqual(self.write_decision("enforce-boundaries.sh", config, 'import x from "../../package.json";'), "deny")
        self.assertIsNone(self.write_decision("enforce-boundaries.sh", config, 'import type { ExpoConfig } from "expo/config";'))

    def test_desktop_widgets_and_app_reject_adapter_and_native_imports(self):
        widget = str(self.root / "src/app/widgets/x.tsx")
        self.assertEqual(self.write_decision(
            "enforce-boundaries.sh", widget, 'import { commands } from "@desktop/commands";'), "deny")
        route = str(self.root / "src/app/routes/popover/x.tsx")
        for path, text in [
            (route, 'import { View } from "react-native";'),
            (route, 'import Svg from "react-native-svg";'),
            (str(self.root / "src/desktop-transport/native.ts"), 'import { CameraView } from "expo-camera";'),
            (str(self.root / "src/main.tsx"), 'import { registerRootComponent } from "expo";'),
        ]:
            with self.subTest(path=path, text=text):
                self.assertEqual(self.write_decision("enforce-boundaries.sh", path, text), "deny")
        allowed = ('import { createRoot } from "react-dom/client";\nimport { formatBytes } from "@core/format";\n'
                   'import { commands } from "@desktop/commands";\nimport { exponent } from "./exponent";')
        for path in [route, str(self.root / "src/main.tsx")]:
            with self.subTest(path=path):
                self.assertIsNone(self.write_decision("enforce-boundaries.sh", path, allowed))
        self.assertIsNone(self.write_decision(
            "enforce-boundaries.sh", str(self.root / "apps/mobile/src/app/x.tsx"), 'import { View } from "react-native";'))

    def test_generated_bindings_are_blocked_for_edits_and_shell_writes(self):
        for path in [
            str(self.root / "packages/core/src/generated/types.ts"),
            "packages/core/src/generated/tray-rates.json",
            str(self.root / "src/desktop-transport/commands.ts"),
            "src/desktop-transport/commands.ts",
            str(self.root / "apps/mobile/src/theme.generated.css"),
            "apps/mobile/src/theme.generated.ts",
        ]:
            with self.subTest(path=path):
                self.assertEqual(self.write_decision("block-generated-edits.sh", path), "deny")
                self.assertEqual(self.write_decision("block-generated-edits.sh", path, tool="Edit"), "deny")
        for path in [
            str(self.root / "src/desktop-transport/native.ts"),
            str(self.root / "src/desktop-transport/commands.test.ts"),
            str(self.root / "packages/core/src/format.ts"),
            str(self.root / "apps/mobile/src/app/index.tsx"),
        ]:
            with self.subTest(path=path):
                self.assertIsNone(self.write_decision("block-generated-edits.sh", path))
        for command in [
            "cp /tmp/commands.ts src/desktop-transport/commands.ts",
            "echo x > packages/core/src/generated/types.ts",
            "sed -i '' 's/a/b/' src/desktop-transport/commands.ts",
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.decision("pre-bash.sh", command).get("permissionDecision"), "deny")
        for command in ["make bindings", "cat src/desktop-transport/commands.ts",
                        "cp /tmp/native.ts src/desktop-transport/native.ts"]:
            with self.subTest(command=command):
                self.assertNotEqual(self.decision("pre-bash.sh", command).get("permissionDecision"), "deny")

    def test_stop_formats_only_files_written_by_that_session(self):
        source = self.root / "src"
        source.mkdir()
        for name in ["mine.ts", "other.ts", "preexisting.ts"]:
            (source / name).write_text("export const value = 1;\n")
        subprocess.run(["git", "add", "src/preexisting.ts"], cwd=self.root, env=self.env, check=True)
        (source / "preexisting.ts").write_text("export const value=2;\n")
        binary = self.root / "bin"
        binary.mkdir()
        log = self.root / "formatter.log"
        stub = binary / "bunx"
        stub.write_text('#!/bin/bash\nprintf "%s\\n" "$@" >> "$FORMATTER_LOG"\n')
        stub.chmod(0o755)
        self.env.update(PATH=f"{binary}:{self.env['PATH']}", FORMATTER_LOG=str(log))
        for session, name in [("one", "mine.ts"), ("two", "other.ts")]:
            self.hook("lint-on-write.sh", {"tool_name": "Write", "session_id": session,
                      "tool_input": {"file_path": str(source / name)}})
        log.write_text("")
        self.hook("format-changed.sh", {"session_id": "one"})
        output = log.read_text()
        self.assertIn("mine.ts", output)
        self.assertNotIn("other.ts", output)
        self.assertNotIn("preexisting.ts", output)
        log.write_text("")
        self.hook("format-changed.sh", {})
        self.assertEqual(log.read_text(), "")


class HookEnvironmentTests(unittest.TestCase):
    def test_fixture_does_not_reinitialize_the_hook_callers_repository(self):
        clean = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        with tempfile.TemporaryDirectory(prefix="statglass-hook-caller-") as directory:
            caller = Path(directory)
            subprocess.run(["git", "init", "-q", directory], env=clean, check=True)
            config = caller / ".git/config"
            before = config.read_bytes()
            with patch.dict(os.environ, {
                "GIT_DIR": str(caller / ".git"),
                "GIT_INDEX_FILE": str(caller / ".git/index"),
            }):
                result = unittest.TestResult()
                HookTests("test_stop_formats_only_files_written_by_that_session").run(result)
            self.assertEqual(config.read_bytes(), before, "fixture changed its caller's Git config")
            self.assertFalse((caller / ".git/index").exists(), "fixture staged into its caller")
            self.assertTrue(result.wasSuccessful(), result.errors + result.failures)


if __name__ == "__main__":
    unittest.main()
