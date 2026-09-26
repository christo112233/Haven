from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor, as_completed
import json
import os
from pathlib import Path
import subprocess
import threading
import uuid

from send2trash import send2trash
import cache
import config
import metadata
import scanner
import thumbs


def process_item(item):
    try:
        item.update(metadata.read(item["path"], item["ext"]))
        _, warning = thumbs.get(item)
        item.update(ready=True, warning=warning)
    except Exception as exc:
        item.update(ready=False, error=str(exc))
    return item


class Api:
    def __init__(self):
        self.window = None
        self._maximized = False
        self.base_url = ""
        self.state = cache.read_json(config.STATE_PATH, {})
        self.state.setdefault("roots", [])
        self.state.setdefault("expanded", [])
        self.state.setdefault("auto_update", True)
        self.state.setdefault("theme", "dark")
        self.state.setdefault("thumb_size", 240)
        self.jobs = {}
        self.lock = threading.RLock()
        self.scan_lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 4), thread_name_prefix="haven-media")
        self.raw_pool = ProcessPoolExecutor(max_workers=min(4, os.cpu_count() or 1))
        self.update = None
        self.download_status = {"state": "idle"}

    def bootstrap(self):
        return {"state": self.state, "version": config.VERSION, "base_url": self.base_url, "desktop": self.window is not None}

    def window_action(self, action):
        if self.window is None:
            raise ValueError("窗口操作仅适用于桌面程序")
        if action == "minimize":
            self.window.minimize()
        elif action == "maximize":
            if self._maximized:
                self.window.restore()
                self._maximized = False
            else:
                self.window.maximize()
                self._maximized = True
        elif action == "close":
            self.window.destroy()
        else:
            raise ValueError("未知窗口操作")
        return {"ok": True}

    def resize_window(self, width, height):
        if self.window is None:
            raise ValueError("窗口缩放仅适用于桌面程序")
        self.window.resize(max(800, min(3840, int(width))), max(560, min(2160, int(height))))
        return {"ok": True}

    def settings(self, changes):
        allowed = {"expanded", "current", "theme", "thumb_size", "auto_update", "skipped_version", "recursive"}
        with self.lock:
            self.state.update({key: value for key, value in changes.items() if key in allowed})
            try:
                cache.atomic_json(config.STATE_PATH, self.state)
            except OSError as exc:
                return {"warning": f"设置无法保存到程序目录：{exc}"}
        return {"ok": True}

    def authorize(self, value):
        path = Path(value).resolve(strict=True)
        for root in self.state["roots"]:
            try:
                path.relative_to(Path(root).resolve())
                return path
            except ValueError:
                continue
        raise PermissionError("路径不在已添加的照片目录内")

    def add_folder(self, path=None):
        if not path:
            if self.window is None:
                return {"cancelled": True}
            import webview
            selected = self.window.create_file_dialog(webview.FileDialog.FOLDER)
            if not selected:
                return {"cancelled": True}
            path = selected[0]
        folder = Path(path).resolve(strict=True)
        if not folder.is_dir():
            raise ValueError("请选择文件夹")
        with self.lock:
            if str(folder) not in self.state["roots"]:
                self.state["roots"].append(str(folder))
            self.settings({"current": str(folder)})
        return {"path": str(folder), "roots": self.state["roots"]}

    def remove_folder(self, path):
        with self.lock:
            self.state["roots"] = [root for root in self.state["roots"] if root != path]
            if self.state.get("current", "").startswith(path):
                self.state["current"] = self.state["roots"][0] if self.state["roots"] else ""
            self.settings({})
        return self.state

    def folders(self, path):
        return scanner.children(self.authorize(path))

    def open_folder(self, path, recursive=False):
        folder = self.authorize(path)
        if not folder.is_dir():
            raise ValueError("文件夹不存在")
        job_id = uuid.uuid4().hex
        job = {"id": job_id, "path": str(folder), "state": "scanning", "items": [], "done": 0, "total": 0, "warnings": [], "revision": 0}
        with self.lock:
            for previous in self.jobs.values():
                previous["cancelled"] = True
            self.jobs = {job_id: job}
        self.settings({"current": str(folder), "recursive": recursive})
        threading.Thread(target=self._scan, args=(job, folder, recursive), daemon=True).start()
        return {"job": job_id}

    def _scan(self, job, folder, recursive):
        # One scan at a time prevents old jobs from replacing a newer folder index.
        with self.scan_lock:
            try:
                items, warnings = scanner.scan(folder, recursive)
                if job.get("cancelled"):
                    return
                with self.lock:
                    job.update(items=items, total=len(items), warnings=warnings, state="processing")
                pending = {}
                for item in items:
                    if job.get("cancelled"):
                        break
                    if item.get("ready") and not item.get("error"):
                        job["done"] += 1
                    else:
                        executor = self.raw_pool if item["kind"] == "raw" else self.pool
                        pending[executor.submit(process_item, dict(item))] = item
                for future in as_completed(pending):
                    if job.get("cancelled"):
                        for queued in pending:
                            queued.cancel()
                        break
                    item = pending[future]
                    result = future.result()
                    with self.lock:
                        item.update(result)
                        warning = item.pop("warning", None)
                        if warning and warning not in job["warnings"]:
                            job["warnings"].append(warning)
                        job["done"] += 1
                        job["revision"] += 1
                    self.emit("progress", {"job": job["id"], "done": job["done"], "total": job["total"]})
                if job.get("cancelled"):
                    return
                grouped = {str(folder): {}}
                for item in items:
                    grouped.setdefault(str(Path(item["path"]).parent), {})[item["name"]] = item
                for parent, records in grouped.items():
                    try:
                        cache.save(parent, records)
                    except OSError:
                        job["warnings"].append(f"缓存不可写：{parent}，本次仅使用内存")
                job["state"] = "ready"
            except Exception as exc:
                job.update(state="error", error=str(exc))

    def page(self, job_id, offset=0, limit=200, query="", kind="all", sort="name", descending=False):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise ValueError("浏览任务已失效")
            items = [dict(item) for item in job["items"] if query.casefold() in item["name"].casefold() and (kind == "all" or (kind == "image" and item["kind"] != "video") or item["kind"] == kind)]
            key = sort if sort in {"name", "date", "mtime", "size", "ext"} else "name"
            items.sort(key=lambda item: (str(item[key]).casefold() if key in {"name", "ext"} else item[key], item["path"]), reverse=descending)
            offset = max(0, int(offset))
            result = {key: value for key, value in job.items() if key not in {"items", "cancelled"}}
            result.update(items=items[offset:offset + min(200, max(1, int(limit)))], filtered=len(items))
            return result

    def media_item(self, path):
        actual = self.authorize(path)
        if not actual.is_file() or actual.suffix.lower() not in config.IMAGES | config.VIDEOS:
            raise ValueError("不是受支持的媒体文件")
        stat = actual.stat()
        return {"path": str(actual), "ext": actual.suffix.lower(), "signature": f"{stat.st_mtime_ns}:{stat.st_size}"}

    def clean_cache(self, path, recursive=False):
        folder = self.authorize(path)
        stack = [folder]
        count = 0
        while stack:
            current = stack.pop()
            cache.clean(current)
            count += 1
            if recursive:
                stack.extend(Path(child["path"]) for child in scanner.children(current)["children"])
        return {"count": count}

    def file_action(self, path, action, confirmed=False):
        actual = self.authorize(path)
        if action == "reveal":
            subprocess.Popen(["explorer.exe", "/select,", str(actual)])
        elif action == "open":
            os.startfile(str(actual))
        elif action == "trash":
            if not confirmed or not actual.is_file():
                raise ValueError("删除文件需要确认")
            self.media_item(actual)
            send2trash(str(actual))
        elif action == "copy":
            import ctypes
            from ctypes import wintypes
            user, kernel = ctypes.windll.user32, ctypes.windll.kernel32
            kernel.GlobalAlloc.restype = wintypes.HGLOBAL
            kernel.GlobalLock.argtypes = [wintypes.HGLOBAL]
            kernel.GlobalLock.restype = ctypes.c_void_p
            kernel.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
            kernel.GlobalFree.argtypes = [wintypes.HGLOBAL]
            user.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
            user.SetClipboardData.restype = wintypes.HANDLE
            value = (str(actual) + "\0").encode("utf-16-le")
            handle = kernel.GlobalAlloc(0x0042, len(value))
            if not handle:
                raise OSError("无法分配剪贴板内存")
            pointer = kernel.GlobalLock(handle)
            if not pointer:
                kernel.GlobalFree(handle)
                raise OSError("无法锁定剪贴板内存")
            ctypes.memmove(pointer, value, len(value))
            kernel.GlobalUnlock(handle)
            if not user.OpenClipboard(None):
                kernel.GlobalFree(handle)
                raise OSError("剪贴板被占用，请重试")
            try:
                user.EmptyClipboard()
                if not user.SetClipboardData(13, handle):
                    kernel.GlobalFree(handle)
                    raise OSError("无法写入剪贴板")
            finally:
                user.CloseClipboard()
        else:
            raise ValueError("未知操作")
        return {"ok": True}

    def emit(self, name, payload):
        if self.window:
            try:
                self.window.evaluate_js(f"window.dispatchEvent(new CustomEvent('haven:{name}', {{detail: {json.dumps(payload)}}}))")
            except Exception:
                pass

    def check_update(self, manual=True):
        import updater
        result = updater.check(config.VERSION)
        if result.get("available"):
            self.update = result["manifest"]
            if not manual and self.state.get("skipped_version") == self.update["version"] and not self.update.get("mandatory"):
                return {"available": False}
        return result

    def install_update(self, confirmed=False):
        if not confirmed:
            raise ValueError("更新前需要确认已保存其他工作")
        if not self.update:
            raise ValueError("请先检查更新")
        import sys
        if not getattr(sys, "frozen", False):
            raise ValueError("源码运行模式不能原地更新，请使用打包后的 Haven.exe")
        if self.download_status["state"] == "downloading":
            return self.download_status
        self.download_status = {"state": "downloading", "progress": 0}
        def worker():
            import updater
            try:
                updater.install(self.update, lambda progress: self.download_status.update(progress=progress))
                self.download_status.update(state="restarting")
                if self.window:
                    self.window.destroy()
            except Exception as exc:
                self.download_status.update(state="error", error=str(exc))
        threading.Thread(target=worker, daemon=True).start()
        return self.download_status

    def update_progress(self):
        return self.download_status

    def release_history(self):
        import webbrowser
        webbrowser.open(config.RELEASES)
        return {"ok": True}
