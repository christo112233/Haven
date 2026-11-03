"""In-app updater for the ad-hoc signed macOS build.

A running .app bundle cannot be replaced in place, so this module downloads and
verifies the release ZIP, then hands the swap to a small detached shell helper
that waits for Haven to exit, backs up the old bundle, installs the new one and
relaunches. The old bundle and the downloaded package are removed on the first
successful launch of the new version (see ``cleanup``).
"""
from __future__ import annotations

import json
import os
import plistlib
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import config
import i18n
import updater

BUNDLE_IDENTIFIER = "io.github.christo112233.haven"
BACKUP_PREFIX = "Haven.app.backup-"
DEFAULT_OPEN_COMMAND = "/usr/bin/open"


def bundle_from_executable(executable):
    """Return the .app bundle containing ``executable`` (when frozen)."""
    executable = Path(executable).resolve()
    if len(executable.parents) < 3:
        raise ValueError(i18n.tr("backend.error.update-macos-bundle-locate"))
    bundle = executable.parents[2]
    if bundle.suffix != ".app" or not (bundle / "Contents" / "Info.plist").is_file():
        raise ValueError(i18n.tr("backend.error.update-macos-bundle-only"))
    return bundle


def app_bundle():
    if not getattr(sys, "frozen", False):
        raise ValueError(i18n.tr("backend.error.update-macos-source"))
    return bundle_from_executable(sys.executable)


def data_dir():
    return Path(config.STATE_PATH).parent


def update_root():
    root = data_dir() / "updates"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _info_plist(bundle):
    with (bundle / "Contents" / "Info.plist").open("rb") as stream:
        return plistlib.load(stream)


def _read_kv(path):
    values = {}
    try:
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            key, _, value = line.partition("=")
            if key:
                values[key] = value
    except OSError:
        return {}
    return values


def _write_kv(path, values):
    Path(path).write_text("".join(f"{key}={value}\n" for key, value in values.items()), encoding="utf-8")


def check_environment(bundle, manifest):
    """Validate that this copy of Haven can replace itself in place."""
    bundle = Path(bundle)
    text = str(bundle)
    if "AppTranslocation" in text:
        raise ValueError(i18n.tr("backend.error.update-macos-translocation"))
    parent = bundle.parent
    if not os.access(parent, os.W_OK):
        raise ValueError(i18n.tr("backend.error.update-macos-parent-write", name=bundle.name))
    if not os.access(bundle, os.W_OK):
        raise ValueError(i18n.tr("backend.error.update-macos-bundle-write"))
    try:
        free = shutil.disk_usage(parent).free
    except OSError:
        free = 0
    required = int(manifest.get("size", 0)) * 3 + 300 * 1024**2
    if free and free < required:
        raise ValueError(i18n.tr("backend.error.update-macos-disk", size=required // 1024**2))
    return bundle


def verify_bundle(app, manifest):
    """Verify the downloaded bundle before it replaces the running one."""
    app = Path(app)
    if not app.is_dir() or not (app / "Contents" / "Info.plist").is_file():
        raise ValueError(i18n.tr("backend.error.update-macos-missing-app"))
    info = _info_plist(app)
    if info.get("CFBundleIdentifier") != BUNDLE_IDENTIFIER:
        raise ValueError(i18n.tr("backend.error.update-macos-bundle-id"))
    if str(info.get("CFBundleShortVersionString", "")) != str(manifest.get("version", "")):
        raise ValueError(i18n.tr("backend.error.update-macos-version"))
    result = subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], capture_output=True, text=True)
    if result.returncode != 0:
        raise ValueError(i18n.tr("backend.error.update-macos-signature", error=(result.stderr or result.stdout).strip()[:200]))
    return info


def _helper_script(work, bundle, staged, backup, manifest, open_command=None):
    open_command = open_command or DEFAULT_OPEN_COMMAND
    script = Path(work) / "install.sh"
    log = Path(work) / "update.log"
    installed = Path(work) / "installed.txt"
    error = Path(work) / "update-error.txt"
    version = manifest["version"]
    old_version = config.VERSION
    q = shlex.quote
    install_failed = i18n.tr("backend.error.update-macos-install-failed") + "\n"
    lines = [
        "#!/bin/sh",
        "set -u",
        f"LOG={q(str(log))}",
        'exec >>"$LOG" 2>&1',
        'echo "Haven macOS update helper started"',
        f"PID={os.getpid()}",
        f"TARGET={q(str(bundle))}",
        f"STAGED={q(str(staged))}",
        f"BACKUP={q(str(backup))}",
        f"INSTALLED={q(str(installed))}",
        f"ERROR={q(str(error))}",
        f"OPEN={q(str(open_command))}",
        'while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done',
        'sleep 0.3',
        'if [ ! -d "$STAGED" ]; then echo "staged app missing"; exit 1; fi',
        'if [ -e "$TARGET" ]; then',
        '  rm -rf "$BACKUP"',
        '  mv "$TARGET" "$BACKUP" || { echo "backup failed"; exit 1; }',
        'fi',
        'if ! /usr/bin/ditto "$STAGED" "$TARGET"; then',
        '  echo "copy failed; restoring backup"',
        '  rm -rf "$TARGET"',
        '  [ -e "$BACKUP" ] && mv "$BACKUP" "$TARGET"',
        f'  printf %s {q(install_failed)} > "$ERROR"',
        '  "$OPEN" -n "$TARGET" >/dev/null 2>&1',
        '  exit 1',
        'fi',
        '/usr/bin/xattr -dr com.apple.quarantine "$TARGET" >/dev/null 2>&1 || true',
        f"printf 'version=%s\\nold_version=%s\\nbackup=%s\\n' {q(version)} {q(old_version)} \"$BACKUP\" > \"$INSTALLED\"",
        'echo "update installed; relaunching"',
        '"$OPEN" -n "$TARGET" >/dev/null 2>&1',
        'exit 0',
    ]
    script.write_text("\n".join(lines) + "\n", encoding="utf-8")
    script.chmod(0o700)
    return script


def install(manifest, progress):
    """Download, verify and schedule the bundle swap, then relaunch."""
    bundle = check_environment(app_bundle(), manifest)
    work = Path(tempfile.mkdtemp(prefix="haven-mac-", dir=update_root()))
    package = work / "Haven-mac-arm64.zip"
    try:
        updater.download(manifest, package, progress)
        stage = work / "stage"
        stage.mkdir()
        result = subprocess.run(["/usr/bin/ditto", "-x", "-k", str(package), str(stage)], capture_output=True, text=True)
        if result.returncode != 0:
            raise ValueError(i18n.tr("backend.error.update-macos-unzip", error=(result.stderr or result.stdout).strip()[:200]))
        staged = stage / "Haven.app"
        if staged.is_symlink():
            raise ValueError(i18n.tr("backend.error.update-macos-symlink"))
        verify_bundle(staged, manifest)
        backup = bundle.parent / f"{BACKUP_PREFIX}{config.VERSION}"
        script = _helper_script(work, bundle, staged, backup, manifest)
        log = work / "update.log"
        with log.open("ab") as stream:
            subprocess.Popen(
                ["/bin/sh", str(script)],
                stdin=subprocess.DEVNULL,
                stdout=stream,
                stderr=stream,
                cwd=str(work),
                start_new_session=True,
            )
        return str(bundle)
    except Exception:
        # Keep the staging directory and its log for diagnostics; cleanup ages it
        # out later, and the running app is left untouched.
        raise


def _remove_backup(path, bundle_parent):
    try:
        backup = Path(path).resolve()
        parent = Path(bundle_parent).resolve()
    except OSError:
        return
    if backup.parent != parent or not backup.name.startswith(BACKUP_PREFIX):
        return
    if backup.is_dir() and not backup.is_symlink():
        shutil.rmtree(backup, ignore_errors=True)


def cleanup(current_version, bundle=None):
    """Delete the previous bundle and download cache after a successful update."""
    if bundle is None:
        try:
            bundle = app_bundle()
        except ValueError:
            return None
    bundle = Path(bundle)
    root = data_dir() / "updates"
    if not root.is_dir():
        return None
    now = time.time()
    for work in root.iterdir():
        if not work.is_dir() or work.is_symlink():
            continue
        marker = work / "installed.txt"
        if marker.is_file():
            values = _read_kv(marker)
            if values.get("version") == str(current_version):
                _remove_backup(values.get("backup"), bundle.parent)
                shutil.rmtree(work, ignore_errors=True)
                continue
        try:
            age = now - work.stat().st_mtime
        except OSError:
            continue
        if age > 7 * 86400:
            shutil.rmtree(work, ignore_errors=True)
    try:
        root.rmdir()
    except OSError:
        pass
    return None
