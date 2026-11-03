"""Shared bilingual (Simplified Chinese / English) message catalogs.

The Python backend and the web UI render text from the same JSON files so the
two sides cannot drift: the backend calls :func:`tr`, while ``server.py``
injects the catalog into ``index.html`` for the UI's ``t()`` helper.

Catalogs live in ``locales/<locale>/*.json`` as flat ``key -> string`` maps.
Fragments are merged, so independent areas (native menu, backend errors, web
UI) can be edited separately. Keys use dot namespaces, values may contain
``{name}`` placeholders, and an optional ``key.one`` entry supplies the English
singular form (the base entry is the generic/plural form; Chinese needs no
``.one`` entry). Unsupported system languages fall back to ``en-US``.
"""
from __future__ import annotations

import json
import os
import re
import subprocess

import config

SUPPORTED = ("en-US", "zh-CN")
FALLBACK = "en-US"
SYSTEM = "system"

_catalogs: dict[str, dict[str, str]] = {}
_preference = SYSTEM
_current = FALLBACK

_PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _fragments(locale):
    """Merge every ``*.json`` fragment of a locale in filename order."""
    directory = config.LOCALES_DIR / locale
    messages = {}
    if not directory.is_dir():
        return messages
    for path in sorted(directory.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict):
            messages.update({str(key): str(value) for key, value in data.items() if isinstance(value, str)})
    return messages


def catalog(locale):
    """Return the (cached) merged catalog for a locale."""
    if locale not in _catalogs:
        _catalogs[locale] = _fragments(locale)
    return _catalogs[locale]


def reload():
    """Drop cached catalogs; used by tests that edit the JSON files."""
    _catalogs.clear()


def system_locale():
    """Best-effort system UI language such as ``zh-Hans-CN`` or ``en-US``."""
    override = os.environ.get("HAVEN_LANGUAGE")
    if override:
        return override
    raw = ""
    if config.IS_MACOS:
        try:
            result = subprocess.run(
                ["defaults", "read", "-g", "AppleLanguages"],
                capture_output=True, text=True, timeout=2,
            )
            for token in re.findall(r'"([^"]+)"', result.stdout):
                raw = token
                break
        except (OSError, subprocess.SubprocessError):
            raw = ""
    elif config.IS_WINDOWS:
        try:
            import ctypes
            import locale as locale_module
            language_id = ctypes.windll.kernel32.GetUserDefaultUILanguage()
            raw = locale_module.windows_locale.get(language_id, "")
        except (AttributeError, OSError):
            raw = ""
    if not raw:
        raw = os.environ.get("LC_ALL") or os.environ.get("LC_MESSAGES") or os.environ.get("LANG") or ""
    if not raw:
        try:
            import locale as locale_module
            language, _ = locale_module.getlocale()
            raw = language or ""
        except (ValueError, TypeError):
            raw = ""
    return raw


def normalize(value):
    """Map a language tag to a supported locale, or ``""`` when unknown."""
    text = str(value or "").strip().replace("_", "-")
    if not text:
        return ""
    parts = []
    for index, part in enumerate(text.split("-")):
        if not part:
            continue
        if index == 0:
            parts.append(part.lower())
        elif len(part) == 2 and part.isalpha():
            parts.append(part.upper())
        elif len(part) == 4 and part.isalpha():
            parts.append(part.title())
        else:
            parts.append(part.lower())
    canonical = "-".join(parts)
    lowered = canonical.lower()
    if lowered.startswith("zh"):
        if any(tag in lowered for tag in ("hant", "tw", "hk", "mo")):
            return "zh-TW"
        return "zh-CN"
    if lowered.startswith("en"):
        return "en-US"
    return canonical


def resolve(preference=None):
    """Resolve a stored preference (``system`` or a locale) to a locale."""
    if preference in SUPPORTED:
        return preference
    normalized = normalize(preference)
    if normalized in SUPPORTED:
        return normalized
    system = normalize(system_locale())
    return system if system in SUPPORTED else FALLBACK


def configure(preference=SYSTEM):
    """Set the active preference and locale; returns the resolved locale."""
    global _preference, _current
    _preference = preference if preference in SUPPORTED or preference == SYSTEM else SYSTEM
    _current = resolve(_preference)
    return _current


def current():
    return _current


def preference():
    return _preference


def is_one(count):
    try:
        return float(count) == 1
    except (TypeError, ValueError):
        return False


def format_message(text, params):
    def replace(match):
        name = match.group(1)
        value = params.get(name)
        return match.group(0) if value is None else str(value)

    return _PLACEHOLDER.sub(replace, text)


def tr(key, **params):
    """Translate ``key`` for the active locale, interpolating ``{params}``.

    Missing keys fall back to English and finally to the key itself, so a missed
    entry shows up clearly instead of blanking the UI.
    """
    messages = catalog(_current)
    text = None
    if "count" in params and is_one(params["count"]):
        text = messages.get(f"{key}.one")
    if text is None:
        text = messages.get(key)
    if text is None and _current != FALLBACK:
        text = catalog(FALLBACK).get(key)
    if text is None:
        return key
    return format_message(text, params)


def payload():
    """Catalog bundle injected into index.html by the local server."""
    messages = catalog(_current)
    fallback = catalog(FALLBACK) if _current != FALLBACK else {}
    return {
        "locale": _current,
        "fallback": FALLBACK,
        "messages": messages,
        "fallbackMessages": fallback,
    }
