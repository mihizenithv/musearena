"""Check the distributable surface. Errors identify paths only, never matched values."""
from pathlib import Path
import json
import os
import re

root = Path(__file__).resolve().parents[1]
site = root / "public"
allowed = {".js", ".css", ".html", ".webp", ".json", ".mp4", ".mp3", ".txt"}
patterns = [rb"AIza[0-9A-Za-z_-]{35}", rb"gh[pousr]_[A-Za-z0-9]{30,}", rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"]
secrets = [value.encode() for name, value in os.environ.items() if len(value) >= 16 and name.upper() in
           {"GEMINI_API","GEMINI_API_KEY","GOOGLE_API_KEY","GITHUB_TOKEN","GH_TOKEN","VERCEL","VERCEL_TOKEN"}]
for path in root.rglob("*"):
    rel = path.relative_to(root)
    if rel.parts[0] in (".git", ".vercel"):
        continue
    assert not path.is_symlink(), rel
    if not path.is_file():
        continue
    assert not path.name.startswith(".env"), rel
    if rel.parts[0] == "public":
        assert (path.suffix in allowed or rel.as_posix() == "public/player/model/melody.bin") and not any(p.startswith(".") for p in rel.parts), rel
    data = path.read_bytes()
    assert not any(s in data for s in secrets), rel
    assert not any(re.search(p, data) for p in patterns), rel
for item in json.loads((site/"library/index.json").read_text(encoding="utf8"))["instruments"]:
    assert item["license"] == "CC0-1.0"
    assert item["sourceUrl"] in ("https://github.com/sgossner/VCSL","https://github.com/sgossner/VSCO-2-CE")
    files = list(item.get("notes", {}).values()) + [f for pad in item.get("pads", []) for f in pad["files"]]
    for name in files:
        assert re.fullmatch(r"library/samples/[0-9a-f]{20}\.mp3", name) and (site/name).is_file(), name
config=json.loads((root/"vercel.json").read_text())
assert config["outputDirectory"] == "public" and not (root/"api").exists()
print("Release contents, sample references, origin restrictions and credential scan passed.")
