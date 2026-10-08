"""Create the pinned HTTPS update feed from the actual installer bytes."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re


def create_feed(installer: Path, version: str, tag: str) -> tuple[dict, str]:
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version):
        raise ValueError("A canonical X.Y.Z application version is required")
    if not re.fullmatch(re.escape("v" + version) + r"(?:-beta\.[1-9][0-9]*)?", tag):
        raise ValueError("Release tag does not match the application version")
    if installer.is_symlink() or not installer.is_file() or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.exe", installer.name):
        raise ValueError("A regular installer executable is required")
    size = installer.stat().st_size
    if not 0 < size < 2 * 1024**3:
        raise ValueError("Installer must fit the supported NSIS size limit")
    with installer.open("rb") as stream:
        if stream.read(2) != b"MZ":
            raise ValueError("Installer is not a Windows executable")
        stream.seek(0)
        sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
        stream.seek(0)
        sha512 = base64.b64encode(hashlib.file_digest(stream, "sha512").digest()).decode("ascii")
    url = f"https://github.com/jobKKB/luheng-highway-agent/releases/download/{tag}/{installer.name}"
    feed = {"version": version, "files": [{"url": url, "sha512": sha512, "sha256": sha256, "size": size}],
            "path": url, "sha512": sha512}
    return feed, f"{sha256}  {installer.name}\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    feed, sums = create_feed(args.installer, args.version, args.tag)
    args.output.mkdir(parents=True, exist_ok=False)
    # JSON is a YAML subset accepted by electron-updater's YAML parser.
    (args.output / "latest.yml").write_text(json.dumps(feed, indent=2) + "\n", encoding="utf-8")
    (args.output / "SHA256SUMS.txt").write_text(sums, encoding="utf-8")
    print(json.dumps(feed, indent=2))


if __name__ == "__main__":
    main()
