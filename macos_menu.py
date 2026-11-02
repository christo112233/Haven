"""Native macOS menu bar for Haven.

pywebview's cross-platform menu API cannot express keyboard shortcuts,
checkmarks or dynamic enable/disable, so the macOS menu is built directly with
AppKit. It is installed after the window has loaded (on the main thread) and
talks to the web UI through ``haven:menu`` events; anything that blocks (file
dialogs, clipboard calls) runs on a worker thread so the menu action never
freezes the AppKit run loop.
"""
from __future__ import annotations

import json
import threading

import objc
import AppKit
from AppKit import NSMenu, NSMenuItem, NSObject

import config
from PyObjCTools import AppHelper

_INSTALLED = []

COMMAND = AppKit.NSCommandKeyMask
SHIFT = AppKit.NSShiftKeyMask
OPTION = AppKit.NSAlternateKeyMask
CONTROL = AppKit.NSControlKeyMask


def install(window, api):
    """Install the native menu after the window exists (macOS only)."""
    if not config.IS_MACOS or window is None:
        return False

    def build():
        try:
            menu = _Menu.alloc().initWithWindow_api_(window, api)
            # NSMenuItem.target and NSMenu.delegate are weak references; keep the
            # target alive for the lifetime of the app.
            _INSTALLED.append(menu)
            menu.install()
        except Exception:
            # A broken menu must never prevent the app from running.
            pass

    AppHelper.callAfter(build)
    return True


def _item(menu, title, action="", key="", mask=None, target=None, represented=None, submenu=None):
    item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(title, action, key)
    if mask is not None:
        item.setKeyEquivalentModifierMask_(mask)
    if target is not None:
        item.setTarget_(target)
    if represented is not None:
        item.setRepresentedObject_(represented)
    if submenu is not None:
        item.setSubmenu_(submenu)
    menu.addItem_(item)
    return item


class _Menu(NSObject):
    def initWithWindow_api_(self, window, api):
        self = objc.super(_Menu, self).init()
        if self is None:
            return None
        self.window = window
        self.api = api
        self.app = AppKit.NSApplication.sharedApplication()
        self.appearance_menu = None
        self.sidebar_item = None
        self.menu = None
        return self

    # -- construction ---------------------------------------------------

    @objc.python_method
    def install(self):
        NSApp = self.app
        main = NSMenu.alloc().init()

        # Application menu
        app_item = NSMenuItem.alloc().init()
        app_menu = NSMenu.alloc().init()
        app_menu.setTitle_("Haven")
        app_item.setSubmenu_(app_menu)
        main.addItem_(app_item)

        _item(app_menu, "关于 Haven", "showAbout:", target=self)
        app_menu.addItem_(NSMenuItem.separatorItem())
        _item(app_menu, "设置…", "handleMenu:", key=",", target=self, represented="settings")
        _item(app_menu, "检查更新…", "handleMenu:", target=self, represented="updates")
        app_menu.addItem_(NSMenuItem.separatorItem())
        services = NSMenu.alloc().init()
        services.setTitle_("服务")
        NSApp.setServicesMenu_(services)
        services_item = NSMenuItem.alloc().init()
        services_item.setTitle_("服务")
        services_item.setSubmenu_(services)
        app_menu.addItem_(services_item)
        app_menu.addItem_(NSMenuItem.separatorItem())
        _item(app_menu, "隐藏 Haven", "hide:", key="h")
        _item(app_menu, "隐藏其他", "hideOtherApplications:", key="h", mask=COMMAND | OPTION)
        _item(app_menu, "全部显示", "unhideAllApplications:")
        app_menu.addItem_(NSMenuItem.separatorItem())
        _item(app_menu, "退出 Haven", "handleMenu:", key="q", target=self, represented="quit")

        # File menu
        file_menu = self._submenu(main, "文件")
        _item(file_menu, "添加文件夹…", "handleMenu:", key="o", target=self, represented="add-folder")
        _item(file_menu, "重新扫描当前目录", "handleMenu:", key="r", target=self, represented="rescan")
        file_menu.addItem_(NSMenuItem.separatorItem())
        _item(file_menu, "关闭窗口", "performClose:", key="w")

        # Edit menu (standard responder-chain actions + copy path)
        edit_menu = self._submenu(main, "编辑")
        _item(edit_menu, "撤销", "undo:", key="z")
        _item(edit_menu, "重做", "redo:", key="z", mask=COMMAND | SHIFT)
        edit_menu.addItem_(NSMenuItem.separatorItem())
        _item(edit_menu, "剪切", "cut:", key="x")
        _item(edit_menu, "复制", "copy:", key="c")
        _item(edit_menu, "粘贴", "paste:", key="v")
        _item(edit_menu, "全选", "selectAll:", key="a")
        edit_menu.addItem_(NSMenuItem.separatorItem())
        _item(edit_menu, "复制文件路径", "handleMenu:", key="c", mask=COMMAND | SHIFT, target=self, represented="copy-path")

        # View menu
        view_menu = self._submenu(main, "显示")
        self.sidebar_item = _item(view_menu, "显示/隐藏侧边栏", "handleMenu:", key="s", mask=COMMAND | OPTION, target=self, represented="sidebar")
        view_menu.addItem_(NSMenuItem.separatorItem())
        appearance_item = NSMenuItem.alloc().init()
        appearance_item.setTitle_("外观")
        self.appearance_menu = NSMenu.alloc().init()
        self.appearance_menu.setTitle_("外观")
        self.appearance_menu.setDelegate_(self)
        appearance_item.setSubmenu_(self.appearance_menu)
        view_menu.addItem_(appearance_item)
        for value, title in (("system", "跟随系统"), ("light", "浅色"), ("dark", "深色")):
            _item(self.appearance_menu, title, "handleMenu:", target=self, represented=f"theme-{value}")
        view_menu.addItem_(NSMenuItem.separatorItem())
        _item(view_menu, "进入全屏", "toggleFullScreen:", key="f", mask=COMMAND | CONTROL)

        # Window menu (standard macOS conventions)
        window_menu = self._submenu(main, "窗口")
        _item(window_menu, "最小化", "performMiniaturize:", key="m")
        _item(window_menu, "缩放", "performZoom:")
        window_menu.addItem_(NSMenuItem.separatorItem())
        _item(window_menu, "前置全部窗口", "arrangeInFront:", target=NSApp)

        # Help menu
        help_menu = self._submenu(main, "帮助")
        _item(help_menu, "Haven 开源仓库", "handleMenu:", target=self, represented="repository")
        _item(help_menu, "快捷键说明", "handleMenu:", target=self, represented="shortcuts")

        NSApp.setMainMenu_(main)
        self.menu = main

    @objc.python_method
    def _submenu(self, main_menu, title):
        menu = NSMenu.alloc().init()
        menu.setTitle_(title)
        item = NSMenuItem.alloc().init()
        item.setTitle_(title)
        item.setSubmenu_(menu)
        main_menu.addItem_(item)
        return menu

    # -- state / validation ---------------------------------------------

    def menuNeedsUpdate_(self, menu):
        if menu == self.appearance_menu:
            current = self.api.state.get("theme", "dark")
            for item in menu.itemArray():
                value = str(item.representedObject() or "")
                item.setState_(1 if value == f"theme-{current}" else 0)
        if self.sidebar_item is not None:
            self.sidebar_item.setState_(0 if self.api.menu_snapshot.get("sidebar") else 1)

    def validateMenuItem_(self, item):
        represented = str(item.representedObject() or "")
        if represented == "copy-path":
            return bool(self.api.menu_snapshot.get("path"))
        if represented == "rescan":
            return bool(self.api.state.get("current"))
        return True

    # -- actions ---------------------------------------------------------

    def showAbout_(self, sender):
        options = {
            AppKit.NSAboutPanelOptionApplicationName: "Haven",
            AppKit.NSAboutPanelOptionApplicationVersion: config.VERSION,
            AppKit.NSAboutPanelOptionVersion: config.VERSION,
            AppKit.NSAboutPanelOptionCopyright: f"MIT License · v{config.VERSION}",
        }
        self.app.orderFrontStandardAboutPanelWithOptions_(options)

    def handleMenu_(self, sender):
        command = str(sender.representedObject() or "")
        if command.startswith("theme-"):
            self._dispatch({"type": "theme", "value": command.removeprefix("theme-")})
        elif command == "settings":
            self._dispatch({"type": "settings"})
        elif command == "rescan":
            self._dispatch({"type": "rescan"})
        elif command == "sidebar":
            self._dispatch({"type": "toggle-sidebar"})
        elif command == "add-folder":
            self._background(self._add_folder)
        elif command == "copy-path":
            path = self.api.menu_snapshot.get("path")
            if path:
                self._background(self._copy_path, path)
        elif command == "updates":
            self._dispatch({"type": "check-updates"})
        elif command == "repository":
            self._dispatch({"type": "external", "value": config.RELEASES})
        elif command == "shortcuts":
            self._dispatch({"type": "shortcuts"})
        elif command == "quit":
            self._background(self._quit)

    # -- helpers ---------------------------------------------------------

    @objc.python_method
    def _dispatch(self, payload):
        script = "window.dispatchEvent(new CustomEvent('haven:menu',{detail:%s}))" % json.dumps(payload, ensure_ascii=False)
        self._background(self._js, script)

    @objc.python_method
    def _js(self, script):
        try:
            self.window.evaluate_js(script)
        except Exception:
            pass

    @objc.python_method
    def _background(self, function, *args):
        threading.Thread(target=function, args=args, daemon=True).start()

    @objc.python_method
    def _toast(self, message):
        self._js("window.dispatchEvent(new CustomEvent('haven:toast',{detail:%s}))" % json.dumps(message, ensure_ascii=False))

    @objc.python_method
    def _add_folder(self):
        try:
            result = self.api.add_folder()
        except Exception as exc:
            self._toast(f"添加文件夹失败：{exc}")
            return
        if result and not result.get("cancelled") and result.get("roots"):
            self.api.emit("folder-added", result)

    @objc.python_method
    def _copy_path(self, path):
        try:
            self.api.file_action(path, "copy")
            self._toast("已复制文件路径")
        except Exception as exc:
            self._toast(f"复制失败：{exc}")

    @objc.python_method
    def _quit(self):
        try:
            self.window.destroy()
        except Exception:
            pass
