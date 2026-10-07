from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor, as_completed
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import uuid

from send2trash import send2trash
import cache
import config
import metadata
import metadata_store
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


def path_contains(parent, path):
    """True when path is parent itself or lives inside it (Windows-friendly, case-insensitive)."""
    parent = os.path.normcase(os.path.abspath(parent))
    path = os.path.normcase(os.path.abspath(path))
    return path == parent or path.startswith(parent.rstrip("\\/") + os.sep)


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
        self.state.setdefault("glass_transparency", 0.24)
        self.store = metadata_store.MetadataStore(config.METADATA_DB_PATH)
        # Older states could store a folder and its own subfolder as separate roots.
        if self._merge_roots():
            try:
                cache.atomic_json(config.STATE_PATH, self.state)
            except OSError:
                pass
        self.jobs = {}
        self.export_jobs = {}
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
        allowed = {"expanded", "current", "theme", "thumb_size", "auto_update", "skipped_version", "recursive", "glass_transparency", "external_editor", "export_folder", "export_mode", "session"}
        if "export_mode" in changes and changes.get("export_mode") not in {"copy", "move"}:
            raise ValueError("导出模式无效")
        if "session" in changes and changes.get("session") is not None and not isinstance(changes.get("session"), dict):
            raise ValueError("选片会话数据无效")
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
            # A folder inside an already added folder is part of that tree, not a second root.
            if not any(path_contains(root, str(folder)) for root in self.state["roots"]):
                self.state["roots"].append(str(folder))
            self._merge_roots()
            expanded = set(self.state.get("expanded", []))
            expanded.add(str(folder))
            owner = next((root for root in self.state["roots"] if path_contains(root, str(folder)) and os.path.normcase(root) != os.path.normcase(str(folder))), None)
            if owner:
                expanded.add(owner)
                expanded.update(self._ancestors(str(folder), owner))
            self.state["expanded"] = sorted(expanded)
            self.settings({"current": str(folder)})
        return {"path": str(folder), "roots": self.state["roots"], "expanded": self.state["expanded"]}

    def remove_folder(self, path):
        with self.lock:
            self.state["roots"] = [root for root in self.state["roots"] if root != path]
            self._merge_roots()
            if self.state.get("current", "").startswith(path):
                self.state["current"] = self.state["roots"][0] if self.state["roots"] else ""
            self.settings({})
        return self.state

    def _ancestors(self, folder, root):
        """Folders strictly between root and folder, nearest first."""
        steps = []
        current = Path(folder).parent
        while path_contains(root, str(current)) and os.path.normcase(str(current)) != os.path.normcase(root):
            steps.append(str(current))
            if current.parent == current:
                break
            current = current.parent
        return steps

    def _merge_roots(self):
        """Keep the outermost photo folders only, so the sidebar never shows a nested folder twice."""
        merged, nested = [], []
        for root in list(self.state.get("roots", [])):
            if any(path_contains(existing, root) for existing in merged):
                nested.append(root)
                continue
            for existing in [item for item in merged if path_contains(root, item)]:
                merged.remove(existing)
                nested.append(existing)
            merged.append(root)
        if merged == self.state.get("roots", []):
            return False
        self.state["roots"] = merged
        expanded = set(self.state.get("expanded", []))
        for folder in nested:
            owner = next((root for root in merged if path_contains(root, folder)), None)
            if owner and os.path.normcase(owner) != os.path.normcase(folder):
                # Expand the folder that absorbed it, so the nested folder stays visible.
                expanded.add(owner)
                expanded.update(self._ancestors(folder, owner))
        self.state["expanded"] = sorted(expanded)
        return True

    def folders(self, path):
        return scanner.children(self.authorize(path))

    def search_folders(self, query):
        if not isinstance(query, str):
            raise ValueError("搜索内容无效")
        query = query.strip()
        if not query:
            return {"items": [], "truncated": False}
        return scanner.find_folders(self.state["roots"], query)

    def pick_folder(self):
        if self.window is None:
            raise ValueError("文件夹选择仅适用于桌面程序")
        import webview
        selected = self.window.create_file_dialog(webview.FileDialog.FOLDER)
        return {"path": selected[0] if selected else None}

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
                self.store.reconcile(items)
                self.store.enrich(items)
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

    def page(self, job_id, offset=0, limit=200, query="", kind="all", sort="name", descending=False, filters=None):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise ValueError("浏览任务已失效")
            filters = filters or {}
            items = [dict(item) for item in job["items"] if query.casefold() in item["name"].casefold() and (kind == "all" or (kind == "image" and item["kind"] != "video") or item["kind"] == kind) and self._matches_filters(item, filters)]
            key = sort if sort in {"name", "date", "mtime", "size", "ext"} else "name"
            items.sort(key=lambda item: (str(item[key]).casefold() if key in {"name", "ext"} else item[key], item["path"]), reverse=descending)
            offset = max(0, int(offset))
            result = {key: value for key, value in job.items() if key not in {"items", "cancelled"}}
            result.update(items=items[offset:offset + min(200, max(1, int(limit)))], filtered=len(items))
            return result

    @staticmethod
    def _matches_filters(item, filters):
        tags = {str(tag).casefold() for tag in item.get("tags", [])}
        wanted_tags = {str(tag).casefold() for tag in filters.get("tags", [])}
        if wanted_tags and not wanted_tags.issubset(tags):
            return False
        excluded_tags = {str(tag).casefold() for tag in filters.get("tags_not", [])}
        if excluded_tags & tags:
            return False
        if "color_label" in filters and filters["color_label"] and item.get("color_label") != filters["color_label"]:
            return False
        for key in ("favorite", "flagged", "rejected"):
            if key in filters and filters[key] is not None and bool(item.get(key)) != bool(filters[key]):
                return False
        if "rating" in filters:
            rating = item.get("rating")
            value = filters.get("rating")
            operator = filters.get("rating_op", "=")
            if value == "unrated" or operator == "is_empty":
                if rating is not None:
                    return False
            elif rating is None or not isinstance(value, int):
                return False
            elif operator == ">=" and rating < value or operator == "<=" and rating > value or operator == "=" and rating != value:
                return False
        return True

    def media_item(self, path):
        actual = self.authorize(path)
        if not actual.is_file() or actual.suffix.lower() not in config.IMAGES | config.VIDEOS:
            raise ValueError("不是受支持的媒体文件")
        stat = actual.stat()
        return {"path": str(actual), "ext": actual.suffix.lower(), "signature": f"{stat.st_mtime_ns}:{stat.st_size}"}

    def photo_metadata(self, paths):
        authorized = [str(self.authorize(path)) for path in paths]
        return self.store.metadata_for_paths(authorized)

    def update_photo_metadata(self, paths, patch):
        authorized = [str(self.authorize(path)) for path in paths]
        result = self.store.update(authorized, patch)
        by_path = {metadata_store.normalize_path(path): value for path, value in result["metadata"].items()}
        with self.lock:
            for job in self.jobs.values():
                for item in job.get("items", []):
                    value = by_path.get(metadata_store.normalize_path(item.get("path", "")))
                    if value:
                        item.update(value)
        return result

    def list_tags(self):
        return self.store.list_tags()

    def list_smart_albums(self):
        return self.store.smart_albums()

    def create_smart_album(self, name, definition):
        return self.store.save_smart_album(name, definition)

    def update_smart_album(self, album_id, name, definition):
        return self.store.save_smart_album(name, definition, album_id)

    def delete_smart_album(self, album_id):
        self.store.delete_smart_album(album_id)
        return {"ok": True}

    def open_smart_album(self, album_id):
        album = self.store.get_smart_album(album_id)
        job_id = uuid.uuid4().hex
        job = {"id": job_id, "path": f"smart:{album_id}", "state": "scanning", "items": [], "done": 0, "total": 0, "warnings": [], "revision": 0, "smart_album": album}
        with self.lock:
            for previous in self.jobs.values():
                previous["cancelled"] = True
            self.jobs = {job_id: job}
        threading.Thread(target=self._scan_smart, args=(job, album), daemon=True).start()
        return {"job": job_id}

    def _scan_smart(self, job, album):
        with self.scan_lock:
            try:
                items, warnings = [], []
                for root in self.state.get("roots", []):
                    found, extra = scanner.scan(Path(root), True)
                    items.extend(found); warnings.extend(extra)
                self.store.reconcile(items)
                self.store.enrich(items)
                definition = album.get("definition", {})
                logic = definition.get("logic", "and").lower()
                conditions = definition.get("conditions", [])
                def matches(item):
                    values = [self._matches_filters(item, self._condition_filter(condition)) for condition in conditions]
                    return any(values) if logic == "or" else all(values)
                items = [item for item in items if matches(item)]
                processed = []
                for item in items:
                    if job.get("cancelled"):
                        return
                    processed.append(process_item(item))
                items = processed
                with self.lock:
                    job.update(items=items, total=len(items), done=len(items), warnings=warnings, state="ready")
            except Exception as exc:
                job.update(state="error", error=str(exc))

    @staticmethod
    def _condition_filter(condition):
        field = condition.get("field")
        operator = condition.get("operator", "=")
        value = condition.get("value")
        if field == "tags":
            return {"tags": [value]} if operator in {"contains", "="} else {"tags_not": [value]}
        if field == "rating":
            return {"rating": "unrated" if operator == "is_empty" else value, "rating_op": operator}
        if field == "color_label":
            return {"color_label": value}
        if field in {"favorite", "flagged", "rejected"}:
            return {field: bool(value)}
        return {}

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

    @staticmethod
    def _renamed_path(value, old, new):
        if not value or not path_contains(old, value):
            return value
        relative = os.path.relpath(value, old)
        return str(Path(new) if relative == os.curdir else Path(new) / relative)

    @staticmethod
    def _validate_entry_name(name):
        if not isinstance(name, str) or not name or not name.strip():
            raise ValueError("名称不能为空")
        if name in {".", ".."} or "/" in name or "\\" in name:
            raise ValueError("名称只能包含当前目录中的单个文件名")
        if any(ord(char) < 32 or char in '<>:"|?*' for char in name):
            raise ValueError("名称包含 Windows 不允许的字符")
        if name[-1] in {".", " "}:
            raise ValueError("名称不能以空格或句点结尾")
        stem = name.split(".", 1)[0].upper()
        if stem in {"CON", "PRN", "AUX", "NUL"} or stem.startswith(("COM", "LPT")) and stem[3:].isdigit() and 1 <= int(stem[3:]) <= 9:
            raise ValueError("名称是 Windows 保留名称")
        return name

    @staticmethod
    def _clear_file_cache(path):
        cache_root = cache.directory(path.parent, False)
        for folder_name, suffix in (("thumbs", ".webp"), ("previews", ".jpg")):
            target = cache_root / folder_name / (path.name + suffix)
            signature = target.with_suffix(target.suffix + ".json")
            for artifact in (target, signature):
                try:
                    artifact.unlink(missing_ok=True)
                except OSError:
                    pass

    def create_folder(self, parent, name):
        folder = self.authorize(parent)
        if not folder.is_dir():
            raise ValueError("目标不是文件夹")
        if any(part.casefold() == cache.CACHE_NAME.casefold() for part in folder.parts):
            raise PermissionError("不能在 Haven 缓存目录中创建文件夹")
        target = folder / self._validate_entry_name(name)
        if target.exists():
            raise FileExistsError("目标名称已经存在")
        target.mkdir()
        return {"path": str(target), "parent": str(folder), "name": target.name}

    def rename(self, path, name):
        actual = self.authorize(path)
        if actual.name.casefold() == cache.CACHE_NAME.casefold():
            raise PermissionError("不能重命名 Haven 缓存目录")
        self._validate_entry_name(name)
        destination = actual.with_name(name)
        if destination == actual or destination.name.casefold() == actual.name.casefold():
            return {"path": str(actual), "name": actual.name, "old_path": str(actual), "roots": self.state["roots"], "expanded": self.state.get("expanded", []), "current": self.state.get("current", "")}
        if destination.exists():
            raise FileExistsError("目标名称已经存在")
        old_path, new_path = str(actual), str(destination)
        was_directory = actual.is_dir()
        actual.rename(destination)
        if was_directory:
            self.store.rename_prefix(old_path, new_path)
            self.state["roots"] = [self._renamed_path(root, old_path, new_path) for root in self.state["roots"]]
            self.state["expanded"] = sorted({self._renamed_path(folder, old_path, new_path) for folder in self.state.get("expanded", [])})
            self.state["current"] = self._renamed_path(self.state.get("current", ""), old_path, new_path)
            self.settings({})
        else:
            self.store.move_path(old_path, new_path)
            # A renamed file has a different cache key. The next scan creates
            # the new artifacts under the new name.
            self._clear_file_cache(actual)
        return {"path": new_path, "name": destination.name, "old_path": old_path, "roots": self.state["roots"], "expanded": self.state.get("expanded", []), "current": self.state.get("current", "")}

    def move_file(self, path, destination):
        source = self.authorize(path)
        folder = self.authorize(destination)
        if not source.is_file() or source.suffix.lower() not in config.IMAGES | config.VIDEOS:
            raise ValueError("只能移动照片或视频文件")
        if not folder.is_dir():
            raise ValueError("目标不是文件夹")
        if any(part.casefold() == cache.CACHE_NAME.casefold() for part in folder.parts):
            raise PermissionError("不能移动到 Haven 缓存目录")
        target = folder / source.name
        if target == source:
            return {"path": str(source), "old_parent": str(source.parent), "parent": str(folder), "name": source.name}
        if target.exists():
            raise FileExistsError("目标文件夹中已经存在同名文件")
        source_parent = source.parent
        source.rename(target)
        self.store.move_path(str(source), str(target))
        self._clear_file_cache(Path(source_parent / source.name))
        return {"path": str(target), "old_parent": str(source_parent), "parent": str(folder), "name": target.name}

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
            self.store.remove_path(str(actual))
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

    def detect_editors(self):
        """Detect installed photo editors (Photoshop / Lightroom) on Windows."""
        editors = [{"id": "default", "name": "系统默认程序", "exe": None, "available": True}]
        if os.name != "nt":
            return editors
        try:
            import winreg
        except ImportError:
            return editors

        def app_path(exe_name):
            try:
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + exe_name) as key:
                    return winreg.QueryValueEx(key, None)[0]
            except OSError:
                return None

        for editor_id, name, exe_name in (("photoshop", "Adobe Photoshop", "Photoshop.exe"), ("lightroom", "Lightroom Classic", "lightroom.exe")):
            exe = app_path(exe_name)
            if not exe and editor_id == "photoshop":
                exe = self._adobe_install(r"SOFTWARE\Adobe\Photoshop", "ApplicationPath", "Photoshop.exe")
            if not exe and editor_id == "lightroom":
                exe = self._adobe_install(r"SOFTWARE\Adobe\Adobe Lightroom", "InstallDir", "lightroom.exe")
            editors.append({"id": editor_id, "name": name, "exe": exe, "available": bool(exe and Path(exe).is_file())})
        return editors

    @staticmethod
    def _adobe_install(root, value_name, exe_name):
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, root) as key:
                index = 0
                while True:
                    try:
                        subkey = winreg.EnumKey(key, index)
                    except OSError:
                        break
                    index += 1
                    try:
                        with winreg.OpenKey(key, subkey) as child:
                            value, _ = winreg.QueryValueEx(child, value_name)
                        candidate = Path(value) / exe_name
                        if candidate.is_file():
                            return str(candidate)
                    except OSError:
                        continue
        except OSError:
            pass
        return None

    def _resolve_editor_exe(self, editor_id):
        if editor_id == "default":
            return None, "系统默认程序"
        detected = {editor["id"]: editor for editor in self.detect_editors()}
        if editor_id in detected and detected[editor_id].get("available"):
            return detected[editor_id]["exe"], detected[editor_id]["name"]
        configured = self.state.get("external_editor")
        if isinstance(configured, dict) and configured.get("exe") and (configured.get("id") == editor_id or editor_id == "custom"):
            return configured["exe"], configured.get("name", "外部编辑器")
        raise ValueError("未找到该编辑器，请到设置中配置外部编辑器")

    def open_external(self, paths, editor_id="default"):
        actuals = [str(self.authorize(path)) for path in paths]
        if not actuals:
            raise ValueError("没有要打开的照片")
        for path in actuals:
            if not Path(path).is_file() or Path(path).suffix.lower() not in config.IMAGES | config.VIDEOS:
                raise ValueError("只能打开受支持的媒体文件")
        exe, name = self._resolve_editor_exe(editor_id)
        if exe is None:
            for path in actuals:
                os.startfile(path)
        else:
            if not Path(exe).is_file():
                raise ValueError(f"未找到程序：{exe}")
            subprocess.Popen([str(Path(exe)), *actuals])
        result = {"ok": True, "editor": name, "opened": len(actuals)}
        if editor_id == "lightroom":
            result["capability"] = "limited"
            result["hint"] = "Lightroom 批量打开能力有限，建议改用「导出到文件夹」"
        return result

    @staticmethod
    def _validate_export_target(target):
        if not isinstance(target, str) or not target.strip():
            raise ValueError("请选择导出文件夹")
        path = Path(target.strip())
        if path.exists() and not path.is_dir():
            raise ValueError("导出目标不是文件夹")
        if any(part.casefold() == config.CACHE_NAME.casefold() for part in path.parts):
            raise PermissionError("导出文件夹不能位于 Haven 缓存目录内")
        return path

    def export_photos(self, paths, target, options=None):
        options = options or {}
        authorized = [str(self.authorize(path)) for path in paths]
        if not authorized:
            raise ValueError("没有要导出的照片")
        for path in authorized:
            if not Path(path).is_file() or Path(path).suffix.lower() not in config.IMAGES | config.VIDEOS:
                raise ValueError("只能导出受支持的媒体文件")
        target_path = self._validate_export_target(target)
        mode = options.get("mode", self.state.get("export_mode", "copy"))
        if mode not in {"copy", "move"}:
            raise ValueError("导出模式无效")
        collision = options.get("collision", "rename")
        if collision not in {"rename", "skip", "overwrite"}:
            raise ValueError("同名处理方式无效")
        include_companions = bool(options.get("include_companions", False))
        preserve_structure = bool(options.get("preserve_structure", False))
        open_folder_after = bool(options.get("open_folder_after", False))
        roots = [Path(root).resolve() for root in self.state.get("roots", [])]
        job_id = uuid.uuid4().hex
        job = {"id": job_id, "state": "running", "target": str(target_path), "mode": mode, "total": len(authorized), "copied": 0, "moved": 0, "skipped": 0, "failed": 0, "errors": []}
        with self.lock:
            self.export_jobs[job_id] = job

        def worker():
            try:
                self._run_export(job, authorized, target_path, mode, collision, include_companions, preserve_structure, roots)
            except Exception as exc:
                job.update(state="error", error=str(exc))
            finally:
                if open_folder_after and target_path.is_dir():
                    try:
                        os.startfile(str(target_path))
                    except OSError:
                        pass
        threading.Thread(target=worker, daemon=True).start()
        return {"job": job_id}

    def _run_export(self, job, sources, target, mode, collision, include_companions, preserve_structure, roots):
        target.mkdir(parents=True, exist_ok=True)
        pending = self._with_companions(sources) if include_companions else list(sources)
        for source in pending:
            source_path = Path(source)
            relative = self._relative_for(source_path, preserve_structure, roots)
            dest_dir = target if relative is None else target / relative
            dest_dir.mkdir(parents=True, exist_ok=True)
            destination = dest_dir / source_path.name
            if destination.exists():
                if collision == "skip":
                    job["skipped"] += 1
                    job["errors"].append(f"跳过：{source_path.name} 目标已存在")
                    self.emit("export-progress", self._export_snapshot(job))
                    continue
                if collision == "rename":
                    destination = self._renamed_destination(destination)
                else:
                    try:
                        destination.unlink()
                    except OSError as exc:
                        job["failed"] += 1
                        job["errors"].append(f"{source_path.name}: {exc}")
                        self.emit("export-progress", self._export_snapshot(job))
                        continue
            try:
                if mode == "move":
                    shutil.move(str(source_path), str(destination))
                    self.store.move_path(str(source_path), str(destination))
                    self._clear_file_cache(source_path)
                    job["moved"] += 1
                else:
                    shutil.copy2(str(source_path), str(destination))
                    job["copied"] += 1
            except OSError as exc:
                job["failed"] += 1
                job["errors"].append(f"{source_path.name}: {exc}")
            self.emit("export-progress", self._export_snapshot(job))
        job["state"] = "done"
        self.emit("export-progress", self._export_snapshot(job))

    @staticmethod
    def _with_companions(sources):
        ordered, seen = [], set()
        for source in sources:
            path = Path(source)
            for candidate in Api._companion_candidates(path):
                key = os.path.normcase(os.path.abspath(str(candidate)))
                if key not in seen:
                    seen.add(key)
                    ordered.append(str(candidate))
        return ordered

    @staticmethod
    def _companion_candidates(path):
        yield path
        if path.suffix.lower() not in config.IMAGES:
            return
        for ext in config.IMAGES:
            candidate = path.with_suffix(ext)
            if candidate.is_file() and os.path.normcase(str(candidate)) != os.path.normcase(str(path)):
                yield candidate

    @staticmethod
    def _renamed_destination(destination):
        parent, stem, suffix = destination.parent, destination.stem, destination.suffix
        index = 1
        while True:
            candidate = parent / f"{stem} ({index}){suffix}"
            if not candidate.exists():
                return candidate
            index += 1

    @staticmethod
    def _relative_for(path, preserve_structure, roots):
        if not preserve_structure:
            return None
        resolved = Path(path).resolve()
        for root in roots:
            try:
                return resolved.parent.relative_to(root)
            except ValueError:
                continue
        return None

    @staticmethod
    def _export_snapshot(job):
        return {"job": job["id"], "state": job["state"], "target": job["target"], "mode": job["mode"], "total": job["total"], "copied": job.get("copied", 0), "moved": job.get("moved", 0), "skipped": job.get("skipped", 0), "failed": job.get("failed", 0), "errors": list(job.get("errors", [])), "error": job.get("error")}

    def export_progress(self, job_id=None):
        with self.lock:
            if job_id:
                job = self.export_jobs.get(job_id)
            else:
                job = next(iter(self.export_jobs.values()), None) if self.export_jobs else None
        if not job:
            return {"state": "idle"}
        return self._export_snapshot(job)

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
