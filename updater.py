import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from packaging.version import Version
import config
import cache
import i18n

try:
    import certifi
except ImportError:  # pragma: no cover - requirements pin certifi
    certifi = None


def validate_manifest(data, current):
    if not isinstance(data, dict) or Version(data["version"]) <= Version(current):
        raise ValueError(i18n.tr("backend.error.update-version"))
    parsed = urlparse(data["url"])
    prefix = f"/{config.REPOSITORY}/releases/download/"
    if parsed.scheme != "https" or parsed.netloc != "github.com" or not parsed.path.startswith(prefix):
        raise ValueError(i18n.tr("backend.error.update-url"))
    if not re.fullmatch(r"[a-fA-F0-9]{64}", data.get("sha256", "")):
        raise ValueError(i18n.tr("backend.error.update-sha"))
    size = data.get("size")
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= 2 * 1024**3:
        raise ValueError(i18n.tr("backend.error.update-size"))
    return data


def platform_key():
    """Manifest platform key for the running build."""
    if config.IS_MACOS:
        return "macos-arm64"
    if config.IS_WINDOWS:
        return "windows-x64"
    return sys.platform


def select_update(data, current, platform=None):
    """Pick the release artifact for this platform.

    New manifests carry a ``platforms`` map; Windows-only manifests from older
    releases still expose the artifact at the top level and are accepted only on
    Windows so a macOS build can never install a Windows ZIP.
    """
    if not isinstance(data, dict):
        raise ValueError(i18n.tr("backend.error.update-manifest"))
    version = data.get("version")
    if not isinstance(version, str) or Version(version) <= Version(current):
        raise ValueError(i18n.tr("backend.error.update-version"))
    platform = platform or platform_key()
    platforms = data.get("platforms")
    entry = platforms.get(platform) if isinstance(platforms, dict) else None
    if entry is None and platform == "windows-x64" and data.get("url"):
        entry = {"url": data.get("url"), "sha256": data.get("sha256"), "size": data.get("size")}
    if not isinstance(entry, dict):
        return None
    selected = {
        "version": version,
        "notes": data.get("notes", ""),
        "mandatory": bool(data.get("mandatory", False)),
        **{key: entry.get(key) for key in ("url", "sha256", "size")},
    }
    return validate_manifest(selected, current)


def ssl_context():
    """TLS context with a reliable CA bundle.

    A frozen PyInstaller build does not inherit the build machine's OpenSSL
    certificate directory, so ``urlopen`` can fail with
    ``CERTIFICATE_VERIFY_FAILED`` on macOS. ``certifi`` ships its own bundle and
    PyInstaller bundles it automatically; fall back to the platform default
    store whenever it is unavailable.
    """
    if certifi is not None:
        try:
            return ssl.create_default_context(cafile=certifi.where())
        except Exception:
            pass
    return ssl.create_default_context()


def request(url):
    response = urlopen(
        Request(url, headers={"User-Agent": f"Haven/{config.VERSION}"}),
        timeout=8,
        context=ssl_context(),
    )
    if urlparse(response.url).scheme != "https":
        response.close()
        raise ValueError(i18n.tr("backend.error.update-redirect"))
    return response


def check(current):
    try:
        with request(config.MANIFEST_URL) as response:
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError(i18n.tr("backend.error.update-manifest-too-large"))
            data = json.loads(raw)
        if Version(data["version"]) <= Version(current):
            return {"available": False}
        selected = select_update(data, current)
        if selected is None:
            return {"available": False}
        return {"available": True, "manifest": selected}
    except Exception as exc:
        return {"available": False, "error": i18n.tr("backend.error.update-check", error=exc)}


def download(manifest, destination, progress):
    validate_manifest(manifest, config.VERSION)
    digest = hashlib.sha256()
    received = 0
    try:
        with request(manifest["url"]) as response, Path(destination).open("wb") as stream:
            while block := response.read(256 * 1024):
                received += len(block)
                if received > manifest["size"]:
                    raise ValueError(i18n.tr("backend.error.update-download-size"))
                stream.write(block)
                digest.update(block)
                progress(min(99, round(received / manifest["size"] * 100)))
        if received != manifest["size"] or digest.hexdigest().lower() != manifest["sha256"].lower():
            raise ValueError(i18n.tr("backend.error.update-checksum"))
        progress(100)
    except Exception:
        Path(destination).unlink(missing_ok=True)
        raise


def install(manifest, progress):
    helper = config.APP_DIR / "updater.exe"
    if not helper.is_file():
        raise FileNotFoundError(i18n.tr("backend.error.updater-missing"))
    staging = config.APP_DIR / ".updates"
    staging.mkdir(exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="haven-", dir=staging))
    package = work / "package.zip"
    download(manifest, package, progress)
    copied_helper = work / "updater.exe"
    shutil.copy2(helper, copied_helper)
    plan = work / "plan.json"
    # ``language`` lets the standalone updater localise its own messages.
    cache.atomic_json(plan, {"target": str(config.APP_DIR), "package": str(package), "pid": os.getpid(), "current": config.VERSION, "manifest": manifest, "language": i18n.current()})
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
