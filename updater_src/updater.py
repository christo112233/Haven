"""Standalone Windows updater helper.

It runs from a temporary copy after Haven exits, swaps the program files and
relaunches the app. It is a separate one-file executable, so it cannot import
the app's ``i18n`` module; the language preference is passed through the plan
file written by ``updater.install`` and the few user-visible messages live in
``MESSAGES`` below (keep the wording aligned with locales/*/backend.json).
"""
import argparse
import ctypes
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import time
import zipfile
from packaging.version import Version

OWNED = {"Haven.exe", "updater.exe", "_internal", "web", "version.txt", "LICENSE", "THIRD_PARTY_NOTICES.md"}

MESSAGES = {
    "zh-CN": {
        "title": "Haven 更新",
        "failed": "更新失败，原程序已保留或恢复。\n{error}",
        "too-large": "解压内容过大",
        "unsafe-path": "更新包包含不安全的路径",
        "non-owned": "更新包包含非程序文件或符号链接",
        "duplicate": "更新包包含重复文件",
        "missing": "更新包缺少必要程序文件",
        "symlink": "程序文件不能是符号链接",
        "timeout": "Haven 尚未退出，已取消更新",
        "downgrade": "拒绝降级或重复更新",
        "checksum": "更新包校验失败",
        "version": "更新包版本与清单不符",
        "installed": "当前安装已是相同或更高版本",
    },
    "en-US": {
        "title": "Haven Update",
        "failed": "Update failed. The previous version was kept or restored.\n{error}",
        "too-large": "The update archive is too large",
        "unsafe-path": "The update archive contains an unsafe path",
        "non-owned": "The update archive contains files that are not part of Haven or contains symlinks",
        "duplicate": "The update archive contains duplicate files",
        "missing": "The update archive is missing required program files",
        "symlink": "Program files cannot be symlinks",
        "timeout": "Haven did not exit; the update was cancelled",
        "downgrade": "Downgrades and repeated updates are rejected",
        "checksum": "The update archive failed verification",
        "version": "The update archive version does not match the manifest",
        "installed": "The installed version is already the same or newer",
    },
    "ja-JP": {
        "title": "Haven アップデート",
        "failed": "アップデートに失敗しました。以前のバージョンは保持または復元されています。\n{error}",
        "too-large": "展開する内容が大きすぎます",
        "unsafe-path": "アップデートパッケージに安全でないパスが含まれています",
        "non-owned": "アップデートパッケージに Haven 以外のファイルまたはシンボリックリンクが含まれています",
        "duplicate": "アップデートパッケージに重複したファイルが含まれています",
        "missing": "アップデートパッケージに必要なプログラムファイルがありません",
        "symlink": "プログラムファイルをシンボリックリンクにすることはできません",
        "timeout": "Haven が終了しないため、アップデートを中止しました",
        "downgrade": "ダウングレードおよび同じバージョンへの再適用は拒否されました",
        "checksum": "アップデートパッケージの検証に失敗しました",
        "version": "アップデートパッケージのバージョンがマニフェストと一致しません",
        "installed": "インストール済みのバージョンは既に同じか新しいものです",
    },
}

_language = "en-US"


def tr(key, **params):
    messages = MESSAGES.get(_language) or MESSAGES["en-US"]
    text = messages.get(key) or MESSAGES["en-US"].get(key) or key
    for name, value in params.items():
        text = text.replace("{" + name + "}", str(value))
    return text


def set_language(value):
    global _language
    _language = value if value in MESSAGES else "en-US"


def extract(package, stage):
    seen = set()
    with zipfile.ZipFile(package) as archive:
        if sum(info.file_size for info in archive.infolist()) > 6 * 1024**3:
            raise ValueError(tr("too-large"))
        for info in archive.infolist():
            name = PurePosixPath(info.filename)
            if "\\" in info.filename or name.is_absolute() or ".." in name.parts or not name.parts or ":" in info.filename:
                raise ValueError(tr("unsafe-path"))
            if name.parts[0] not in OWNED or ((info.external_attr >> 16) & 0o170000) == 0o120000:
                raise ValueError(tr("non-owned"))
            normalized = str(name).casefold()
            if normalized in seen:
                raise ValueError(tr("duplicate"))
            seen.add(normalized)
            archive.extract(info, stage)
    if not (stage / "Haven.exe").is_file() or not (stage / "version.txt").is_file() or not (stage / "_internal").is_dir():
        raise ValueError(tr("missing"))


def replace(target, stage, backup):
    backup.mkdir(exist_ok=False)
    changed = []
    moved = []
    try:
        for name in OWNED:
            source, destination = stage / name, target / name
            if not source.exists():
                continue
            if destination.is_symlink() or source.is_symlink():
                raise ValueError(tr("symlink"))
            if destination.exists():
                shutil.move(str(destination), str(backup / name))
                moved.append(name)
            changed.append(name)
            shutil.move(str(source), str(destination))
    except Exception:
        for name in reversed(changed):
            path = target / name
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink(missing_ok=True)
        for name in reversed(moved):
            shutil.move(str(backup / name), str(target / name))
        raise


def wait_for_exit(pid):
    kernel = ctypes.windll.kernel32
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x00100000, False, pid)
    if handle:
        try:
            if kernel.WaitForSingleObject(handle, 60000) != 0:
                raise TimeoutError(tr("timeout"))
        finally:
            kernel.CloseHandle(handle)


def apply(plan_path):
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    set_language(plan.get("language"))
    work = plan_path.parent
    target = Path(plan["target"]).resolve()
    package = Path(plan["package"])
    manifest = plan["manifest"]
    if Version(manifest["version"]) <= Version(plan["current"]):
        raise ValueError(tr("downgrade"))
    with package.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if package.stat().st_size != manifest["size"] or digest.lower() != manifest["sha256"].lower():
        raise ValueError(tr("checksum"))
    stage = work / "stage"
    stage.mkdir()
    extract(package, stage)
    if Version((stage / "version.txt").read_text().strip()) != Version(manifest["version"]):
        raise ValueError(tr("version"))
    wait_for_exit(plan["pid"])
    installed = target / "version.txt"
    if installed.exists() and Version(manifest["version"]) <= Version(installed.read_text().strip()):
        raise ValueError(tr("installed"))
    replace(target, stage, work / "backup")
    subprocess.Popen([str(target / "Haven.exe")], cwd=target)
    try:
        (work / "completed").touch()
    except OSError:
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True)
    args = parser.parse_args()
    plan_path = Path(args.plan)
    try:
        apply(plan_path)
    except Exception as exc:
        plan_path.with_name("update-error.txt").write_text(str(exc), encoding="utf-8")
        ctypes.windll.user32.MessageBoxW(None, tr("failed", error=exc), tr("title"), 0x10)


if __name__ == "__main__":
    main()
