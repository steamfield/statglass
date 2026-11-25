"""Probe the real Biome configuration with isolated authored-file fixtures.

Real files are important: Biome's stdin mode does not apply all path overrides in
this release. Each fixture has a unique directory, removed even after failure.
"""
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
BIOME = ROOT / "node_modules/.bin/biome"
IMPORT_RULE = "style/noRestrictedImports"
FUNCTION_RULE = "complexity/noExcessiveLinesPerFunction"
FILE_RULE = "style/noExcessiveLinesPerFile"
COMPLEXITY_RULE = "complexity/noExcessiveCognitiveComplexity"
GLOBALS_RULE = "style/noRestrictedGlobals"


class BiomeRules(unittest.TestCase):
    def lint(self, source, *, directory="packages/core/src", name="probe.ts", rule=IMPORT_RULE):
        self.assertTrue(BIOME.is_file(), "Run bun install before architecture fixtures")
        with tempfile.TemporaryDirectory(prefix="architecture-fixture-", dir=ROOT / directory) as temp:
            path = Path(temp) / name
            path.write_text(source)
            result = subprocess.run(
                [str(BIOME), "lint", f"--only={rule}", "--reporter=json", str(path)],
                cwd=ROOT, capture_output=True, text=True, check=False,
            )
            output = json.loads(result.stdout)
            self.assertEqual(output["summary"]["changed"] + output["summary"]["unchanged"], 1)
            diagnostics = output["diagnostics"]
            unexpected = [d for d in diagnostics if d["category"] != f"lint/{rule}"]
            self.assertEqual(unexpected, [], result.stdout + result.stderr)
            return result.returncode, diagnostics

    def assert_rejected(self, source, **kwargs):
        code, diagnostics = self.lint(source, **kwargs)
        self.assertNotEqual(code, 0)
        self.assertGreater(len(diagnostics), 0)

    def assert_allowed(self, source, **kwargs):
        code, diagnostics = self.lint(source, **kwargs)
        self.assertEqual((code, diagnostics), (0, []))

    def test_core_rejects_react_alias_relative_and_react_zustand(self):
        for module in ("react", "~/app", "../app/app", "../../app/app", "zustand"):
            with self.subTest(module=module):
                self.assert_rejected(f'import {{ value }} from "{module}";\n')
        self.assert_allowed('import { createStore } from "zustand/vanilla";\n')

    def test_core_rejects_platform_imports(self):
        # Core runs on the desktop and the phone: no React, React Native, Expo, Tauri,
        # desktop UI kit or desktop adapter imports, in source or tests.
        for module in ("react", "react-dom", "react-native", "react-native/Libraries/Image",
                       "expo", "expo-router", "expo-secure-store/build", "@tauri-apps/api/core",
                       "@steamfield/ui", "@steamfield/ui/gif", "@desktop/commands"):
            for name in ("probe.ts", "probe.test.ts"):
                with self.subTest(module=module, name=name):
                    self.assert_rejected(f'import {{ value }} from "{module}";\n', name=name)
        self.assert_allowed('import type { Snapshot } from "@core/generated/types";\n')

    def test_core_rejects_dom_globals_outside_tests(self):
        for source in ('export const width = window.innerWidth;\n',
                       'export const title = document.title;\n',
                       'export const online = navigator.onLine;\n'):
            with self.subTest(source=source):
                self.assert_rejected(source, rule=GLOBALS_RULE)
                self.assert_allowed(source, name="probe.test.ts", rule=GLOBALS_RULE)
        self.assert_allowed('export function width(window: { innerWidth: number }) {\n'
                            '  return window.innerWidth;\n}\n', rule=GLOBALS_RULE)

    def test_widgets_reject_transport_generated_commands_and_app_hooks(self):
        for module, symbol in (("@core/transport", "Transport"), ("@desktop/commands", "commands"),
                               ("@desktop/commands", "events"), ("~/hooks/use-transport", "useTransport"),
                               ("../hooks/use-remote-hosts", "useRemoteHosts"),
                               ("../routes/dashboard/containers/_hooks/use-docker", "useDocker"),
                               ("../../core/transport", "Transport"), ("../../desktop-transport/commands", "commands"),
                               ("../router", "router"), ("@desktop/app-transport", "createAppTransport"),
                               ("@core/mock-transport", "createMockTransport"), ("@core/mock/fixtures", "MOCK_HOST_ID")):
            with self.subTest(module=module, symbol=symbol):
                self.assert_rejected(f'import {{ {symbol} }} from "{module}";\n', directory="src/app/widgets")

    def test_app_reaches_tauri_only_through_transport(self):
        for module, symbol in (("@desktop/native", "createTauriTransport"),
                               ("@desktop/native-docker", "nativeDocker"),
                               ("@desktop/commands", "commands"), ("@desktop/commands", "events")):
            with self.subTest(module=module, symbol=symbol):
                self.assert_rejected(f'import {{ {symbol} }} from "{module}";\n', directory="src/app")
        for source in ('import type { Snapshot } from "@core/generated/types";\n',
                       'import { useTransport } from "@core/transport";\n'):
            with self.subTest(source=source):
                self.assert_allowed(source, directory="src/app")

    def test_widgets_allow_generated_types_constants_and_presentation_helpers(self):
        for source in ('import type { Snapshot } from "@core/generated/types";\n',
                       'import { HISTORY_PAGE_LIMIT } from "@core/generated/types";\n',
                       'import { cn } from "~/lib/utils";\n',
                       'import { enter } from "~/lib/motion/variants";\n',
                       'import type { LegendProps } from "../legend";\n'):
            with self.subTest(source=source):
                self.assert_allowed(source, directory="src/app/widgets")

    def test_widgets_barrel_reexports_follow_the_same_boundary(self):
        # src/app/widgets/index.ts is docs-site's entry point: re-exports of
        # sibling widgets pass, re-exports that would leak the app do not.
        self.assert_allowed('export { Legend, type LegendProps } from "../legend";\n',
                            directory="src/app/widgets", name="index.ts")
        for module, symbol in (("@core/transport", "useTransport"), ("@desktop/commands", "commands"),
                               ("~/hooks/use-transport", "useTransport"), ("@core/mock/fixtures", "MOCK_HOST_ID")):
            with self.subTest(module=module, symbol=symbol):
                self.assert_rejected(f'export {{ {symbol} }} from "{module}";\n',
                                     directory="src/app/widgets", name="index.ts")

    def test_browser_rejects_node_builtins_in_prefixed_and_bare_forms(self):
        for directory in ("packages/core/src", "src/desktop-transport", "src/app", "src/app/widgets"):
            for module in ("node:fs", "fs", "fs/promises"):
                with self.subTest(directory=directory, module=module):
                    self.assert_rejected(f'import {{ readFile }} from "{module}";\n', directory=directory)

    def test_desktop_transport_rejects_react_and_the_app_but_allows_tauri(self):
        for module in ("~/stores/foo", "react", "zustand", "../../app/router"):
            with self.subTest(module=module):
                self.assert_rejected(f'import {{ x }} from "{module}";\n', directory="src/desktop-transport")
        for source in ('import { invoke } from "@tauri-apps/api/core";\n',
                       'import type { Transport } from "@core/transport";\n'):
            with self.subTest(source=source):
                self.assert_allowed(source, directory="src/desktop-transport")

    def test_mobile_rejects_desktop_imports_and_relative_escapes(self):
        # The fixture sits one directory below src/, so "../x" already leaves
        # the fixture's directory: every cross-directory import goes through
        # @/ or @core/. modules/ shares the override but has no directory yet.
        for module in ("react-dom", "@tauri-apps/api", "~/x", "@desktop/native", "../x",
                       "../../../src/desktop-transport/x", "../../../packages/core/src/x"):
            with self.subTest(module=module):
                self.assert_rejected(f'import {{ x }} from "{module}";\n', directory="apps/mobile/src", name="probe.tsx")
        for module in ("@core/format", "@/x", "./x"):
            with self.subTest(module=module):
                self.assert_allowed(f'import {{ x }} from "{module}";\n', directory="apps/mobile/src", name="probe.tsx")

    def test_mobile_tests_reach_only_root_configs_and_scripts_relatively(self):
        for module in ("../src/lib/providers", "../../../packages/core/src/x", "~/x", "react-dom"):
            with self.subTest(module=module):
                self.assert_rejected(f'import {{ x }} from "{module}";\n', directory="apps/mobile/test")
        for module in ("../app.config", "../metro-resolve.cjs", "../scripts/theme-render.mjs",
                       "@/lib/providers", "@core/format", "./render"):
            with self.subTest(module=module):
                self.assert_allowed(f'import {{ x }} from "{module}";\n', directory="apps/mobile/test")

    def test_mobile_native_imports_belong_to_transport(self):
        for module in ("@native/statglass-native", "@native/statglass-native/src/StatglassNativeModule",
                       "@/../modules/statglass-native", "@/lock/../../modules/statglass-native"):
            with self.subTest(module=module):
                source = f'import {{ getStatglassNative }} from "{module}";\n'
                self.assert_rejected(source, directory="apps/mobile/src/lock")
        self.assert_allowed('import { getStatglassNative } from "@native/statglass-native";\n',
                            directory="apps/mobile/src/transport")
        self.assert_allowed('import { __setNativeForTests } from "@native/statglass-native";\n',
                            directory="apps/mobile/test/transport")

    def test_mobile_widgets_and_cards_are_render_only(self):
        for directory in ("apps/mobile/src/widgets", "apps/mobile/src/cards"):
            for module in ("@/data", "@/data/live", "@/transport", "@/transport/device",
                           "expo-router", "expo-router/testing-library", "@tanstack/react-query",
                           "@native/statglass-native", "../x", "react-dom"):
                with self.subTest(directory=directory, module=module):
                    self.assert_rejected(f'import {{ x }} from "{module}";\n', directory=directory)
            self.assert_allowed('import { View } from "react-native";\n'
                                'import { Text } from "@/ui/text";\n', directory=directory)
        self.assert_allowed('import { usePhoneTransport } from "@/data/transport-context";\n',
                            directory="apps/mobile/src/lock")

    def test_mobile_tests_use_the_native_seam_instead_of_jest_mock(self):
        comment = r"//[^\n]*|/\*.*?\*/"
        gap = rf"(?:\s|{comment})*"
        tokens = re.compile(
            rf'''(?P<native_mock>\bjest{gap}\.{gap}(?:mock|doMock|unstable_mockModule){gap}\({gap}'''
            r'''["'`](?:[^"'`]*/)?statglass-native(?:[/"'`]))'''
            rf'''|{comment}|(["'`])(?:\\.|(?!\2)[^\\])*\2''',
            flags=re.S,
        )
        for directory in ("apps/mobile/src", "apps/mobile/test", "apps/mobile/modules"):
            matches = [str(path.relative_to(ROOT)) for path in sorted((ROOT / directory).rglob("*"))
                       if path.suffix in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")
                       and any(token.lastgroup == "native_mock" for token in tokens.finditer(path.read_text()))]
            self.assertEqual(matches, [])

    def test_mobile_native_imports_enforced_on_writes(self):
        hook = ROOT / ".claude/hooks/enforce-boundaries.sh"
        native_import = 'import { getStatglassNative } from "@native/statglass-native";'
        for directory, source, denied in (
            ("src/lock", native_import, True),
            ("src/lock", native_import.replace('from ', 'from /* module entry point */ '), True),
            ("src/lock", native_import.replace('@native/', '@/../modules/'), True),
            ("src/lock", native_import.replace('@native/', '@/lock/../../modules/'), True),
            ("src/lock", f"// {native_import}\n/* {native_import} */", False),
            ("src/transport", native_import, False),
            ("test/transport", native_import, False),
        ):
            with self.subTest(directory=directory, source=source):
                payload = {"tool_name": "Write", "tool_input": {
                    "file_path": f"apps/mobile/{directory}/probe.ts", "content": source,
                }}
                result = subprocess.run(
                    ["bash", str(hook)], input=json.dumps(payload), cwd=ROOT,
                    capture_output=True, text=True, check=True,
                )
                decision = json.loads(result.stdout).get("hookSpecificOutput") if result.stdout else None
                self.assertEqual(decision and decision["permissionDecision"], "deny" if denied else None)

    def test_desktop_rejects_react_native_and_expo(self):
        for directory in ("src/app", "src/app/widgets", "src/desktop-transport"):
            for module in ("react-native", "react-native/Libraries/Image", "react-native-svg",
                           "expo", "expo-router", "@expo/vector-icons"):
                with self.subTest(directory=directory, module=module):
                    self.assert_rejected(f'import {{ x }} from "{module}";\n', directory=directory)

    def test_desktop_entry_point_shares_the_app_override(self):
        # src/main.tsx is one fixed file, so a fixture can't sit beside it, and
        # Biome's stdin mode skips path overrides. Check the override lists it.
        overrides = json.loads((ROOT / "biome.json").read_text())["overrides"]
        app = [o["includes"] for o in overrides if o["includes"][0] == "src/app/**"]
        self.assertEqual(app, [["src/app/**", "src/main.tsx", "!src/app/widgets/**"]])

    def test_tests_keep_node_runtime_access(self):
        for directory in ("packages/core/src", "src/app"):
            self.assert_allowed('import { readFile } from "node:fs";\n', directory=directory, name="probe.test.ts")

    @staticmethod
    def long_function(lines):
        return "export function accumulate(value: number) {\n" + "  value += 1;\n" * lines + "  return value;\n}\n"

    def test_function_limit_and_tsx_test_profile(self):
        self.assert_allowed(self.long_function(20), rule=FUNCTION_RULE)
        self.assert_rejected(self.long_function(110), rule=FUNCTION_RULE)
        for name in ("probe.tsx", "probe.test.ts"):
            self.assert_allowed(self.long_function(150), name=name, rule=FUNCTION_RULE)
            self.assert_rejected(self.long_function(210), name=name, rule=FUNCTION_RULE)

    def test_file_limit_and_test_gallery_profile(self):
        source = "\n".join(f"export const value{i} = {i};" for i in range(750))
        self.assert_rejected(source, rule=FILE_RULE)
        self.assert_allowed(source, name="probe.test.ts", rule=FILE_RULE)
        self.assert_allowed(source, directory="src/app/routes/dev/gallery", rule=FILE_RULE)
        self.assert_rejected(source + "\n" + "\n".join(f"export const extra{i} = {i};" for i in range(300)), name="probe.test.ts", rule=FILE_RULE)

    def test_cognitive_limit_is_independent_of_body_size(self):
        self.assert_allowed("export function choose(value: boolean) { return value ? 1 : 0; }", rule=COMPLEXITY_RULE)
        source = "export function choose(value: boolean) {\n" + "if (value) {\n" * 8 + "return 1;\n" + "}\n" * 8 + "return 0;\n}\n"
        self.assert_rejected(source, rule=COMPLEXITY_RULE)


if __name__ == "__main__":
    unittest.main()
