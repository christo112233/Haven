"""Platform-specific shell and window integration.

All the OS-specific behaviour that the rest of Haven needs lives here:
opening/revealing files, clipboard file copies, photo-editor discovery, entry
name validation, case-insensitive path comparison, subprocess flags and the
native macOS window chrome. Keeping it in one module is what lets the rest of
the codebase stay platform-neutral.
"""
from __future__ import annotations

import ctypes
import json
import os
import struct
import subprocess
from pathlib import Path

import config

IS_WINDOWS = config.IS_WINDOWS
IS_MACOS = config.IS_MACOS
_WINDOWS_INVALID = set('<>:"|?*')
_WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL"}


# -- paths ---------------------------------------------------------------


def path_key(value):
    """Normalized comparison key for a path (case-insensitive on Win/macOS)."""
    text = os.path.normcase(os.path.abspath(os.fspath(value)))
    if IS_MACOS:
        # APFS/HFS+ are case-insensitive by default; comparing case-folded keys
        # mirrors what the filesystem considers the same file.
        text = text.casefold()
    return text


def same_path(first, second):
    return path_key(first) == path_key(second)


def contains_path(parent, path):
    """True when path is parent itself or lives inside it."""
    parent_key = path_key(parent)
    path_key_value = path_key(path)
    return path_key_value == parent_key or path_key_value.startswith(parent_key.rstrip("\\/") + os.sep)


# -- processes -----------------------------------------------------------


def subprocess_flags():
    if IS_WINDOWS and hasattr(subprocess, "CREATE_NO_WINDOW"):
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


# -- shell integration ---------------------------------------------------


def open_path(path):
    if IS_WINDOWS:
        os.startfile(str(path))
    elif IS_MACOS:
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


def reveal_path(path):
    if IS_WINDOWS:
        subprocess.Popen(["explorer.exe", "/select,", str(path)])
    elif IS_MACOS:
        subprocess.Popen(["open", "-R", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(Path(path).parent)])


def open_defaults(paths):
    paths = [str(path) for path in paths]
    if not paths:
        return
    if IS_WINDOWS:
        for path in paths:
            os.startfile(path)
    elif IS_MACOS:
        subprocess.Popen(["open", *paths])
    else:
        subprocess.Popen(["xdg-open", *paths])


def open_with_editor(editor, paths):
    paths = [str(path) for path in paths]
    if not paths:
        return
    if IS_WINDOWS:
        subprocess.Popen([str(editor), *paths])
    elif IS_MACOS:
        subprocess.Popen(["open", "-a", str(editor), *paths])
    else:
        subprocess.Popen([str(editor), *paths])


def copy_text(value):
    """Copy plain text (used by the "copy path" action)."""
    text = str(value)
    if IS_WINDOWS:
        _windows_clipboard_text(text)
    elif IS_MACOS:
        subprocess.run(["/usr/bin/pbcopy"], input=text.encode("utf-8"), check=True)
    else:
        subprocess.run(["xclip", "-selection", "clipboard"], input=text.encode("utf-8"), check=True)


def _windows_clipboard_text(text):
    from ctypes import wintypes

    user, kernel = ctypes.windll.user32, ctypes.windll.kernel32
    kernel.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel.GlobalLock.restype = ctypes.c_void_p
    kernel.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel.GlobalFree.argtypes = [wintypes.HGLOBAL]
    user.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user.SetClipboardData.restype = wintypes.HANDLE
    value = (text + "\0").encode("utf-16-le")
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
        if not user.SetClipboardData(13, handle):  # CF_UNICODETEXT
            kernel.GlobalFree(handle)
            raise OSError("无法写入剪贴板")
    finally:
        user.CloseClipboard()


def copy_files(paths):
    """Put real file references on the clipboard so Explorer/Finder can paste."""
    paths = [str(path) for path in paths]
    if not paths:
        return
    if IS_WINDOWS:
        _windows_clipboard_files(paths)
    elif IS_MACOS:
        _macos_clipboard_files(paths)
    else:
        raise NotImplementedError("当前平台暂不支持复制文件到剪贴板")


def _windows_clipboard_files(paths):
    from ctypes import wintypes

    user, kernel = ctypes.windll.user32, ctypes.windll.kernel32
    kernel.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel.GlobalLock.restype = ctypes.c_void_p
    kernel.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel.GlobalFree.argtypes = [wintypes.HGLOBAL]
    user.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user.SetClipboardData.restype = wintypes.HANDLE
    # DROPFILES header (pFiles=20, pt=0,0, fNC=0, fWide=1) followed by a list of
    # NUL-terminated wide paths and a final extra NUL.
    body = "".join(path + "\0" for path in paths) + "\0"
    value = struct.pack("<IiiII", 20, 0, 0, 0, 1) + body.encode("utf-16-le")
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
        if not user.SetClipboardData(15, handle):  # CF_HDROP
            kernel.GlobalFree(handle)
            raise OSError("无法写入剪贴板")
    finally:
        user.CloseClipboard()


def _macos_clipboard_files(paths):
    quoted = ", ".join(f"POSIX file {json.dumps(str(path), ensure_ascii=False)}" for path in paths)
    if len(paths) == 1:
        script = f"set the clipboard to POSIX file {json.dumps(str(paths[0]), ensure_ascii=False)}"
    else:
        script = f"set the clipboard to {{{quoted}}}"
    subprocess.run(["osascript", "-e", script], check=True, capture_output=True)


# -- photo editors -------------------------------------------------------


def detect_editors():
    editors = [{"id": "default", "name": "系统默认程序", "exe": None, "available": True}]
    if IS_WINDOWS:
        editors.extend(_windows_editors())
    elif IS_MACOS:
        editors.extend(_macos_editors())
    return editors


def _windows_editors():
    editors = []
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
            exe = _windows_adobe_install(r"SOFTWARE\Adobe\Photoshop", "ApplicationPath", "Photoshop.exe")
        if not exe and editor_id == "lightroom":
            exe = _windows_adobe_install(r"SOFTWARE\Adobe\Adobe Lightroom", "InstallDir", "lightroom.exe")
        editors.append({"id": editor_id, "name": name, "exe": exe, "available": bool(exe and Path(exe).is_file())})
    return editors


def _windows_adobe_install(root, value_name, exe_name):
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


def _macos_editors():
    editors = []
    candidates = {
        "photoshop": ("Adobe Photoshop", ["Adobe Photoshop*.app", "*/Adobe Photoshop*.app"]),
        "lightroom": ("Lightroom Classic", ["Adobe Lightroom Classic*.app", "*/Adobe Lightroom Classic*.app", "Adobe Lightroom*.app", "*/Adobe Lightroom*.app"]),
    }
    for editor_id, (name, patterns) in candidates.items():
        found = []
        for base in (Path("/Applications"), Path.home() / "Applications"):
            if not base.is_dir():
                continue
            for pattern in patterns:
                found.extend(base.glob(pattern))
        app = next((path for path in sorted(found) if path.is_dir()), None)
        editors.append({"id": editor_id, "name": name, "exe": str(app) if app else None, "available": bool(app)})
    return editors


# -- entry names ---------------------------------------------------------


def validate_entry_name(name):
    """Validate a file/folder name that must stay safe on both platforms."""
    if not isinstance(name, str) or not name or not name.strip():
        raise ValueError("名称不能为空")
    if name in {".", ".."} or "/" in name or "\\" in name:
        raise ValueError("名称只能包含当前目录中的单个文件名")
    if any(ord(char) < 32 or char in _WINDOWS_INVALID for char in name):
        raise ValueError("名称包含不允许的字符")
    if name[-1] in {".", " "}:
        raise ValueError("名称不能以空格或句点结尾")
    stem = name.split(".", 1)[0].upper()
    if stem in _WINDOWS_RESERVED or (stem.startswith(("COM", "LPT")) and stem[3:].isdigit() and 1 <= int(stem[3:]) <= 9):
        raise ValueError("名称是系统保留名称")
    if len(name.encode("utf-8")) > 255:
        raise ValueError("名称过长（超过 255 字节）")
    return name


# -- macOS window chrome -------------------------------------------------

_MACOS_TITLEBAR_STYLE = None


def _on_main_thread(action):
    """Run AppKit work on the main thread (pywebview events fire on workers)."""
    try:
        from PyObjCTools import AppHelper
        AppHelper.callAfter(action)
        return True
    except Exception:
        return False


def configure_macos_window(window):
    """Keep the standard macOS title bar (draggable, native traffic lights).

    Earlier attempts used a transparent, full-size title bar for an edge-to-edge
    look, but adding ``NSWindowStyleMaskFullSizeContentView`` after window
    creation left the title bar behind the web view: neither the system title
    bar nor the background could drag the window. A normal title bar is the
    reliable macOS behaviour, and the in-app toolbar/brand regions still drag
    via ``drag_window``.
    """
    if not IS_MACOS or window is None:
        return False
    native = getattr(window, "native", None)
    if native is None:
        return False

    def apply():
        try:
            native.setTitle_("Haven")
            native.setMovable_(True)
            native.setMovableByWindowBackground_(False)
            for name in ("closeButton", "miniaturizeButton", "zoomButton"):
                button = getattr(native, name, lambda: None)()
                if button is not None:
                    button.setHidden_(False)
        except Exception:
            pass

    return _on_main_thread(apply)


def move_window_by(window, dx, dy):
    """Move a macOS window by a screen-coordinate delta (used by custom drag)."""
    if not IS_MACOS or window is None:
        return False
    native = getattr(window, "native", None)
    if native is None:
        return False

    def apply():
        try:
            import AppKit
            origin = native.frame().origin
            native.setFrameOrigin_(AppKit.NSPoint(origin.x + dx, origin.y - dy))
        except Exception:
            pass

    return _on_main_thread(apply)


def macos_zoom(window):
    """Standard green-button zoom (not fullscreen)."""
    native = getattr(window, "native", None)
    if native is not None and _on_main_thread(lambda: native.zoom_(None)):
        return True
    try:
        window.maximize()
        return True
    except Exception:
        return False
