import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from packaging.version import Version
import config
import cache


def validate_manifest(data, current):
    if not isinstance(data, dict) or Version(data["version"]) <= Version(current):
        raise ValueError("更新版本必须高于当前版本")
    parsed = urlparse(data["url"])
    prefix = f"/{config.REPOSITORY}/releases/download/"
    if parsed.scheme != "https" or parsed.netloc != "github.com" or not parsed.path.startswith(prefix):
        raise ValueError("更新地址必须来自 Haven 的 HTTPS GitHub Releases")
    if not re.fullmatch(r"[a-fA-F0-9]{64}", data.get("sha256", "")):
        raise ValueError("缺少有效的 SHA256 校验值")
    size = data.get("size")
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= 2 * 1024**3:
        raise ValueError("更新大小不合法")
    return data


def request(url):
    response = urlopen(Request(url, headers={"User-Agent": f"Haven/{config.VERSION}"}), timeout=8)
    if urlparse(response.url).scheme != "https":
        response.close()
        raise ValueError("更新请求不能重定向到非 HTTPS 地址")
    return response


def check(current):
    try:
        with request(config.MANIFEST_URL) as response:
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError("更新清单过大")
            data = json.loads(raw)
        if Version(data["version"]) <= Version(current):
            return {"available": False}
        return {"available": True, "manifest": validate_manifest(data, current)}
    except Exception as exc:
        return {"available": False, "error": f"暂时无法检查更新：{exc}"}


def download(manifest, destination, progress):
    validate_manifest(manifest, config.VERSION)
    digest = hashlib.sha256()
    received = 0
    try:
        with request(manifest["url"]) as response, Path(destination).open("wb") as stream:
            while block := response.read(256 * 1024):
                received += len(block)
                if received > manifest["size"]:
                    raise ValueError("下载文件超过清单中的大小")
                stream.write(block)
                digest.update(block)
                progress(min(99, round(received / manifest["size"] * 100)))
        if received != manifest["size"] or digest.hexdigest().lower() != manifest["sha256"].lower():
            raise ValueError("更新文件 SHA256 或大小校验失败")
        progress(100)
    except Exception:
        Path(destination).unlink(missing_ok=True)
        raise


def install(manifest, progress):
    helper = config.APP_DIR / "updater.exe"
    if not helper.is_file():
        raise FileNotFoundError("独立更新器 updater.exe 缺失")
    staging = config.APP_DIR / ".updates"
    staging.mkdir(exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="haven-", dir=staging))
    package = work / "package.zip"
    download(manifest, package, progress)
    copied_helper = work / "updater.exe"
    shutil.copy2(helper, copied_helper)
    plan = work / "plan.json"
    cache.atomic_json(plan, {"target": str(config.APP_DIR), "package": str(package), "pid": os.getpid(), "current": config.VERSION, "manifest": manifest})
    subprocess.Popen([str(copied_helper), "--plan", str(plan)], cwd=work, creationflags=subprocess.CREATE_NO_WINDOW)


def cleanup_completed_updates(target):
    target = Path(target).resolve()
    staging = target / ".updates"
    installed = target / "version.txt"
    if not staging.is_dir() or staging.is_symlink() or not installed.is_file():
        return
    try:
        current = Version(installed.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return
    for work in staging.glob("haven-*"):
        if not work.is_dir() or work.is_symlink() or (work / "update-error.txt").exists():
            continue
        try:
            plan = json.loads((work / "plan.json").read_text(encoding="utf-8"))
            if Path(plan["target"]).resolve() != target:
                continue
            version = Version(plan["manifest"]["version"])
            # Earlier updater releases left no marker. Their backup and the
            # installed version identify a completed update without an error.
            if current < version or (not (work / "completed").is_file() and not (work / "backup").is_dir()):
                continue
            for name in ("backup", "stage"):
                path = work / name
                if path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path)
            (work / "package.zip").unlink(missing_ok=True)
            (work / "updater.exe").unlink(missing_ok=True)
            shutil.rmtree(work)
        except (OSError, ValueError, KeyError, TypeError):
            # Windows may still have the copied updater open. The next attempt
            # or next launch can finish deleting the directory.
            continue
