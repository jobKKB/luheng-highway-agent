"""Static integration checks only; native parser/lifecycle remain separate preflight gates."""
from pathlib import Path
import hashlib
import json
import re
import unittest

ROOT = Path(__file__).resolve().parent
LIFE = (ROOT / "lifecycle/Invoke-MockChatLifecycle.ps1").read_text(encoding="utf-8")
WORKFLOW = (ROOT.parent.parent / ".github/workflows/native-mock-chat-replay.yml").read_text(encoding="utf-8")
CONTRACT = json.loads((ROOT / "admission/contract.json").read_text(encoding="utf-8-sig"))
MOCK = (ROOT / "mock/probe-mock-chat.mjs").read_text(encoding="utf-8")
ADMIT = (ROOT / "admit-mock.ps1").read_text(encoding="utf-8")

class IntegrationTests(unittest.TestCase):
    def test_same_exact_target_across_probe_and_admission(self):
        self.assertEqual(CONTRACT["installer"]["sha256"], "e510b8d17bd8145f1fcbfe5ab3e57070988b1b62f6d9c6e1f169233de1dd080f")
        self.assertIn(CONTRACT["installer"]["sha256"], MOCK)
        self.assertEqual(CONTRACT["source"]["baseVersion"], "0.7.1")
        self.assertEqual(CONTRACT["source"]["count"], 17266)

    def test_both_app_and_mock_controller_use_native_jobs(self):
        self.assertIn('$app=Start-OwnedProcess $exe "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$debugPort"', LIFE)
        self.assertIn("$mockController=Start-OwnedProcess $node $nodeArguments $state 'mock-controller'", LIFE)
        self.assertIn("Wait-OwnedProcess $mockController 360", LIFE)
        self.assertIn("$required=$result.mock_controller_closed -and $result.mocked_model_orchestration_verified", LIFE)
        self.assertNotIn("& $node ", LIFE)

    def test_child_environment_is_explicit_ordinary_allowlist(self):
        self.assertIn("$envMap = @{}", LIFE)
        self.assertNotIn("GetEnvironmentVariables(", LIFE)
        self.assertIn("$pairs=@($envMap.Keys", LIFE)
        self.assertIn("$envMap['SystemDrive'] = Resolve-InstallerSystemDrive", LIFE)
        self.assertIn("SystemDrive differs from SystemRoot drive", LIFE)
        for required in ["HOME", "USERPROFILE", "HERMES_HOME", "HERMES_DESKTOP_USER_DATA_DIR", "RUNNER_TEMP", "GITHUB_ACTIONS"]:
            self.assertIn("$envMap['"+required+"']", LIFE)
        keys=set(re.findall(r"\$envMap\['([^']+)'\]\s*=", LIFE))
        self.assertFalse(keys & {"GH_TOKEN","GITHUB_TOKEN","READ_TOKEN","NODE_OPTIONS","NODE_PATH","OPENAI_API_KEY","ANTHROPIC_API_KEY","ELECTRON_DISABLE_SANDBOX"})

    def test_synthetic_profile_disables_background_model_and_telemetry(self):
        for fragment in ["title_generation=@{enabled=$false;model_upgrade_enabled=$false}", "shared_metrics=@{enabled=$false;send_enabled=$false}", "plugins=@{enabled=@()}", "updates=@{check=$false}", "'HERMES_DISABLE_LAZY_INSTALLS'] = '1'"]:
            self.assertIn(fragment, LIFE)

    def test_ownership_and_normal_cleanup_gates_survive_mock_failure(self):
        for fragment in ["Get-OwnedDebuggerEndpoint", "exclusive_loopback_listener=$true", "native_job_member=$true",
                         "$debugAfter.process_created -ne $debugOwner.process_created",
                         "$window.CloseMainWindow()", "$owners[$app.Id].WaitForEmpty(30000)",
                         "Start-OwnedProcess $uninstaller '/currentuser /S'", "$result.synthetic_userdata_retained=$true",
                         "-not $result.forced_cleanup", "$result['native_screenshot_error']"]:
            self.assertIn(fragment, LIFE)
        executable_lines="\n".join(x for x in LIFE.splitlines() if not x.lstrip().startswith("#"))
        self.assertNotIn("--no-sandbox",executable_lines)
        self.assertNotIn("--delete-app-data",executable_lines)
        self.assertNotIn("Stop-Process",executable_lines)

    def test_exact_tree_before_launch_and_after_close(self):
        self.assertLess(LIFE.index("installed-payload-before-launch.json"), LIFE.index("$app=Start-OwnedProcess"))
        self.assertGreater(LIFE.index("installed-payload-after-exit.json"), LIFE.index("$result.normal_window_close=$window.CloseMainWindow()"))
        self.assertIn("$extra.Count -ne 2", LIFE)
        self.assertIn("Pinned NSIS package-type marker differs", LIFE)
        self.assertIn("$build.payload.sourceTreeSha256 -cne $pins.source.treeSha256", LIFE)

    def test_workflow_unique_branch_and_paths(self):
        self.assertIn("      - probe/hermes-native-package-current-20261006",WORKFLOW)
        self.assertIn("      - .github/workflows/native-mock-chat-replay.yml",WORKFLOW)
        self.assertIn("      - qa/native-mock-chat-replay/**",WORKFLOW)
        self.assertNotIn("codex/windows-release-completion",WORKFLOW)
        self.assertNotIn("workflow_dispatch",WORKFLOW)
        self.assertNotIn("- .gitattributes",WORKFLOW)
        self.assertNotIn("qa/native-installer-consumer",WORKFLOW)
        self.assertEqual(len(re.findall(r"^\s{6}- (?:qa/|\.github/)",WORKFLOW,re.M)),2)
        self.assertIn("cancel-in-progress: false",WORKFLOW)

    def test_workflow_has_no_rebuild_or_mutating_permissions(self):
        self.assertIn("  contents: read",WORKFLOW)
        self.assertIn("  actions: read",WORKFLOW)
        self.assertIn("persist-credentials: false",WORKFLOW)
        self.assertEqual(WORKFLOW.count("uses: actions/checkout@"),1)
        for action in re.findall(r"uses: ([^\s]+)",WORKFLOW):
            self.assertRegex(action,r"@[a-f0-9]{40}$")
        for forbidden in ["npm ci","npm install","setup-node","prepare_and_package","source-overlay.zip","materialize-v2-source","git push","contents: write"]:
            self.assertNotIn(forbidden,WORKFLOW)

    def test_native_preflight_precedes_download_and_always_evidence(self):
        self.assertLess(WORKFLOW.index("Parser]::ParseFile"),WORKFLOW.index("uses: actions/download-artifact@"))
        self.assertLess(WORKFLOW.index("admission/selftest_verify_mock.py"),WORKFLOW.index("Invoke-WebRequest"))
        self.assertIn("digest-mismatch: error",WORKFLOW)
        self.assertIn("if: always()",WORKFLOW)
        self.assertIn("--current-run $env:GITHUB_RUN_ID",WORKFLOW)
        self.assertIn("'lh-mock'",WORKFLOW)
        self.assertIn("Remove-Item Env:READ_TOKEN",ADMIT)

    def test_all_direct_runtime_paths_and_nested_attributes_present(self):
        for name in ["admit-mock.ps1","admission/contract.json","admission/verify_mock.py","admission/selftest_verify_mock.py",
                     "probe-onboarding.mjs","selftest-ui.mjs","mock/mock-provider.mjs","mock/probe-mock-chat.mjs",
                     "mock/verify-mock-evidence.mjs","mock/selftest.mjs","lifecycle/Invoke-MockChatLifecycle.ps1",
                     "lifecycle/LifecycleProcessOwner.cs","lifecycle/LifecycleObservation.cs",
                     "lifecycle/token-review/RestrictedTokenLauncher.cs"]:
            self.assertTrue((ROOT/name).is_file(),name)
        self.assertIn("admission/contract.json -text",(ROOT/".gitattributes").read_text())

if __name__ == "__main__":
    unittest.main(verbosity=2)
