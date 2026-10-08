"""Fail-fast safety-guard regression on the actual shipped Windows interpreter.

Run with the package/source-PM Python before an expensive full package build:
  python.exe -I -S -B wtc_guard_selftest.py --state-parent D:\\owned-ci-state

This tests only the guard and real Windows asyncio. It is not a product test.
The urllib3 pin is an explicitly synthetic, uncalled file because early PM
preparation need not have installed application site-packages yet.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import traceback
import uuid


CASES = ("asyncio_proactor_loop", "deny_loopback_bind", "deny_loopback_connect",
         "deny_external_bind", "deny_external_connect", "deny_wildcard_bind",
         "deny_outside_write", "deny_profile_read")


def require(value, message):
    if not value:
        raise RuntimeError(message)


def inside(path, root):
    return Path(path).resolve().is_relative_to(Path(root).resolve())


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def child(config_path, case):
    require(os.name == "nt" and sys.platform == "win32", "Self-test child requires actual Windows")
    config = json.loads(Path(config_path).read_text(encoding="utf-8"))
    sys.path.insert(0, str(Path(config["state_root"]) / "guard"))
    import wtc_guard
    wtc_guard.install()
    if case == "asyncio_proactor_loop":
        import asyncio
        loop = asyncio.new_event_loop()
        try:
            require(isinstance(loop, asyncio.ProactorEventLoop), "Default loop is not the Windows ProactorEventLoop")
            loop.run_until_complete(asyncio.sleep(0))
        finally:
            loop.close()
        wtc_guard.assert_clean()
    else:
        expected_event = "socket.bind" if case.endswith("bind") else "socket.connect"
        try:
            if case == "deny_outside_write":
                expected_event = "open"
                with open(Path(config["state_root"]).parent / "wtc-forbidden-outside-write", "w"):
                    pass
            elif case == "deny_profile_read":
                expected_event = "open"
                with open(Path(config["protected_roots"][0]) / "wtc-forbidden-profile-read", "rb"):
                    pass
            else:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM, 0) as sock:
                    sock.settimeout(1)
                    if case == "deny_loopback_bind":
                        sock.bind(("127.0.0.1", 0))
                    elif case == "deny_loopback_connect":
                        sock.connect(("127.0.0.1", 9))
                    elif case == "deny_external_bind":
                        sock.bind(("192.0.2.1", 0))
                    elif case == "deny_external_connect":
                        sock.connect(("192.0.2.1", 443))
                    elif case == "deny_wildcard_bind":
                        sock.bind(("0.0.0.0", 0))
                    else:
                        raise RuntimeError("Unknown self-test case")
        except PermissionError:
            require(len(wtc_guard._denials) == 1 and wtc_guard._denials[0]["event"] == expected_event,
                    "Expected one guard denial for " + expected_event)
        else:
            raise RuntimeError("Guard unexpectedly admitted " + case)
    print(json.dumps({"case": case, "status": "passed", "platform": sys.platform}), flush=True)
    return 0


def coordinator(args):
    require(os.name == "nt" and sys.platform == "win32", "Run on actual Windows; OS simulation is forbidden")
    expected = tuple(int(part) for part in args.expected_python_version.split("."))
    require(sys.version_info[:3] == expected, "Unexpected interpreter version: " + sys.version)
    require(socket.socketpair is socket._fallback_socketpair, "Interpreter does not use Windows socketpair fallback")
    parent = Path(args.state_parent).resolve(strict=True)
    require(parent.is_dir(), "State parent must be an existing isolated directory")
    protected = []
    for key in ("USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "HERMES_HOME", "HERMES_REAL_HOME"):
        if os.environ.get(key):
            path = Path(os.path.expandvars(os.environ[key])).resolve()
            if path not in protected:
                protected.append(path)
    require(protected, "Actual profile roots must be available for the negative read test")
    require(not any(inside(parent, p) or inside(p, parent) for p in protected),
            "State parent overlaps an actual runner/user profile")
    runtime_root = Path(sys.base_prefix).resolve(strict=True)
    socket_path = Path(socket.__file__).resolve(strict=True)
    require(inside(socket_path, runtime_root), "socket.py is not within the actual interpreter runtime")
    require(not any(inside(socket_path, p) for p in protected), "Interpreter runtime is inside a protected profile")
    root = parent / ("windows-guard-selftest-" + uuid.uuid4().hex)
    for name in ("guard", "work", "user", "profile", "roaming", "local", "temp", "results", "synthetic-site/urllib3/util"):
        (root / name).mkdir(parents=True, exist_ok=True)
    for name in ("wtc_guard.py", "wtc_guard_selftest.py"):
        shutil.copyfile(Path(__file__).with_name(name), root / "guard" / name)
    probe = root / "synthetic-site" / "urllib3" / "util" / "connection.py"
    probe.write_text("# Synthetic uncalled IPv6 probe pin for guard-only self-test.\n", encoding="utf-8")
    config = {"state_root": str(root), "protected_roots": [str(p) for p in protected],
              "package_root": str(runtime_root), "store_python": sys.executable,
              "site_packages": str(root / "synthetic-site"), "ipv6_probe_path": str(probe),
              "ipv6_probe_sha256": hashlib.sha256(probe.read_bytes()).hexdigest(),
              "socketpair_path": str(socket_path), "socketpair_sha256": hashlib.sha256(socket_path.read_bytes()).hexdigest()}
    config_path = root / "contract-config.json"
    write_json(config_path, config)
    env = {key: value for key, value in os.environ.items() if key.upper() in {
        "SYSTEMROOT", "WINDIR", "COMSPEC", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
        "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "OS", "PATHEXT"}}
    for key, directory in {"HOME": "user", "USERPROFILE": "user", "HERMES_REAL_HOME": "user", "HERMES_HOME": "profile",
                           "APPDATA": "roaming", "LOCALAPPDATA": "local", "TEMP": "temp", "TMP": "temp", "TMPDIR": "temp"}.items():
        env[key] = str(root / directory)
    env.update({"WTC_CONFIG_PATH": str(config_path), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1",
                "PYTHONIOENCODING": "utf-8", "PYTHONPYCACHEPREFIX": str(root / "pycache"),
                "PYTHONUSERBASE": str(root / "user-python")})
    require(any(k.upper() == "SYSTEMROOT" for k in env), "Windows SystemRoot is unavailable")
    system_root = next(v for k, v in env.items() if k.upper() == "SYSTEMROOT")
    env["PATH"] = os.pathsep.join((str(Path(system_root) / "System32"), system_root))
    user = Path(env["USERPROFILE"])
    env["HOMEDRIVE"], env["HOMEPATH"] = user.drive, str(user)[len(user.drive):]
    results = []
    print("Owned guard self-test state: " + str(root), flush=True)
    for case in CASES:
        receipt = root / "results" / (case + ".guard.jsonl")
        case_env = {**env, "WTC_GUARD_RECEIPT": str(receipt)}
        result = {"case": case, "status": "failed"}
        try:
            process = subprocess.run([sys.executable, "-I", "-S", "-B", str(root / "guard" / "wtc_guard_selftest.py"),
                                      "--child", str(config_path), "--case", case], env=case_env, cwd=root / "work",
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, encoding="utf-8", errors="replace", timeout=30, check=False)
            result.update(exit_code=process.returncode, output=process.stdout)
            require(process.returncode == 0, "Child failed: " + process.stdout)
            rows = [json.loads(line) for line in receipt.read_text(encoding="utf-8").splitlines()]
            require(sum(row.get("event") == "installed" for row in rows) == 1, "Missing unique installed receipt")
            denials = [row for row in rows if row.get("event") == "denied"]
            admissions = [row for row in rows if row.get("event") == "local_stdlib_socketpair"]
            if case == "asyncio_proactor_loop":
                require(not denials, "Positive case contained a guard denial")
                require({row["audit_event"] for row in admissions} == {"socket.bind", "socket.connect"},
                        "Real Proactor loop did not exercise both socketpair admissions")
                require(all(row["module_sha256"] == config["socketpair_sha256"] for row in admissions), "Unpinned admission")
            else:
                require(len(denials) == 1 and not admissions, "Negative case did not fail closed")
            result.update(status="passed", expected_denials=len(denials), socketpair_admissions=len(admissions))
        except Exception as exc:
            result.update(error=str(exc), traceback=traceback.format_exc())
        results.append(result)
        write_json(root / "results" / (case + ".json"), result)
        print(case + ": " + result["status"], flush=True)
    passed = all(row["status"] == "passed" for row in results)
    summary = {"status": "passed" if passed else "failed", "scope": "guard-only native Windows regression; not product validation",
               "platform": sys.platform, "python_version": sys.version, "python_executable": sys.executable,
               "socketpair_path": str(socket_path), "socketpair_sha256": config["socketpair_sha256"],
               "ipv6_probe": "synthetic uncalled file; real urllib3 behavior is not covered", "cases": results}
    write_json(root / "summary.json", summary)
    print("Guard self-test " + summary["status"] + "; receipt: " + str(root / "summary.json"), flush=True)
    return 0 if passed else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-parent")
    parser.add_argument("--expected-python-version", default="3.14.7")
    parser.add_argument("--child", help=argparse.SUPPRESS)
    parser.add_argument("--case", choices=CASES, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.child:
        require(args.case, "Child case is required")
        return child(args.child, args.case)
    require(args.state_parent, "State parent is required")
    return coordinator(args)


if __name__ == "__main__":
    raise SystemExit(main())
