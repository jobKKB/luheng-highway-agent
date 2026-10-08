"""Verify feed authority, hashes and version rejection without publishing."""
import base64
import hashlib
import importlib.util
from pathlib import Path
import tempfile

spec = importlib.util.spec_from_file_location("feed", Path(__file__).with_name("create-update-feed.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    installer = Path(directory) / "Luheng-Office-Agent-0.7.1-windows-x64.exe"
    data = b"MZ" + bytes(range(256))
    installer.write_bytes(data)
    feed, sums = module.create_feed(installer, "0.7.1", "v0.7.1-beta.1")
    row = feed["files"][0]
    assert row["sha256"] == hashlib.sha256(data).hexdigest()
    assert row["sha512"] == base64.b64encode(hashlib.sha512(data).digest()).decode()
    assert row["size"] == len(data)
    assert row["url"] == "https://github.com/jobKKB/luheng-highway-agent/releases/download/v0.7.1-beta.1/Luheng-Office-Agent-0.7.1-windows-x64.exe"
    assert sums == row["sha256"] + "  " + installer.name + "\n"
    for version, tag in [("0.7.1", "v0.7.2"), ("0.7.1", "../bad"), ("0.7.1-beta.1", "v0.7.1-beta.1"), ("00.7.1", "v00.7.1")]:
        try:
            module.create_feed(installer, version, tag)
        except ValueError:
            pass
        else:
            raise AssertionError("Invalid version/tag accepted")
    installer.write_bytes(b"not an executable")
    try:
        module.create_feed(installer, "0.7.1", "v0.7.1")
    except ValueError:
        pass
    else:
        raise AssertionError("Invalid executable accepted")
print("Update feed hashes and rejection checks passed")
