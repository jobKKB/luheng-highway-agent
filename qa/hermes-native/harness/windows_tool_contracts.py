"""Run narrow, credential-free functional contracts against a complete Windows package.

This is a standalone artifact-consumer, not a pytest invocation or a replacement
for scripts/run_tests.sh. It imports and dispatches real shipped runtime modules.
No Windows result can be produced on another OS.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import shutil
import site
import socket
import subprocess
import sys
import time
import traceback
import uuid


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def inside(path, parent):
    return Path(path).resolve().is_relative_to(Path(parent).resolve())


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def run_process(argv, env, cwd, timeout):
    started = time.monotonic()
    process = subprocess.Popen(argv, env=env, cwd=cwd, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, encoding="utf-8", errors="replace")
    try:
        output, _ = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        # Terminate only the timed-out process tree created by this harness.
        taskkill = str(Path(env["SystemRoot"]) / "System32" / "taskkill.exe")
        subprocess.run([taskkill, "/PID", str(process.pid), "/T", "/F"], env=env,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=30, check=False)
        output, _ = process.communicate(timeout=30)
        raise RuntimeError("Owned contract process timed out: " + repr(argv) + "\n" + output)
    return {"argv": [str(v) for v in argv], "exit_code": process.returncode,
            "elapsed_seconds": round(time.monotonic() - started, 3), "output": output}


def verify_guard(path):
    require(Path(path).is_file(), "Native Python launcher did not install the safety guard")
    events = [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines()]
    require(any(row.get("event") == "installed" for row in events), "Missing safety guard receipt")
    denied = [row for row in events if row.get("event") == "denied"]
    require(not denied, "Safety boundary was reached: " + json.dumps(denied))
    return {"installed_processes": len([r for r in events if r.get("event") == "installed"]),
            "denied_operations": len(denied)}


def cli_contract(config, command_name, arguments, label, predicate):
    root = Path(config["state_root"])
    receipt = root / "results" / (label + ".guard.jsonl")
    env = dict(os.environ)
    # The shipped launcher discards PYTHONPATH after interpreter startup. A
    # temporary sitecustomize installs only the safety audit hook before that.
    env["PYTHONPATH"] = str(root / "guard")
    env["WTC_GUARD_RECEIPT"] = str(receipt)
    result = run_process([config["commands"][command_name], *arguments], env,
                         str(root / "work"), 120)
    write_json(root / "results" / (label + ".json"), result)
    guard = verify_guard(receipt)
    require(result["exit_code"] == 0, label + " failed:\n" + result["output"])
    require(predicate(result["output"]), label + " returned unexpected output:\n" + result["output"])
    return {"name": label, "kind": "real_shipped_native_cli", "status": "passed",
            "exit_code": result["exit_code"], "guard": guard}


def worker(config_path):
    config = read_json(config_path)
    root = Path(config["state_root"])
    sys.path.insert(0, str(root / "guard"))
    from wtc_guard import install, assert_clean
    install()
    result_path = root / "results" / "tool-contracts.json"
    results = []
    try:
        # Same path precedence and .pth handling as the shipped launcher.
        sys.path.insert(0, config["repo_dir"])
        site.addsitedir(config["site_packages"])
        sys.path.remove(config["site_packages"])
        sys.path.insert(1, config["site_packages"])
        import hermes_bootstrap  # real production dependency activation
        from hermes_constants import get_hermes_home, get_default_hermes_root, get_real_home
        from pm.paths import store_root
        from tools.terminal_scope import build_profile_terminal_scope, set_terminal_scope, reset_terminal_scope
        require(Path.home().resolve() == Path(config["user_home"]).resolve(), "Path.home escaped isolation")
        require(get_hermes_home().resolve() == Path(config["hermes_home"]).resolve(), "Active app profile escaped isolation")
        require(inside(get_default_hermes_root(), root), "Default app profile escaped isolation")
        require(inside(get_real_home(), root), "Subprocess real-home resolver escaped isolation")
        require(store_root().resolve() == Path(config["tools_dir"]).resolve(), "Bundled tool store was not selected")
        from tools.registry import registry
        for module_name in ("tools.terminal_tool", "tools.file_tools", "tools.cronjob_tools"):
            imported = importlib.import_module(module_name)
            require(inside(imported.__file__, config["repo_dir"]), module_name + " did not come from the shipped repo")
        task_id = "windows-artifact-contract-" + root.name

        def dispatch(name, args):
            require(registry.get_entry(name) is not None, "Shipped tool was not registered: " + name)
            raw = registry.dispatch(name, args, task_id=task_id, session_id=task_id)
            data = json.loads(raw) if isinstance(raw, str) else raw
            assert_clean()
            require(isinstance(data, dict), name + " did not return a JSON object")
            require(not data.get("error") and data.get("success") is not False,
                    name + " refused or failed: " + json.dumps(data))
            require(data.get("status") not in {"blocked", "error", "degraded", "pending"},
                    name + " was not completed: " + json.dumps(data))
            return data

        scope = set_terminal_scope(build_profile_terminal_scope(config["hermes_home"]))
        try:
            marker = "WINDOWS_NATIVE_TERMINAL_" + uuid.uuid4().hex
            marker_path = root / "work" / "terminal-marker.txt"
            command = "printf '%s\\n' '" + marker + "' > terminal-marker.txt && printf '%s\\n' '" + marker + "'"
            terminal = dispatch("terminal", {"command": command, "timeout": 30,
                                             "workdir": str(root / "work"), "background": False})
            require(terminal.get("exit_code") == 0, "Terminal command did not exit successfully: " + json.dumps(terminal))
            require(marker in terminal.get("output", ""), "Terminal stdout marker was missing")
            require(marker_path.read_text(encoding="utf-8").strip() == marker,
                    "Terminal did not create the actual owned file marker")
            results.append({"name": "terminal_echo_and_file_marker", "kind": "real_host_command_execution",
                            "status": "passed", "tool_result": terminal})

            note = root / "work" / "contract-note.txt"
            first, second = "contract alpha\n", "contract beta\n"
            created = dispatch("write_file", {"path": str(note), "content": first})
            require(note.read_text(encoding="utf-8") == first, "write_file did not create the expected bytes")
            read = dispatch("read_file", {"path": str(note), "offset": 1, "limit": 50})
            require("contract alpha" in read.get("content", ""), "read_file did not return the created content")
            patched = dispatch("patch", {"path": str(note), "old_string": "contract alpha", "new_string": "contract beta"})
            require(patched.get("success") is True and note.read_text(encoding="utf-8") == second,
                    "patch did not update the real owned file")
            listed = dispatch("search_files", {"target": "files", "pattern": "contract-note.txt",
                                               "path": str(root / "work"), "limit": 20})
            require(any(Path(p).name == note.name for p in listed.get("files", [])),
                    "search_files did not list the real owned file: " + json.dumps(listed))
            deleted = dispatch("patch", {"mode": "patch", "patch":
                "*** Begin Patch\n*** Delete File: " + str(note) + "\n*** End Patch\n"})
            require(deleted.get("success") is True and not note.exists(), "V4A patch did not delete the real owned file")
            results.append({"name": "file_create_read_update_list_delete", "kind": "real_host_file_operations",
                            "status": "passed", "tool_results": [created, read, patched, listed, deleted]})

            from cron.jobs import get_job, get_due_jobs, list_jobs
            from cron.scheduler_provider import resolve_cron_scheduler
            require(resolve_cron_scheduler().name == "builtin", "An external scheduler provider was selected")
            require(list_jobs(include_disabled=True) == [], "Synthetic scheduler store was not fresh")
            name = "Windows isolated contract " + uuid.uuid4().hex[:10]
            job = dispatch("cronjob_manage", {"action": "create", "name": name,
                "prompt": "Synthetic CI store contract. This job must stay paused and must never execute.",
                "schedule": "every 1h", "deliver": "local", "paused": True,
                "paused_reason": "Private non-executing artifact contract", "workdir": str(root / "work")})
            job_id = job["job_id"]
            try:
                stored = get_job(job_id)
                require(stored and stored["enabled"] is False and stored["state"] == "paused",
                        "Synthetic job was not persisted disabled atomically")
                require(stored["next_run_at"] is None and stored.get("last_run_at") is None,
                        "Paused synthetic job gained a scheduled/executed time")
                listed_jobs = dispatch("cronjob_manage", {"action": "list", "include_disabled": True})
                require(any(j["job_id"] == job_id for j in listed_jobs["jobs"]), "Tool list omitted the persisted job")
                require(all(j["id"] != job_id for j in list_jobs(include_disabled=False)), "Disabled job appeared active")
                results.append(cli_contract(config, "hermes", ["cron", "list"], "cli_cron_list_paused",
                    lambda text: job_id in text and name in text and "[paused]" in text))
                new_name = name + " updated"
                updated = dispatch("cronjob_manage", {"action": "update", "job_id": job_id,
                    "name": new_name, "schedule": "every 2h", "prompt": "Updated synthetic non-executing CI store contract."})
                stored = get_job(job_id)
                require(stored["name"] == new_name and stored["enabled"] is False and stored["state"] == "paused",
                        "Updating a paused job changed its disabled state or lost the new name")
                require(stored["schedule_display"] != job["schedule"] and stored["next_run_at"] is None,
                        "Schedule update was not stored or incorrectly scheduled a paused job")
                require(all(j["id"] != job_id for j in get_due_jobs()), "Paused synthetic job was returned as due")
                require(get_job(job_id).get("last_run_at") is None, "Due scan executed the synthetic job")
            finally:
                removed = dispatch("cronjob_manage", {"action": "remove", "job_id": job_id})
                require(get_job(job_id) is None, "Synthetic job was not removed from the real store")
            require(list_jobs(include_disabled=True) == [], "Synthetic scheduler store was not empty after removal")
            results.append({"name": "scheduler_disabled_lifecycle_and_due_filter",
                "kind": "real_registry_persistent_store_and_nonexecuting_due_scan", "status": "passed",
                "scope": "No scheduler tick, background service, script, model turn, or delivery was invoked",
                "tool_results": [job, listed_jobs, updated, removed]})
        finally:
            from tools.terminal_tool import cleanup_all_environments
            cleanup_all_environments()
            reset_terminal_scope(scope)
        assert_clean()
        write_json(result_path, {"status": "passed", "contracts": results})
        print("Narrow Windows tool contracts passed; scheduler execution is not covered")
        return 0
    except Exception as exc:
        write_json(result_path, {"status": "failed", "contracts": results,
                                "error": str(exc), "traceback": traceback.format_exc()})
        traceback.print_exc()
        return 1


def coordinator(args):
    require(os.name == "nt" and sys.platform == "win32", "Run this script on real Windows; OS simulation is forbidden")
    package = Path(args.package_root).resolve(strict=True)
    manifest_path = Path(args.runtime_manifest).resolve(strict=True)
    parent = Path(args.state_parent).resolve(strict=True)
    require(package.is_dir() and parent.is_dir(), "Package root and state parent must be existing directories")
    require(inside(manifest_path, package), "Runtime manifest must be inside the selected complete package")
    protected = []
    for name in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HERMES_HOME", "HERMES_REAL_HOME"):
        value = os.environ.get(name)
        if value:
            path = Path(os.path.expandvars(value)).resolve()
            if path not in protected:
                protected.append(path)
    for path in (package, parent):
        require(not any(inside(path, p) or inside(p, path) for p in protected),
                "Package/state parent overlaps an actual runner/user profile; use an isolated CI volume path")
    require(not inside(parent, package) and not inside(package, parent), "State parent and package tree must be separate")
    manifest = read_json(manifest_path)
    runtime = manifest["runtime"]
    payload = manifest_path.parent

    def runtime_path(value, directory=False):
        require(isinstance(value, str) and value, "Manifest runtime path is empty")
        resolved = (payload / value).resolve(strict=True)
        require(inside(resolved, payload) and inside(resolved, package), "Manifest runtime path escapes the payload")
        require(resolved.is_dir() if directory else resolved.is_file(), "Manifest runtime path has the wrong type: " + str(resolved))
        return str(resolved)

    root = parent / ("windows-tool-contracts-" + uuid.uuid4().hex)
    root.mkdir()
    for name in ("work", "profile", "profile/home", "user", "local", "roaming", "temp", "guard", "results", "managed", "programdata"):
        (root / name).mkdir(parents=True, exist_ok=True)
    config = {"state_root": str(root), "protected_roots": [str(p) for p in protected],
              "package_root": str(package), "runtime_manifest": str(manifest_path),
              "manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
              "repo_dir": runtime_path(runtime["repoDir"], True),
              "site_packages": runtime_path(runtime["sitePackages"], True),
              "store_python": runtime_path(runtime["storePython"]),
              "tools_dir": runtime_path(runtime["toolsDir"], True),
              "commands": {name: runtime_path(runtime["commands"][name]) for name in ("hermes", "hermes-agent", "hermes-acp")},
              "hermes_home": str(root / "profile"), "user_home": str(root / "user")}
    require(Path(sys.executable).resolve() == Path(config["store_python"]).resolve(), "Invoke using this package's manifest storePython")
    probe = Path(config["site_packages"]) / "urllib3" / "util" / "connection.py"
    require(probe.is_file() and not probe.is_symlink() and not probe.is_junction(), "Shipped IPv6 probe module is missing")
    config["ipv6_probe_path"] = str(probe)
    config["ipv6_probe_sha256"] = hashlib.sha256(probe.read_bytes()).hexdigest()
    socket_module = Path(socket.__file__)
    require(socket_module.is_file() and not socket_module.is_symlink() and not socket_module.is_junction(),
            "Shipped stdlib socket module is missing")
    config["socketpair_path"] = runtime_path(str(socket_module))
    config["socketpair_sha256"] = hashlib.sha256(socket_module.read_bytes()).hexdigest()
    for name in ("wtc_guard.py", "windows_tool_contracts.py"):
        shutil.copyfile(Path(__file__).with_name(name), root / "guard" / name)
    (root / "guard" / "sitecustomize.py").write_text(
        "import os\ntry:\n    from wtc_guard import install\n    install()\nexcept BaseException:\n    os._exit(86)\n", encoding="utf-8")
    # JSON is valid YAML; no YAML dependency is needed for synthetic configuration.
    synthetic_config = {"updates": {"check": False}, "terminal": {"backend": "local", "cwd": str(root / "work"),
        "home_mode": "profile", "auto_source_bashrc": False, "shell_init_files": []},
        "security": {"allow_lazy_installs": False}, "cron": {"provider": "builtin"},
        "telemetry": {"shared_metrics": {"enabled": False, "send_enabled": False}},
        "gateway": {"multiplex_profiles": False}, "plugins": {"enabled": []}}
    write_json(root / "profile" / "config.yaml", synthetic_config)
    config_path = root / "contract-config.json"
    write_json(config_path, config)
    inherited = {key: value for key, value in os.environ.items() if key.upper() in {
        "SYSTEMROOT", "WINDIR", "COMSPEC", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
        "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "OS", "PATHEXT"}}
    system_root = next((v for k, v in inherited.items() if k.upper() == "SYSTEMROOT"), None)
    require(system_root, "Windows SystemRoot is unavailable")
    env = {**inherited, "SystemRoot": system_root, "HOME": str(root / "user"), "USERPROFILE": str(root / "user"),
        "HERMES_REAL_HOME": str(root / "user"), "HERMES_HOME": str(root / "profile"),
        "APPDATA": str(root / "roaming"), "LOCALAPPDATA": str(root / "local"), "PROGRAMDATA": str(root / "programdata"),
        "TEMP": str(root / "temp"), "TMP": str(root / "temp"), "TMPDIR": str(root / "temp"),
        "HERMES_MANAGED_DIR": str(root / "managed"), "PYTHONUSERBASE": str(root / "user-python"),
        "PYTHONPYCACHEPREFIX": str(root / "pycache"), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8", "HERMES_NONINTERACTIVE": "1", "HERMES_DISABLE_LAZY_INSTALLS": "1",
        "TZ": "UTC", "LANG": "C.UTF-8",
        "TERMINAL_ENV": "local", "TERMINAL_CWD": str(root / "work"), "TERMINAL_HOME_MODE": "profile",
        "WTC_CONFIG_PATH": str(config_path), "WTC_GUARD_RECEIPT": str(root / "results" / "worker.guard.jsonl"),
        "PATH": os.pathsep.join([str(Path(system_root) / "System32"), system_root,
                                  str(Path(system_root) / "System32" / "Wbem")])}
    user = Path(env["USERPROFILE"])
    env["HOMEDRIVE"], env["HOMEPATH"] = user.drive, str(user)[len(user.drive):]
    env["XDG_CONFIG_HOME"], env["XDG_CACHE_HOME"], env["XDG_DATA_HOME"] = (str(root / p) for p in ("xdg-config", "xdg-cache", "xdg-data"))
    os.environ.clear()
    os.environ.update(env)
    results = []
    status = "failed"
    error = None
    print("Owned CI state and receipts: " + str(root), flush=True)
    try:
        for name in ("hermes", "hermes-agent", "hermes-acp"):
            results.append(cli_contract(config, name, ["--help"], name + "_help", lambda text: "usage:" in text.casefold()))
            results.append(cli_contract(config, name, ["--version"], name + "_version", lambda text: bool(re.search(r"\d+\.\d+", text))))
        results.append(cli_contract(config, "hermes", ["cron", "list"], "cli_cron_list_fresh",
                                    lambda text: "No scheduled jobs" in text))
        result = run_process([config["store_python"], "-I", "-S", "-B", str(root / "guard" / "windows_tool_contracts.py"),
                              "--worker", str(config_path)], env, str(root / "work"), 360)
        write_json(root / "results" / "worker-process.json", result)
        verify_guard(env["WTC_GUARD_RECEIPT"])
        worker_result = read_json(root / "results" / "tool-contracts.json")
        results.extend(worker_result["contracts"])
        require(result["exit_code"] == 0 and worker_result["status"] == "passed", "Real tool contracts failed:\n" + result["output"])
        status = "passed"
    except Exception as exc:
        error = str(exc)
        traceback.print_exc()
    finally:
        summary = {"status": status, "platform": sys.platform, "contracts": results, "error": error,
                   "state_root": str(root), "runtime_manifest_sha256": config["manifest_sha256"],
                   "limits": ["Narrow credential-free product contracts, not full product validation",
                              "Scheduler persistence and disabled due-filter only; no tick or job execution",
                              "Python audit guards and rebased child environments; not a kernel filesystem/network sandbox",
                              "Native subprocess internals are not independently traced by the Python audit hook",
                              "Only the SHA-pinned urllib3 IPv6 capability probe and stdlib IPv4 socketpair construction are admitted; arbitrary loopback and outbound calls stay forbidden"]}
        write_json(root / "summary.json", summary)
        print("Contract result: " + status + "; receipt: " + str(root / "summary.json"), flush=True)
    return 0 if status == "passed" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-root")
    parser.add_argument("--runtime-manifest")
    parser.add_argument("--state-parent")
    parser.add_argument("--worker", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        require(os.name == "nt" and sys.platform == "win32", "Worker requires native Windows")
        return worker(args.worker)
    require(args.package_root and args.runtime_manifest and args.state_parent, "All three input paths are required")
    return coordinator(args)


if __name__ == "__main__":
    raise SystemExit(main())
