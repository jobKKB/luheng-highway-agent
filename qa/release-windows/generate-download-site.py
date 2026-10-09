"""Generate the existing download design only from accepted installer evidence."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
from pathlib import Path
import re
import runpy
import shutil

create_feed = runpy.run_path(str(Path(__file__).with_name("create-update-feed.py")))["create_feed"]
TEMPLATE = Path(__file__).resolve().parents[2] / "download-site"
LIFECYCLE_STAGES = (
    "accepted_with_declared_limits", "installed", "every_installed_payload_file_verified",
    "native_window", "contained_backend_health", "normal_window_close", "contained_processes_stopped",
    "normal_uninstall", "installed_tree_removed", "synthetic_userdata_retained",
    "restricted_token_lifecycle_verified", "unsigned_installer", "native_windows",
)
UPGRADE_STAGES = (
    "automaticUpdateVerified", "baselineInstalled", "productConsentConfirmed", "installerWizardCompleted",
    "targetAutomaticallyRelaunched", "targetDataVerified", "targetAutomaticProfileVerified",
    "baselineTreeVerified", "targetTreeVerified", "targetFixtureOpened",
)


def require(value, message):
    if not value:
        raise ValueError(message)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def validate_lifecycle(report, entry, version):
    require(report.get("schema") == 1 and all(report.get(key) is True for key in LIFECYCLE_STAGES),
            "Every restricted-token installation acceptance stage must pass")
    require(report.get("coverage") == "restricted-token-same-user" and report.get("architecture") == "X64" and
            report.get("forced_cleanup") is False and report.get("error") is None and
            report.get("immutable_payload_rebuilt") is False, "Incomplete or incompatible installation evidence")
    require(report.get("installer_sha256") == entry["sha256"] and report.get("health_version") == version,
            "Installation evidence does not describe these installer bytes/version")


def validate_upgrade(report, entry, version):
    require(report.get("schema") == 1 and report.get("status") == "online-update-verified" and
            all(report.get(key) is True for key in UPGRADE_STAGES) and report.get("error") is None and
            report.get("forcedCleanup") is False, "Online update acceptance is incomplete")
    pair = report["pair"]
    require(pair.get("schema") == "luheng-online-update/v1" and
            pair.get("repository") == "jobKKB/luheng-highway-agent" and
            pair["from"]["version"] == "0.7.2" and pair["to"]["version"] == version == "0.7.3",
            "Online update evidence describes a different version pair")
    for item in (pair["from"], pair["to"]):
        require(type(item.get("bytes")) is int and item["bytes"] > 0 and
                all(re.fullmatch(r"[a-f0-9]{64}", item.get(key, "")) for key in
                    ("sha256", "exeSha256", "asarSha256")), "Update pair is missing exact artifact identity")
    require(pair["to"]["sha256"] == entry["sha256"] and pair["to"]["bytes"] == entry["size"] and
            pair["to"]["url"] == entry["url"], "Updated target is not this public installer")
    return {"fromVersion": pair["from"]["version"], "toVersion": pair["to"]["version"],
            "fromSha256": pair["from"]["sha256"], "toSha256": pair["to"]["sha256"]}


def generate(installer, version, tag, lifecycle_path, output, upgrade_path=None):
    feed, sums = create_feed(installer, version, tag)
    entry = feed["files"][0]
    validate_lifecycle(read_json(lifecycle_path), entry, version)
    upgrade = validate_upgrade(read_json(upgrade_path), entry, version) if upgrade_path else None
    output = Path(output).absolute()
    require(not output.exists(), "Site output must be fresh; existing output is preserved")
    for parent in (output, *output.parents):
        require(not parent.is_symlink() and not (hasattr(parent, "is_junction") and parent.is_junction()),
                "Site output crosses a link or junction")
    accepted = "Online update 0.7.2 → 0.7.3: confirmed download, consent, NSIS wizard, automatic relaunch and test-data retention."
    pending = "Online update 0.7.2 → 0.7.3 has not been accepted for this download."
    migration = " Migration from the legacy Node prototype remains unverified. Back up existing settings and files before migration."
    values = {
        "URL": entry["url"], "VERSION": version, "SHA256": entry["sha256"],
        "BYTES_FORMATTED": f"{entry['size']:,}",
        "SIZE": f"{entry['size'] / 1_000_000:.1f} MB / {entry['size'] / 1024**2:.1f} MiB",
        "UPGRADE_ACCEPTANCE": f"<li>{accepted}</li>" if upgrade else "",
        "UPGRADE_LIMIT": "" if upgrade else f"<li>{pending}</li>",
        "UPGRADE_FAQ": (accepted if upgrade else pending) + migration,
    }
    document = (TEMPLATE / "index.html").read_text(encoding="utf-8-sig")
    for key, value in values.items():
        document = document.replace("__LUHENG_" + key + "__", value if key in
                                    ("UPGRADE_ACCEPTANCE", "UPGRADE_LIMIT") else html.escape(value, quote=True))
    require(not re.search(r"__LUHENG_[A-Z_]+__", document), "Unfilled site template field")
    require("0.5.1" not in document and "static.cloudflareinsights.com" not in document,
            "Stale release or copied analytics remains")
    metadata = {"version": version, "tag": tag, "windowsUrl": entry["url"], "publisher": "舟岱收费中心所AI团队", "sizeBytes": entry["size"],
                "sha256": entry["sha256"], "unsignedPreview": True, "installationVerified": True,
                "onlineUpdateVerified": upgrade is not None, "legacyPrototypeMigrationVerified": False,
                "lifecycleEvidenceSha256": digest(lifecycle_path), "upgrade": upgrade}
    if upgrade_path:
        metadata["upgradeEvidenceSha256"] = digest(upgrade_path)
    output.mkdir(parents=True)
    for name in ("styles.css", "app.js", "_headers"):
        shutil.copyfile(TEMPLATE / name, output / name)
    (output / "index.html").write_text(document, encoding="utf-8")
    (output / "download-config.js").write_text("window.LUHENG_DOWNLOAD = Object.freeze(" +
                                              json.dumps(metadata, indent=2) + ");\n", encoding="utf-8")
    (output / "release-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    (output / "SHA256SUMS.txt").write_text(sums, encoding="utf-8")
    updates = output / "updates/windows"
    updates.mkdir(parents=True)
    (updates / "latest.yml").write_text(json.dumps(feed, indent=2) + "\n", encoding="utf-8")
    (updates / "SHA256SUMS.txt").write_text(sums, encoding="utf-8")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("installer", "lifecycle", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--upgrade-evidence", type=Path)
    args = parser.parse_args()
    print(json.dumps(generate(args.installer, args.version, args.tag, args.lifecycle, args.output,
                              args.upgrade_evidence), indent=2))


if __name__ == "__main__":
    main()
