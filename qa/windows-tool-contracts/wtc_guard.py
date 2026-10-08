"""Private CI safety instrumentation. No product handlers are replaced or mocked."""
from __future__ import annotations

import hashlib
import json
import socket
import os
import sys
import threading
import traceback

_installed = False
_denials = []


def _canonical(value):
    if isinstance(value, int) or value is None:
        return None
    text = os.fsdecode(value)
    if text.casefold() in {"nul", "conin$", "conout$"}:
        return None
    return os.path.normcase(os.path.realpath(os.path.abspath(text)))


def _within(value, root):
    value = _canonical(value)
    return value is not None and (value == root or value.startswith(root + os.sep))


def install():
    global _installed
    if _installed:
        return
    if os.name != "nt" or sys.platform != "win32":
        raise RuntimeError("Safety guard requires an actual Windows interpreter")
    with open(os.environ["WTC_CONFIG_PATH"], encoding="utf-8") as handle:
        config = json.load(handle)
    root = _canonical(config["state_root"])
    protected = [_canonical(p) for p in config["protected_roots"]]
    ipv6_probe = _canonical(config["ipv6_probe_path"])
    if not _within(ipv6_probe, _canonical(config["site_packages"])):
        raise RuntimeError("IPv6 probe module is outside the admitted runtime")
    with open(ipv6_probe, "rb") as probe_file:
        if hashlib.file_digest(probe_file, "sha256").hexdigest() != config["ipv6_probe_sha256"]:
            raise RuntimeError("Pinned IPv6 capability probe bytes changed")
    receipt = _canonical(os.environ["WTC_GUARD_RECEIPT"])
    if not _within(receipt, root):
        raise RuntimeError("Guard receipt is outside the owned CI state")
    handle = open(receipt, "a", encoding="utf-8", buffering=1)
    lock = threading.RLock()
    local = threading.local()

    def record(event, **details):
        with lock:
            handle.write(json.dumps({"event": event, "pid": os.getpid(), **details}) + "\n")
            handle.flush()

    def deny(event, reason):
        _denials.append({"event": event, "reason": reason})
        record("denied", audit_event=event, reason=reason, stack=traceback.format_stack(limit=24))
        raise PermissionError("Private Windows contract safety boundary: " + reason)

    def check_path(event, value, write=False):
        path = _canonical(value)
        if path is None:
            return
        if any(_within(path, p) for p in protected):
            deny(event, "actual runner/user profile access: " + path)
        if write and not _within(path, root):
            deny(event, "write outside owned CI state: " + path)

    def audit(event, args):
        # Canonicalization/receipt writing must not recursively re-enter the hook.
        if getattr(local, "active", False):
            return
        local.active = True
        try:
            if event == "open":
                mode = args[1] or ""
                flags = args[2] or 0
                write = any(c in mode for c in "wax+") or bool(
                    flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
                check_path(event, args[0], write)
            elif event in {"os.listdir", "os.scandir", "os.chdir"}:
                check_path(event, args[0])
            elif event in {"os.mkdir", "os.remove", "os.rmdir", "os.chmod", "os.utime", "os.truncate", "shutil.rmtree"}:
                check_path(event, args[0], True)
            elif event in {"os.rename", "os.link", "os.symlink"}:
                for path in args[:2]:
                    check_path(event, path, True)
            elif event.startswith("socket.") and event in {
                    "socket.connect", "socket.bind", "socket.getaddrinfo", "socket.gethostbyname",
                    "socket.gethostbyaddr", "socket.sendto", "socket.sendmsg", "socket.listen"}:
                caller = sys._getframe(1)
                local_probe = (event == "socket.bind" and len(args) == 2
                    and args[1] == ("::1", 0) and args[0].family == socket.AF_INET6
                    and args[0].type == socket.SOCK_STREAM
                    and _canonical(caller.f_code.co_filename) == ipv6_probe
                    and caller.f_code.co_name == "_has_ipv6"
                    and caller.f_globals.get("__name__") == "urllib3.util.connection")
                if local_probe:
                    record("local_ipv6_capability_probe", address=args[1], module_sha256=config["ipv6_probe_sha256"])
                else:
                    deny(event, "network operations are outside these contracts: " + repr(args[1:]))
            elif event == "os.system" or event.startswith("os.startfile"):
                deny(event, "unreviewed shell/GUI launch")
            elif event == "sqlite3.connect":
                database = os.fsdecode(args[0])
                if database != ":memory:":
                    if database.startswith("file:"):
                        database = database[5:].split("?", 1)[0]
                    check_path(event, database, True)
            elif event == "ctypes.dlopen" and args[0] is not None:
                check_path(event, args[0])
            elif event == "os.putenv":
                key, value = (os.fsdecode(v) for v in args[:2])
                if key.upper() in {"HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HERMES_HOME",
                                    "HERMES_REAL_HOME", "TEMP", "TMP", "TMPDIR"}:
                    if not _within(value, root):
                        deny(event, "profile/temp environment rebased outside owned CI state: " + key)
            elif event in {"winreg.SetValue", "winreg.SetValueEx", "winreg.DeleteKey", "winreg.DeleteValue"}:
                deny(event, "registry mutation is outside these contracts")
            elif event == "subprocess.Popen":
                executable, argv, cwd, env = args
                if cwd is not None:
                    check_path(event, cwd)
                if env is None:
                    env = os.environ
                folded = {key.upper(): value for key, value in env.items()}
                # No inherited real-profile paths may return via a shell or Python child.
                for key in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HERMES_HOME",
                            "HERMES_REAL_HOME", "TEMP", "TMP", "TMPDIR"):
                    value = folded.get(key)
                    if not value or not _within(value, root):
                        deny(event, "subprocess has an unisolated " + key)
                for key, value in folded.items():
                    if key in {"PATH", "PYTHONPATH", "PYTHONHOME"}:
                        for entry in value.split(os.pathsep):
                            if entry:
                                check_path(event, entry)
                record("spawn", executable=str(executable), cwd=str(cwd))
        finally:
            local.active = False

    sys.addaudithook(audit)
    _installed = True
    record("installed", argv0=sys.argv[0], platform=sys.platform, state_root=root)


def assert_clean():
    if not _installed:
        raise RuntimeError("Safety guard is not installed")
    if _denials:
        raise RuntimeError("Safety guard refused an operation: " + json.dumps(_denials))
