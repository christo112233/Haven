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


def extract(package, stage):
    seen = set()
    with zipfile.ZipFile(package) as archive:
        if sum(info.file_size for info in archive.infolist()) > 6 * 1024**3:
            raise ValueError("解压内容过大")
        for info in archive.infolist():
            name = PurePosixPath(info.filename)
            if "\\" in info.filename or name.is_absolute() or ".." in name.parts or not name.parts or ":" in info.filename:
                raise ValueError("更新包包含不安全的路径")
            if name.parts[0] not in OWNED or ((info.external_attr >> 16) & 0o170000) == 0o120000:
                raise ValueError("更新包包含非程序文件或符号链接")
            normalized = str(name).casefold()
            if normalized in seen:
                raise ValueError("更新包包含重复文件")
            seen.add(normalized)
            archive.extract(info, stage)
    if not (stage / "Haven.exe").is_file() or not (stage / "version.txt").is_file() or not (stage / "_internal").is_dir():
        raise ValueError("更新包缺少必要程序文件")


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
                raise ValueError("程序文件不能是符号链接")
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
                raise TimeoutError("Haven 尚未退出，已取消更新")
        finally:
            kernel.CloseHandle(handle)


def apply(plan_path):
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    work = plan_path.parent
    target = Path(plan["target"]).resolve()
    package = Path(plan["package"])
    manifest = plan["manifest"]
    if Version(manifest["version"]) <= Version(plan["current"]):
        raise ValueError("拒绝降级或重复更新")
    with package.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if package.stat().st_size != manifest["size"] or digest.lower() != manifest["sha256"].lower():
        raise ValueError("更新包校验失败")
    stage = work / "stage"
    stage.mkdir()
    extract(package, stage)
    if Version((stage / "version.txt").read_text().strip()) != Version(manifest["version"]):
        raise ValueError("更新包版本与清单不符")
    wait_for_exit(plan["pid"])
    installed = target / "version.txt"
    if installed.exists() and Version(manifest["version"]) <= Version(installed.read_text().strip()):
        raise ValueError("当前安装已是相同或更高版本")
    replace(target, stage, work / "backup")
    subprocess.Popen([str(target / "Haven.exe")], cwd=target)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True)
    args = parser.parse_args()
    try:
        apply(Path(args.plan))
    except Exception as exc:
        Path(args.plan).with_name("update-error.txt").write_text(str(exc), encoding="utf-8")
        ctypes.windll.user32.MessageBoxW(None, f"更新失败，原程序已保留或恢复。\n{exc}", "Haven 更新", 0x10)


if __name__ == "__main__":
    main()
