"""Fresh native helper inputs; strict NSIS wrapping of unchanged verified bytes."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from verify_consumer import contract, owned, read_json, require, sha, verify_downloads, verify_tree


def child_env(work, cache):
    inherited = {key: value for key, value in os.environ.items() if key.upper() in {
        "SYSTEMROOT", "WINDIR", "COMSPEC", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
        "NUMBER_OF_PROCESSORS", "OS", "PATHEXT", "VSINSTALLDIR", "VCINSTALLDIR", "WINDOWSSDKDIR",
        "WINDOWSSDKVERSION", "VCTOOLSVERSION", "INCLUDE", "LIB", "LIBPATH"}}
    system = Path(next(value for key, value in inherited.items() if key.upper() == "SYSTEMROOT"))
    env = {**inherited, "PATH": os.pathsep.join(str(p) for p in [system / "System32", system,
                system / "System32/Wbem"]), "CI": "1", "HOME": str(work / "home"),
           "USERPROFILE": str(work / "home"), "LOCALAPPDATA": str(work / "home/AppData/Local"),
           "APPDATA": str(work / "home/AppData/Roaming"), "HERMES_HOME": str(work / "hermes-home"),
           "HERMES_RUNTIME_DIR": str(cache / "unused-live-tools"), "TEMP": str(work / "temp"),
           "TMP": str(work / "temp"), "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1",
           "npm_config_cache": str(cache / "npm"), "npm_config_userconfig": str(work / "npm-user.npmrc"),
           "npm_config_globalconfig": str(work / "npm-global.npmrc"), "CSC_IDENTITY_AUTO_DISCOVERY": "false",
           "HERMES_DESKTOP_VARIANT": "bundled"}
    user = Path(env["USERPROFILE"])
    env["HOMEDRIVE"], env["HOMEPATH"] = user.drive, str(user)[len(user.drive):]
    for name in ("home", "home/AppData/Local", "home/AppData/Roaming", "hermes-home", "temp"):
        (work / name).mkdir(parents=True, exist_ok=True)
    # npm rejects loading the same config path for both user and global layers.
    # These distinct empty files also prevent reading config beside shipped Node.
    for name in ("npm-user.npmrc", "npm-global.npmrc"):
        (work / name).write_text("", encoding="utf-8")
    return env


def run(argv, *, source, env, evidence, label):
    started = time.monotonic()
    path = evidence / (label + ".log")
    with path.open("w", encoding="utf-8") as output:
        result = subprocess.run([str(v) for v in argv], cwd=source, env=env, stdin=subprocess.DEVNULL,
                                stdout=output, stderr=subprocess.STDOUT)
    print(label + ": exit=" + str(result.returncode) + "; seconds=" + str(round(time.monotonic() - started, 1)), flush=True)
    require(result.returncode == 0, label + " failed; inspect the synthetic log")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("contract", "source", "portable", "evidence", "payload", "work", "cache", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    require(os.name == "nt" and sys.platform == "win32" and platform.machine().upper() in {"AMD64", "X86_64"},
            "Real Windows x64 required")
    pins = contract(args.contract)
    source, payload, work, cache, output = [getattr(args, name).resolve() for name in ("source", "payload", "work", "cache", "output")]
    require(not work.exists() and not cache.exists(), "Fresh writable preparation directories required")
    for path in (source, work, cache, output):
        require(not path.is_relative_to(payload) and not payload.is_relative_to(path), "Mutation root overlaps immutable payload")
    work.mkdir(parents=True)
    cache.mkdir(parents=True)
    output.mkdir(parents=True, exist_ok=True)
    env = child_env(work, cache)
    os.environ.clear()
    os.environ.update(env)
    original = verify_downloads(pins, args.portable, args.evidence)
    manifest = read_json(original["structure"])
    before = verify_tree(payload, manifest)
    (output / "payload-before.json").write_text(json.dumps(before, indent=2) + "\n")
    sys.path.insert(0, str(source))
    from pm.build_operations import verified_tools
    from pm.lock import Lockfile
    # Read-only PM admission binds every shipped tool to the source's exact pin,
    # recorded digest, target and relocatable facts. No live selection or ensure.
    runtime = read_json(owned(payload, "resources/agent-payload/manifest.json"))["runtime"]
    tools = owned(payload, "resources/agent-payload/" + runtime["toolsDir"])
    selection = verified_tools(["python", "node", "npm"], source_store=tools, target="win32-x64",
                               lock=Lockfile(source / "pm/lock.json"))
    env = selection.environment(env)
    python, node = [selection.entries[name].binary for name in ("python", "node")]
    require(python and node and python.is_file() and node.is_file(), "Verified native launchers missing")
    env.update({"HERMES_PYTHON": str(python), "HERMES_NODE": str(node), "PYTHON": str(python)})
    native = work / "native-deps"
    packager = work / "packager"
    scripts = source / "apps/desktop/scripts"
    # Fresh lock-pinned npm graph and actual native staging. None of these steps
    # assembles an agent payload, recompiles the renderer, or updates its stamps.
    run([node, source / "scripts/build/node-deps.mjs", "--source", source, "--workspace", "apps/desktop"],
        source=source, env=env, evidence=output, label="fresh-node-preparation")
    run([node, scripts / "stage-native-deps.mjs", "--source", source, "--out", native,
         "--platform", "win32", "--arch", "x64"], source=source, env=env, evidence=output, label="fresh-native-preparation")
    run([node, scripts / "prepare-packaging-tools.mjs", "--source", source, "--out", packager,
         "--cache", cache / "packager", "--target", "win32-x64", "--format", "nsis"],
        source=source, env=env, evidence=output, label="fresh-packaging-preparation")
    run([node, scripts / "probe-prepared-native.mjs", "--source", source, "--native-deps", native,
         "--packaging", packager / "prepared.json", "--out", work / "native-probe"],
        source=source, env=env, evidence=output, label="fresh-native-electron-pty")
    # Repeat the producer's small real Vitest helper suite against fresh native
    # dependencies, preserving a distinct consumer execution receipt.
    run([node, source / "node_modules/vitest/vitest.mjs", "run", "--project", "electron",
         "scripts/prepared-prepackaged.test.mjs", "scripts/prepared-packaging.test.mjs",
         "scripts/prepared-native-deps.test.mjs", "scripts/run-electron-builder.test.mjs"],
        source=source / "apps/desktop", env=env, evidence=output, label="real-consumer-vitest")
    run([node, scripts / "prepared-prepackaged.mjs", "--source", source, "--prepared", packager / "prepared.json",
         "--prepackaged", payload, "--payload-manifest", original["structure"],
         "--payload-manifest-sha256", pins["evidenceFiles"]["structure"]["sha256"],
         "--native-health", original["health"], "--native-health-sha256", pins["evidenceFiles"]["health"]["sha256"],
         "--run-id", str(pins["build"]["runId"]), "--archive", original["archive"],
         "--archive-sha256", pins["archive"]["sha256"], "--archive-bytes", str(pins["archive"]["bytes"])],
        source=source, env=env, evidence=output, label="fresh-custody")
    command = [node, scripts / "run-electron-builder.mjs", "--prepared", packager / "prepared.json",
               "--native-deps", native, "--prepackaged", payload, "--prepackaged-receipt",
               packager / "prepackaged.prepared.json", "--win", "nsis", "--x64", "--publish", "never"]
    run([*command, "--validate-only"], source=source, env=env, evidence=output, label="strict-validate-only")
    run(command, source=source, env=env, evidence=output, label="strict-native-nsis")
    after = verify_tree(payload, manifest)
    require(after == before, "Original payload changed during packaging")
    (output / "payload-after.json").write_text(json.dumps(after, indent=2) + "\n")
    receipt = read_json(packager / "prepackaged.prepared.json")
    require(receipt["payload"]["rebuilt"] is False, "Rebuilt custody is forbidden")
    product = source / "apps/desktop/release/nsis-prepackaged-test"
    installers = list(product.glob("Luheng-Unsigned-Manual-Test-*-x64.exe"))
    require(len(installers) == 1, "Exactly one official manual NSIS installer required")
    installer = installers[0]
    require(installer.stat().st_size < 2 * 1024**3, "Installer exceeds the ordinary NSIS two-GiB archive envelope")
    # The official generated uninstaller is the sole installed-file addition.
    # If this pinned engine produces further additions, fail and review them.
    summary = {"installer": str(installer), "bytes": installer.stat().st_size, "sha256": sha(installer),
               "payload": receipt["payload"],
               "custody": receipt["custody"], "helperSource": receipt["packagingSource"],
               "fresh_native_inputs": True, "real_consumer_vitest_passed": True,
               "immutable_payload_before_after_match": True, "signed": False,
               "installation_verified": False, "standard_user_installation_verified": False}
    (output / "installer-build.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (output / "prepackaged.prepared.json").write_bytes((packager / "prepackaged.prepared.json").read_bytes())
    (output / "fresh-native.prepared.json").write_bytes(Path(str(native) + ".prepared.json").read_bytes())
    print(json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
