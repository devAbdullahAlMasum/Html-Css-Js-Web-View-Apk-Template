#!/usr/bin/env python3
import base64
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
import urllib.request
import tempfile
from pathlib import Path, PurePosixPath

VERSION = "0.1.0-beta.13"
INTEGRITY = "f3lnxrjlTCHagChy/6ZW+4Axv9XcDfPnawkxCL++mZ1NbLMf302WPvbwwP1w+/bxOgxucu4euLYOQ6aPoYzXZw=="
DEST = Path(__file__).resolve().parents[1] / "app" / "ui-sdk"
CACHE = Path(os.environ.get("ORBIT_SDK_TOOLS", "/tmp/orbit-sdk-tools"))
CACHE.mkdir(parents=True, exist_ok=True)
esbuild = CACHE / "node_modules" / "esbuild" / "package.json"
if not esbuild.is_file() or json.loads(esbuild.read_text()).get("version") != "0.25.12":
    subprocess.run(["npm", "install", "--prefix", str(CACHE), "--no-audit", "--no-fund", "esbuild@0.25.12"], check=True)
PACKAGES = [
    ("web", INTEGRITY),
    ("core", "URjk9hqdc/cZKDtw6Gb9NqjY48U8l0EgoP4d5ghlooa3av+GrR0iSmsav133UU4oelcuKIO1ZPJ4j7gIPMr1Vg=="),
]

for name, integrity in PACKAGES:
    cached = CACHE / f"{name}-{VERSION}.tgz"
    if not cached.is_file():
        url = f"https://registry.npmjs.org/@ui-sdk/{name}/-/{name}-{VERSION}.tgz"
        with urllib.request.urlopen(url, timeout=60) as response:
            cached.write_bytes(response.read())
    data = cached.read_bytes()
    if base64.b64encode(hashlib.sha512(data).digest()).decode() != integrity:
        raise RuntimeError(f"ui-sdk {name} package integrity check failed")
    package = CACHE / "node_modules" / "@ui-sdk" / name
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile() or not member.name.startswith("package/"):
                continue
            relative = PurePosixPath(member.name.removeprefix("package/"))
            if relative.is_absolute() or ".." in relative.parts:
                raise RuntimeError("Unsafe ui-sdk package path")
            if relative.parts[0] not in {"dist", "browser", "package.json", "LICENSE", "LICENSE.md", "LICENSE.txt", "NOTICE"}:
                continue
            target = package.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(member).read())

with tempfile.TemporaryDirectory(prefix="orbit-sdk-", dir=CACHE) as temporary:
    stage = Path(temporary)
    web = CACHE / "node_modules" / "@ui-sdk" / "web"
    for filename in ["web.js", "web.css"]:
        shutil.copy2(web / "browser" / filename, stage / filename)
    for name, _ in PACKAGES:
        package = CACHE / "node_modules" / "@ui-sdk" / name
        for filename in ["LICENSE", "LICENSE.md", "LICENSE.txt", "NOTICE"]:
            if (package / filename).is_file():
                target = filename if name == "web" else "core-" + filename
                shutil.copy2(package / filename, stage / target)
    subprocess.run(["node", str(Path(__file__).with_name("package-ui-sdk.cjs")), str(CACHE), str(stage)], check=True)
    if not (stage / "web" / "agent.js").is_file():
        raise RuntimeError("ui-sdk agent entry missing")
    (stage / "version.json").write_text(json.dumps({"version": VERSION, "license": "Apache-2.0", "agentEntry": True}) + "\n")
    DEST.mkdir(parents=True, exist_ok=True)
    if (DEST / "web").is_dir():
        shutil.rmtree(DEST / "web")
    shutil.copytree(stage, DEST, dirs_exist_ok=True)

count = sum(1 for path in DEST.rglob("*") if path.is_file())
print(f"Packaged ui-sdk {VERSION}: {count} files, shared agent runtime; Orbit app stays unbundled")
