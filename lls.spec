# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for Local LLM Studio — a frozen, portable build that bundles
# the Flask app, its templates/static/vendor assets, and the Ollama engine.
#
# Build:   pyinstaller --noconfirm --clean lls.spec
# CI / the build scripts place the Ollama engine at vendor_bin/ollama[.exe] first.
import os
import sys

from PyInstaller.utils.hooks import collect_submodules

ROOT = os.path.abspath(os.getcwd())
IS_MAC = sys.platform == "darwin"
IS_WIN = sys.platform == "win32"

# --- the bundled Ollama engine (optional: omit for a "needs system Ollama" build) ---
_ollama_name = "ollama.exe" if IS_WIN else "ollama"
_ollama_src = os.path.join(ROOT, "vendor_bin", _ollama_name)
binaries = []
if os.path.exists(_ollama_src):
    binaries.append((_ollama_src, "."))

datas = [
    ("templates", "templates"),
    ("static", "static"),  # includes static/vendor (mermaid, chart.js)
]

hiddenimports = (
    collect_submodules("flask")
    + ["requests", "mcp_bridge", "app", "supervisor", "ollama_runtime"]
)

# Optional app icon (only if present, else PyInstaller errors on a missing path).
_icon = None
for cand in (
    os.path.join("packaging", "icon.icns" if IS_MAC else "icon.ico"),
):
    if os.path.exists(cand):
        _icon = cand
        break

# universal2 needs a universal2 Python + wheels. Set LLS_TARGET_ARCH=universal2 in
# that environment; otherwise build native (and lipo two arches together, or ship
# per-arch DMGs — see PACKAGING.md).
_target_arch = os.environ.get("LLS_TARGET_ARCH") or None

a = Analysis(
    ["lls.py"],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "PyQt5", "PyQt6", "PySide6", "matplotlib", "numpy", "pandas", "scipy", "test", "unittest"],
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Local LLM Studio",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    target_arch=_target_arch,
    codesign_identity=None,  # signed later by the build script / CI
    entitlements_file=None,
    icon=_icon,
)

coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="Local LLM Studio")

if IS_MAC:
    app = BUNDLE(
        coll,
        name="Local LLM Studio.app",
        icon=_icon,
        bundle_identifier="com.localllmstudio.app",
        info_plist={
            "CFBundleName": "Local LLM Studio",
            "CFBundleDisplayName": "Local LLM Studio",
            "CFBundleShortVersionString": os.environ.get("LLS_VERSION", "1.0.0"),
            "CFBundleVersion": os.environ.get("LLS_VERSION", "1.0.0"),
            "NSHighResolutionCapable": True,
            "LSMinimumSystemVersion": "11.0",
            "LSApplicationCategoryType": "public.app-category.developer-tools",
            "LSUIElement": False,
        },
    )
