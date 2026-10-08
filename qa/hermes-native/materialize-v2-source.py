"""Admit and reconstruct the pinned source-only candidate. Never build or install."""
from pathlib import Path, PurePosixPath
import argparse
import base64
import hashlib
import io
import json
import os
import stat
import subprocess
import zipfile


def source_path(name):
    if not isinstance(name, str) or not name or "\\" in name or ":" in name:
        raise ValueError("Unsafe source path")
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts) or PurePosixPath(name).is_absolute():
        raise ValueError("Unsafe source path")
    if parts[0].casefold() == ".git":
        raise ValueError("Git metadata is not a source input")
    for part in parts:
        stem = part.split(".", 1)[0].upper()
        if part.endswith((".", " ")) or any(ch in '<>"|?*' or ord(ch) < 32 for ch in part):
            raise ValueError("Windows-aliased or invalid source path")
        if stem in {"CON", "PRN", "AUX", "NUL"} or stem in {f"{prefix}{number}" for prefix in ("COM", "LPT") for number in range(1, 10)}:
            raise ValueError("Windows reserved source path")
    return Path(*parts)


def rows_by_path(rows):
    result = {}
    folded = set()
    for row in rows:
        name = row["path"]
        source_path(name)
        if name in result or name.casefold() in folded:
            raise ValueError("Duplicate or Windows-conflicting source path")
        if not isinstance(row["bytes"], int) or row["bytes"] < 0:
            raise ValueError("Invalid source size")
        digest = row["sha256"]
        if len(digest) != 64 or any(ch not in "0123456789abcdef" for ch in digest):
            raise ValueError("Invalid source digest")
        result[name] = row
        folded.add(name.casefold())
    return result


def tree_digest(rows):
    return hashlib.sha256("".join(name + "\0" + rows[name]["sha256"] + "\n"
                                  for name in sorted(rows)).encode("utf-8")).hexdigest()


def owned_path(root, name):
    relative = source_path(name)
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            raise ValueError("Source path crosses a link or junction")
    if not current.resolve().is_relative_to(root.resolve()):
        raise ValueError("Source path escapes the admitted directory")
    return current


def load_controller(controller):
    folder = controller / "qa/hermes-native"
    identity = json.loads((folder / "source-identity.json").read_text(encoding="utf-8"))
    archive = base64.b64decode((folder / "source-overlay.zip.b64").read_bytes(), validate=True)
    if len(archive) != identity["overlay_zip_bytes"] or hashlib.sha256(archive).hexdigest() != identity["overlay_zip_sha256"]:
        raise ValueError("Source overlay size or digest differs")
    with zipfile.ZipFile(io.BytesIO(archive)) as overlay:
        names = overlay.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Duplicate ZIP entries")
        manifest = json.loads(overlay.read("SOURCE-OVERLAY-MANIFEST.json"))
        files = rows_by_path(manifest["files"])
        source_files = rows_by_path(manifest["source_files"])
        if set(names) != set(files) | {"SOURCE-OVERLAY-MANIFEST.json"}:
            raise ValueError("Unlisted source overlay entries")
        for key in ("upstream_commit", "source_count", "source_tree_sha256", "overlay_count", "LICENSE_sha256", "artifact_contract"):
            if manifest[key] != identity[key]:
                raise ValueError("Source identity and embedded manifest differ: " + key)
        if len(files) != identity["overlay_count"] or len(source_files) != identity["source_count"]:
            raise ValueError("Source manifest count differs")
        if tree_digest(source_files) != identity["source_tree_sha256"] or manifest["deleted_source_paths"]:
            raise ValueError("Unadmitted tree or source deletions")
        content = {}
        for name, row in files.items():
            info = overlay.getinfo(name)
            if stat.S_ISLNK(info.external_attr >> 16):
                raise ValueError("Overlay links are forbidden")
            mode = int(row["mode"], 8)
            if mode & ~0o777:
                raise ValueError("Privileged file modes are forbidden")
            data = overlay.read(name)
            if len(data) != row["bytes"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
                raise ValueError("Overlay bytes differ: " + name)
            if name not in source_files or (row["bytes"], row["sha256"]) != (source_files[name]["bytes"], source_files[name]["sha256"]):
                raise ValueError("Overlay is outside the full source pin")
            content[name] = data
    return identity, manifest, content


def apply_overlay(source, manifest, content):
    for row in manifest["files"]:
        destination = owned_path(source, row["path"])
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content[row["path"]])
        if os.name != "nt":
            destination.chmod(int(row["mode"], 8))


def verify_source(source, manifest):
    expected = rows_by_path(manifest["source_files"])
    actual = set()
    for directory, directories, filenames in os.walk(source):
        if Path(directory) == source:
            directories[:] = [name for name in directories if name != ".git"]
        for name in directories:
            owned_path(source, (Path(directory) / name).relative_to(source).as_posix())
        for name in filenames:
            path = Path(directory) / name
            relative = path.relative_to(source).as_posix()
            owned_path(source, relative)
            if not path.is_file():
                raise ValueError("Nonregular source input")
            actual.add(relative)
    if actual != set(expected):
        raise ValueError("Full source path inventory differs")
    for name, row in expected.items():
        path = owned_path(source, name)
        if path.stat().st_size != row["bytes"] or hashlib.file_digest(path.open("rb"), "sha256").hexdigest() != row["sha256"]:
            raise ValueError("Reconstructed source bytes differ: " + name)
    if hashlib.file_digest(owned_path(source, "LICENSE").open("rb"), "sha256").hexdigest() != manifest["LICENSE_sha256"]:
        raise ValueError("Upstream license differs")
    return {"source_count": len(expected), "source_tree_sha256": tree_digest(expected), "license_preserved": True}


def restore_raw_git_blobs(source, head, manifest):
    expected = rows_by_path(manifest["source_files"])
    overlay_paths = {row["path"] for row in manifest["files"]}
    entries = []
    inventory = subprocess.check_output(["git", "-C", str(source), "ls-tree", "-rz", "--full-tree", head])
    for record in inventory.split(b"\0"):
        if not record:
            continue
        metadata, raw_name = record.split(b"\t", 1)
        mode, kind, oid = metadata.decode("ascii").split()
        name = raw_name.decode("utf-8")
        source_path(name)
        if kind != "blob" or mode not in {"100644", "100755"}:
            raise ValueError("Upstream contains an unsupported link or special file")
        entries.append((name, mode, oid))
    requests = "".join(oid + "\n" for _, _, oid in entries).encode("ascii")
    raw = subprocess.check_output(["git", "-C", str(source), "cat-file", "--batch"], input=requests)
    stream = io.BytesIO(raw)
    for name, mode, oid in entries:
        returned_oid, kind, size = stream.readline().decode("ascii").strip().split()
        if returned_oid != oid or kind != "blob":
            raise ValueError("Raw upstream Git object identity differs")
        data = stream.read(int(size))
        if len(data) != int(size) or stream.read(1) != b"\n":
            raise ValueError("Truncated raw upstream Git object")
        if name not in overlay_paths:
            row = expected[name]
            # The frozen checkout retains explicit CRLF PowerShell attributes.
            # Admit that newline form only when its exact frozen hash matches.
            candidates = (data, data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))
            data = next((candidate for candidate in candidates
                         if len(candidate) == row["bytes"]
                         and hashlib.sha256(candidate).hexdigest() == row["sha256"]), None)
            if data is None:
                raise ValueError("Raw upstream or pinned newline bytes differ: " + name)
        destination = owned_path(source, name)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        if os.name != "nt":
            destination.chmod(0o755 if mode == "100755" else 0o644)
    if stream.read(1):
        raise ValueError("Unexpected extra raw upstream Git data")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("controller", type=Path)
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    controller, source = args.controller.resolve(), args.source.resolve()
    identity, manifest, content = load_controller(controller)
    head = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if head != identity["upstream_commit"]:
        raise SystemExit("Checkout is not the pinned immutable upstream")
    if subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True):
        raise SystemExit("Upstream checkout must be clean before materialization")
    # Git archive applies checkout filters too. cat-file returns exact raw blobs.
    restore_raw_git_blobs(source, head, manifest)
    apply_overlay(source, manifest, content)
    result = verify_source(source, manifest)
    paths = source.parent / "overlay-paths.bin"
    paths.write_bytes(("\0".join(row["path"] for row in manifest["files"]) + "\0").encode())
    subprocess.run(["git", "-C", str(source), "add", "-f", "--pathspec-from-file=" + str(paths), "--pathspec-file-nul"], check=True)
    subprocess.run(["git", "-C", str(source), "-c", "user.name=Luheng CI Source Fixture", "-c", "user.email=ci-source@invalid.example", "commit", "-m", "Apply pinned unified Luheng source-only build candidate"], check=True)
    if subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True):
        raise SystemExit("Candidate checkout is dirty after exact source admission")
    commit = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    (source.parent / "admitted-source-sha.txt").write_text(commit + "\n", encoding="utf-8")
    result.update({"source_commit": commit, "upstream_commit": head, "overlay_sha256": identity["overlay_zip_sha256"], "source_only": True, "build_performed": False, "fresh_upstream_reconstruction": True})
    (source.parent / "source-admission.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
