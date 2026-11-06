from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor, as_completed
import json
import os
from pathlib import Path
import shutil
import threading
import uuid

from send2trash import send2trash
import cache
import config
import i18n
import library
import metadata
import metadata_store
import platform_support
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
    """True when path is parent itself or lives inside it (platform-aware)."""
    return platform_support.contains_path(parent, path)


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
        # Light table look, remembered per machine (not photo data).
        self.state.setdefault("lighttable_lamp", True)
        self.state.setdefault("lighttable_brightness", 1.0)
        self.state.setdefault("lighttable_sound", True)
        self.state.setdefault("lighttable_temperature", 5000)
        self.state.setdefault("library_dir", "")
        self.state.setdefault("root_ids", {})
        # Device-local UI language ("system", "zh-CN" or "en-US"); never synced
        # through the shared annotation library because it is a machine/use
        # preference rather than photo data.
        self.state.setdefault("language", i18n.SYSTEM)
        i18n.configure(self.state["language"])
        # Older states could store a folder and its own subfolder as separate roots.
        if self._merge_roots():
            try:
                cache.atomic_json(config.STATE_PATH, self.state)
            except OSError:
                pass
        self.library_warning = ""
        self._open_library()
        self.jobs = {}
        self.export_jobs = {}
        self.lock = threading.RLock()
        self.scan_lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 4), thread_name_prefix="haven-media")
        self.raw_pool = ProcessPoolExecutor(max_workers=min(4, os.cpu_count() or 1))
        self.update = None
        self.download_status = {"state": "idle"}
        # Mirrors the frontend selection/viewer state for the macOS menu's
        # dynamic enable/checkmark logic.
        self.menu_snapshot = {"selection": 0, "viewer": False, "path": None, "sidebar": True}

    def _data_dir(self):
        return Path(config.STATE_PATH).parent

    def _open_library(self):
        """Open the annotation library, migrating a legacy local database."""
        data_dir = self._data_dir()
        data_dir.mkdir(parents=True, exist_ok=True)
        configured = str(self.state.get("library_dir") or "").strip()
        directory = Path(configured).expanduser() if configured else data_dir / "library"
        try:
            info = library.ensure_library(directory)
        except OSError as exc:
            self.library_warning = i18n.tr("backend.warning.library-dir-unavailable", error=exc)
            directory = data_dir / "library"
            info = library.ensure_library(directory)
        self.library_dir = directory
        self.library_id = info["library_id"]
        self._register_roots()
        legacy_db = data_dir / "haven-metadata.sqlite3"
        db_path = library.database_path(directory)
        try:
            library.adopt_database(legacy_db, db_path)
        except Exception as exc:  # noqa: BLE001 - surface any copy failure as a warning
            self.library_warning = self.library_warning or i18n.tr("backend.warning.library-migrate-failed", error=exc)
        self.store = metadata_store.MetadataStore(
            db_path,
            roots=self.state["roots"],
            root_ids=self.root_ids,
            shared=library.is_shared_location(directory, data_dir),
        )
        if self.store.migration_report:
            report = self.store.migration_report
            if report.get("unmatched"):
                self.library_warning = self.library_warning or i18n.tr("backend.warning.library-unmatched", count=report["unmatched"])
        try:
            library.maybe_backup(db_path, directory)
        except OSError:
            pass

    def _register_roots(self):
        """Resolve a stable root_id for every configured photo root."""
        cached = self.state.get("root_ids", {})
        resolved = {}
        changed = False
        for root in self.state.get("roots", []):
            key = str(root)
            marker = None
            try:
                marker = library.ensure_root_marker(key, self.library_id)
            except OSError:
                marker = None
            if marker and marker.get("root_id"):
                resolved[key] = marker["root_id"]
            else:
                root_id = cached.get(key) or uuid.uuid4().hex
                resolved[key] = root_id
                changed = True
        if resolved != cached:
            self.state["root_ids"] = resolved
            changed = True
        self.root_ids = resolved
        if changed:
            try:
                cache.atomic_json(config.STATE_PATH, self.state)
            except OSError:
                pass
        return resolved

    def _sync_store_roots(self):
        self._register_roots()
        if getattr(self, "store", None) is not None:
            self.store.set_roots(self.state["roots"], self.root_ids)

    def _library_payload(self):
        return {
            "dir": str(self.library_dir),
            "id": self.library_id,
            "shared": library.is_shared_location(self.library_dir, self._data_dir()),
            "warning": self.library_warning,
        }

    def bootstrap(self):
        platform = "macos" if config.IS_MACOS else "windows" if config.IS_WINDOWS else "linux"
        return {
            "state": self.state,
            "version": config.VERSION,
            "base_url": self.base_url,
            "desktop": self.window is not None,
            "platform": platform,
            "locale": i18n.current(),
            "language": self.state.get("language", i18n.SYSTEM),
            "library": self._library_payload(),
        }

    def set_language(self, language):
        """Switch the UI language immediately (the page is reloaded by the UI)."""
        if language not in (*i18n.SUPPORTED, i18n.SYSTEM):
            raise ValueError(i18n.tr("error.invalid-language"))
        with self.lock:
            self.state["language"] = language
            try:
                cache.atomic_json(config.STATE_PATH, self.state)
            except OSError:
                pass
            i18n.configure(language)
        if config.IS_MACOS and self.window is not None:
            try:
                import macos_menu
                macos_menu.refresh(self.window, self)
            except Exception:
                pass
        return {"language": self.state["language"], "locale": i18n.current(), "reload": True}

    def library_info(self):
        return self._library_payload()

    def set_library_dir(self, path):
        """Move the annotation library to a user-selected directory.

        The next machine that points at the same directory (for example a NAS
        folder) reads and writes the same ratings, tags and smart albums.
        """
        target = Path(str(path or "").strip()).expanduser() if str(path or "").strip() else self._data_dir() / "library"
        target = target.resolve()
        if target == self.library_dir.resolve():
            return self._library_payload()
        info = library.ensure_library(target)
        new_db = library.database_path(target)
        if not new_db.exists():
            library.adopt_database(library.database_path(self.library_dir), new_db)
        previous = self.store
        previous_dir, previous_id = self.library_dir, self.library_id
        try:
            previous.close()
            self.library_dir = target
            self.library_id = info["library_id"]
            self._register_roots()
            self.store = metadata_store.MetadataStore(
                new_db,
                roots=self.state["roots"],
                root_ids=self.root_ids,
                shared=library.is_shared_location(target, self._data_dir()),
            )
        except Exception:
            # Restore the previous library so the session stays usable.
            self.library_dir, self.library_id = previous_dir, previous_id
            self._register_roots()
            self.store = metadata_store.MetadataStore(
                library.database_path(previous_dir),
                roots=self.state["roots"],
                root_ids=self.root_ids,
                shared=library.is_shared_location(previous_dir, self._data_dir()),
            )
            raise
        self.state["library_dir"] = str(target)
        try:
            cache.atomic_json(config.STATE_PATH, self.state)
        except OSError as exc:
            return {"warning": i18n.tr("backend.warning.library-settings-save", error=exc), **self._library_payload()}
        return self._library_payload()

    def window_action(self, action):
        if self.window is None:
            raise ValueError(i18n.tr("backend.error.window-action-desktop"))
        if action == "minimize":
            self.window.minimize()
        elif action == "maximize":
            if platform_support.IS_MACOS:
                platform_support.macos_zoom(self.window)
            elif self._maximized:
                self.window.restore()
                self._maximized = False
            else:
                self.window.maximize()
                self._maximized = True
        elif action == "close":
            self.window.destroy()
        else:
            raise ValueError(i18n.tr("backend.error.window-action-unknown"))
        return {"ok": True}

    def close(self):
        """Release the SQLite connections and worker pools (used on shutdown)."""
        try:
            self.store.close()
        except Exception:
            pass
        self.pool.shutdown(wait=False, cancel_futures=True)
        self.raw_pool.shutdown(wait=False, cancel_futures=True)

    def menu_state(self, selection=0, viewer=False, path="", sidebar=True):
        try:
            count = max(0, int(selection))
        except (TypeError, ValueError):
            count = 0
        self.menu_snapshot = {
            "selection": count,
            "viewer": bool(viewer),
            "path": str(path) if path else None,
            "sidebar": bool(sidebar),
        }
        return {"ok": True}

    def drag_window(self, dx, dy):
        if not platform_support.IS_MACOS or self.window is None:
            return {"ok": False}
        moved = platform_support.move_window_by(self.window, float(dx), float(dy))
        return {"ok": bool(moved)}

    def resize_window(self, width, height):
        if self.window is None:
            raise ValueError(i18n.tr("backend.error.window-resize-desktop"))
        self.window.resize(max(800, min(3840, int(width))), max(560, min(2160, int(height))))
        return {"ok": True}

    def settings(self, changes):
        allowed = {"expanded", "current", "theme", "thumb_size", "auto_update", "skipped_version", "recursive", "glass_transparency", "external_editor", "export_folder", "export_mode", "session", "stack", "stack_base_gap", "stack_factor", "lighttable_lamp", "lighttable_brightness", "lighttable_sound", "lighttable_temperature"}
        if "export_mode" in changes and changes.get("export_mode") not in {"copy", "move"}:
            raise ValueError(i18n.tr("backend.error.export-mode"))
        if "session" in changes and changes.get("session") is not None and not isinstance(changes.get("session"), dict):
            raise ValueError(i18n.tr("backend.error.culling-session"))
        if "lighttable_brightness" in changes:
            try:
                brightness = float(changes["lighttable_brightness"])
            except (TypeError, ValueError):
                brightness = 1.0
            changes["lighttable_brightness"] = min(1.6, max(0.2, brightness))
        for key in ("lighttable_lamp", "lighttable_sound"):
            if key in changes:
                changes[key] = bool(changes[key])
        if "lighttable_temperature" in changes:
            try:
                temperature = float(changes["lighttable_temperature"])
            except (TypeError, ValueError):
                temperature = 5000
            changes["lighttable_temperature"] = min(6500, max(3000, temperature))
        for key in ("stack_base_gap", "stack_factor"):
            if key in changes:
                try:
                    if float(changes[key]) <= 0:
                        raise ValueError(i18n.tr("backend.error.stack-threshold"))
                except (TypeError, ValueError):
                    raise ValueError(i18n.tr("backend.error.stack-threshold"))
        with self.lock:
            self.state.update({key: value for key, value in changes.items() if key in allowed})
            try:
                cache.atomic_json(config.STATE_PATH, self.state)
            except OSError as exc:
                return {"warning": i18n.tr("backend.warning.settings-save", error=exc)}
        return {"ok": True}

    def authorize(self, value):
        path = Path(value).resolve(strict=True)
        for root in self.state["roots"]:
            try:
                path.relative_to(Path(root).resolve())
                return path
            except ValueError:
                continue
        raise PermissionError(i18n.tr("backend.error.path-not-in-library"))

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
            raise ValueError(i18n.tr("backend.error.choose-folder"))
        with self.lock:
            # A folder inside an already added folder is part of that tree, not a second root.
            if not any(path_contains(root, str(folder)) for root in self.state["roots"]):
                self.state["roots"].append(str(folder))
            self._merge_roots()
            expanded = set(self.state.get("expanded", []))
            expanded.add(str(folder))
            owner = next((root for root in self.state["roots"] if path_contains(root, str(folder)) and not platform_support.same_path(root, str(folder))), None)
            if owner:
                expanded.add(owner)
                expanded.update(self._ancestors(str(folder), owner))
            self.state["expanded"] = sorted(expanded)
            self._sync_store_roots()
            self.settings({"current": str(folder)})
        return {"path": str(folder), "roots": self.state["roots"], "expanded": self.state["expanded"]}

    def remove_folder(self, path):
        with self.lock:
            self.state["roots"] = [root for root in self.state["roots"] if root != path]
            self._merge_roots()
            if self.state.get("current", "").startswith(path):
                self.state["current"] = self.state["roots"][0] if self.state["roots"] else ""
            self._sync_store_roots()
            self.settings({})
        return self.state

    @staticmethod
    def _public_item(item):
        return {key: value for key, value in item.items() if key != "file_key" and not key.startswith("_")}

    def _is_root(self, path):
        return any(platform_support.same_path(root, path) for root in self.state.get("roots", []))

    def _ancestors(self, folder, root):
        """Folders strictly between root and folder, nearest first."""
        steps = []
        current = Path(folder).parent
        while path_contains(root, str(current)) and not platform_support.same_path(str(current), root):
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
            if owner and not platform_support.same_path(owner, folder):
                # Expand the folder that absorbed it, so the nested folder stays visible.
                expanded.add(owner)
                expanded.update(self._ancestors(folder, owner))
        self.state["expanded"] = sorted(expanded)
        return True

    def folders(self, path):
        return scanner.children(self.authorize(path))

    def search_folders(self, query):
        if not isinstance(query, str):
            raise ValueError(i18n.tr("backend.error.search-query"))
        query = query.strip()
        if not query:
            return {"items": [], "truncated": False}
        return scanner.find_folders(self.state["roots"], query)

    def pick_folder(self):
        if self.window is None:
            raise ValueError(i18n.tr("backend.error.folder-picker-desktop"))
        import webview
        selected = self.window.create_file_dialog(webview.FileDialog.FOLDER)
        return {"path": selected[0] if selected else None}

    def open_folder(self, path, recursive=False):
        folder = self.authorize(path)
        if not folder.is_dir():
            raise ValueError(i18n.tr("backend.error.folder-missing"))
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
                        job["warnings"].append(i18n.tr("backend.warning.cache-readonly", path=parent))
                job["state"] = "ready"
            except Exception as exc:
                job.update(state="error", error=str(exc))

    def page(self, job_id, offset=0, limit=200, query="", kind="all", sort="name", descending=False, filters=None, stack=False):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise ValueError(i18n.tr("backend.error.browse-job-expired"))
            filters = filters or {}
            items = [self._public_item(item) for item in job["items"] if query.casefold() in item["name"].casefold() and (kind == "all" or (kind == "image" and item["kind"] != "video") or item["kind"] == kind) and self._matches_filters(item, filters)]
            if stack:
                items = [item for item in self._group_stacks(items) if item.get("stack_cover")]
            else:
                key = sort if sort in {"name", "date", "mtime", "size", "ext"} else "name"
                items.sort(key=lambda item: (str(item[key]).casefold() if key in {"name", "ext"} else item[key], item["path"]), reverse=descending)
            offset = max(0, int(offset))
            result = {key: value for key, value in job.items() if key not in {"items", "cancelled"}}
            result.update(items=items[offset:offset + min(200, max(1, int(limit)))], filtered=len(items))
            return result

    @staticmethod
    def _exposure_seconds(item):
        shutter = item.get("shutter")
        if not shutter:
            return 0.0
        text = str(shutter)
        try:
            if "/" in text:
                numerator, denominator = text.split("/", 1)
                return float(numerator) / float(denominator)
            return float(text)
        except (ValueError, ZeroDivisionError):
            return 0.0

    def _group_stacks(self, items):
        """Adaptive time-based burst grouping into stacks."""
        if not items:
            return items
        base_gap = float(self.state.get("stack_base_gap", 2.0) or 2.0)
        factor = float(self.state.get("stack_factor", 1.5) or 1.5)
        date_key = lambda item: (item.get("date") or 0, item.get("path", ""))
        ordered = sorted(items, key=date_key)
        stacks = []
        if ordered:
            current = [ordered[0]]
            previous = ordered[0]
            for item in ordered[1:]:
                gap = (item.get("date") or 0) - (previous.get("date") or 0)
                threshold = max(base_gap, self._exposure_seconds(previous) * factor)
                if gap <= threshold:
                    current.append(item)
                else:
                    stacks.append(current)
                    current = [item]
                previous = item
            stacks.append(current)
        for stack_id, stack in enumerate(stacks):
            member_paths = [member.get("path", "") for member in stack] if len(stack) > 1 else None
            for position, item in enumerate(stack):
                item["stack_id"] = stack_id
                item["stack_size"] = len(stack)
                item["stack_cover"] = position == 0
                if position == 0 and member_paths is not None:
                    item["stack_members"] = member_paths
        return [item for stack in stacks for item in stack]

    def stack_items(self, job_id, stack_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise ValueError(i18n.tr("backend.error.browse-job-expired"))
            items = [self._public_item(item) for item in job["items"]]
        ordered = self._group_stacks(items)
        return [item for item in ordered if item.get("stack_id") == stack_id]

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
            raise ValueError(i18n.tr("backend.error.media-unsupported"))
        stat = actual.stat()
        return {"path": str(actual), "ext": actual.suffix.lower(), "signature": cache.signature(stat)}

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
        return platform_support.validate_entry_name(name)

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
            raise ValueError(i18n.tr("backend.error.target-not-folder"))
        if any(part.casefold() == cache.CACHE_NAME.casefold() for part in folder.parts):
            raise PermissionError(i18n.tr("backend.error.create-in-cache"))
        target = folder / self._validate_entry_name(name)
        if target.exists():
            raise FileExistsError(i18n.tr("backend.error.name-exists"))
        target.mkdir()
        return {"path": str(target), "parent": str(folder), "name": target.name}

    def rename(self, path, name):
        actual = self.authorize(path)
        if actual.name.casefold() == cache.CACHE_NAME.casefold():
            raise PermissionError(i18n.tr("backend.error.rename-cache"))
        self._validate_entry_name(name)
        destination = actual.with_name(name)
        if destination == actual or destination.name.casefold() == actual.name.casefold():
            return {"path": str(actual), "name": actual.name, "old_path": str(actual), "roots": self.state["roots"], "expanded": self.state.get("expanded", []), "current": self.state.get("current", "")}
        if destination.exists():
            raise FileExistsError(i18n.tr("backend.error.name-exists"))
        old_path, new_path = str(actual), str(destination)
        was_directory = actual.is_dir()
        was_root = self._is_root(old_path)
        old_identity = self.store.identity(old_path) if was_directory else None
        actual.rename(destination)
        if was_directory:
            if not was_root:
                new_identity = self.store.identity(new_path)
                if old_identity and new_identity and old_identity[0] == new_identity[0]:
                    self.store.rename_prefix(old_identity[0], old_identity[1], new_identity[1])
            self.state["roots"] = [self._renamed_path(root, old_path, new_path) for root in self.state["roots"]]
            self.state["expanded"] = sorted({self._renamed_path(folder, old_path, new_path) for folder in self.state.get("expanded", [])})
            self.state["current"] = self._renamed_path(self.state.get("current", ""), old_path, new_path)
            self._sync_store_roots()
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
            raise ValueError(i18n.tr("backend.error.move-media-only"))
        if not folder.is_dir():
            raise ValueError(i18n.tr("backend.error.target-not-folder"))
        if any(part.casefold() == cache.CACHE_NAME.casefold() for part in folder.parts):
            raise PermissionError(i18n.tr("backend.error.move-to-cache"))
        target = folder / source.name
        if target == source:
            return {"path": str(source), "old_parent": str(source.parent), "parent": str(folder), "name": source.name}
        if target.exists():
            raise FileExistsError(i18n.tr("backend.error.move-target-exists"))
        source_parent = source.parent
        source.rename(target)
        self.store.move_path(str(source), str(target))
        self._clear_file_cache(Path(source_parent / source.name))
        return {"path": str(target), "old_parent": str(source_parent), "parent": str(folder), "name": target.name}

    def file_action(self, path, action, confirmed=False):
        actual = self.authorize(path)
        if action == "reveal":
            platform_support.reveal_path(actual)
        elif action == "open":
            platform_support.open_path(actual)
        elif action == "trash":
            if not confirmed or not actual.is_file():
                raise ValueError(i18n.tr("backend.error.delete-confirm"))
            self.media_item(actual)
            send2trash(str(actual))
            self.store.remove_path(str(actual))
        elif action == "copy":
            platform_support.copy_text(str(actual))
        else:
            raise ValueError(i18n.tr("backend.error.action-unknown"))
        return {"ok": True}

    def _rejected_in_folder(self, folder, recursive):
        folder_key = platform_support.path_key(str(folder))
        results = []
        for candidate in self.store.rejected_paths():
            actual = Path(candidate)
            if not path_contains(str(folder), str(actual)):
                continue
            if not recursive and platform_support.path_key(str(actual.parent)) != folder_key:
                continue
            results.append(actual)
        return results

    def count_rejected(self, path, recursive=False):
        folder = self.authorize(path)
        if not folder.is_dir():
            raise ValueError(i18n.tr("backend.error.folder-missing"))
        return {"count": len(self._rejected_in_folder(folder, recursive))}

    def trash_rejected(self, path, recursive=False, confirmed=False):
        if not confirmed:
            raise ValueError(i18n.tr("backend.error.trash-confirm"))
        folder = self.authorize(path)
        if not folder.is_dir():
            raise ValueError(i18n.tr("backend.error.folder-missing"))
        count = 0
        for actual in self._rejected_in_folder(folder, recursive):
            if not actual.is_file():
                self.store.remove_path(str(actual))
                continue
            send2trash(str(actual))
            self.store.remove_path(str(actual))
            count += 1
        return {"count": count}

    def detect_editors(self):
        """Detect installed photo editors (Photoshop / Lightroom) on this platform."""
        return platform_support.detect_editors()

    def _resolve_editor_exe(self, editor_id):
        if editor_id == "default":
            return None, i18n.tr("backend.editor.system-default")
        detected = {editor["id"]: editor for editor in self.detect_editors()}
        if editor_id in detected and detected[editor_id].get("available"):
            return detected[editor_id]["exe"], detected[editor_id]["name"]
        configured = self.state.get("external_editor")
        if isinstance(configured, dict) and configured.get("exe") and (configured.get("id") == editor_id or editor_id == "custom"):
            return configured["exe"], configured.get("name", i18n.tr("backend.editor.external"))
        raise ValueError(i18n.tr("backend.error.editor-not-found"))

    @staticmethod
    def _is_editor_program(path):
        candidate = Path(path)
        return candidate.is_file() or (platform_support.IS_MACOS and candidate.is_dir())

    def open_external(self, paths, editor_id="default"):
        actuals = [str(self.authorize(path)) for path in paths]
        if not actuals:
            raise ValueError(i18n.tr("backend.error.open-no-photos"))
        for path in actuals:
            if not Path(path).is_file() or Path(path).suffix.lower() not in config.IMAGES | config.VIDEOS:
                raise ValueError(i18n.tr("backend.error.open-media-only"))
        exe, name = self._resolve_editor_exe(editor_id)
        if exe is None:
            platform_support.open_defaults(actuals)
        else:
            if not self._is_editor_program(exe):
                raise ValueError(i18n.tr("backend.error.program-not-found", path=exe))
            platform_support.open_with_editor(exe, actuals)
        result = {"ok": True, "editor": name, "opened": len(actuals)}
        if editor_id == "lightroom":
            result["capability"] = "limited"
            result["hint"] = i18n.tr("backend.hint.lightroom-limited")
        return result

    @staticmethod
    def _validate_export_target(target):
        if not isinstance(target, str) or not target.strip():
            raise ValueError(i18n.tr("backend.error.export-target-missing"))
        path = Path(target.strip())
        if path.exists() and not path.is_dir():
            raise ValueError(i18n.tr("backend.error.export-target-not-folder"))
        if any(part.casefold() == config.CACHE_NAME.casefold() for part in path.parts):
            raise PermissionError(i18n.tr("backend.error.export-target-cache"))
        return path

    def export_photos(self, paths, target, options=None):
        options = options or {}
        authorized = [str(self.authorize(path)) for path in paths]
        if not authorized:
            raise ValueError(i18n.tr("backend.error.export-no-photos"))
        for path in authorized:
            if not Path(path).is_file() or Path(path).suffix.lower() not in config.IMAGES | config.VIDEOS:
                raise ValueError(i18n.tr("backend.error.export-media-only"))
        target_path = self._validate_export_target(target)
        mode = options.get("mode", self.state.get("export_mode", "copy"))
        if mode not in {"copy", "move"}:
            raise ValueError(i18n.tr("backend.error.export-mode"))
        collision = options.get("collision", "rename")
        if collision not in {"rename", "skip", "overwrite"}:
            raise ValueError(i18n.tr("backend.error.export-collision"))
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
                        platform_support.open_path(target_path)
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
                    job["errors"].append(i18n.tr("backend.error.export-skip", name=source_path.name))
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
                key = platform_support.path_key(str(candidate))
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
            if candidate.is_file() and not platform_support.same_path(str(candidate), str(path)):
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
            raise ValueError(i18n.tr("backend.error.update-confirm"))
        if not self.update:
            raise ValueError(i18n.tr("backend.error.update-check-first"))
        import sys
        if not getattr(sys, "frozen", False):
            raise ValueError(i18n.tr("backend.error.update-unfrozen"))
        if self.download_status["state"] == "downloading":
            return self.download_status
        self.download_status = {"state": "downloading", "progress": 0}
        def worker():
            try:
                progress = lambda value: self.download_status.update(progress=value)
                if platform_support.IS_MACOS:
                    import updater_macos
                    updater_macos.install(self.update, progress)
                else:
                    import updater
                    updater.install(self.update, progress)
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
