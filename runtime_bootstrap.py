#!/usr/bin/env python3
"""Stable frozen runtime entry point.

PyInstaller freezes Python and native dependencies into runtime/.  The actual
application remains in ../tool, so future releases replace only that folder.
"""
from __future__ import annotations

import os
import runpy
import sys
from pathlib import Path


def main() -> int:
    runtime_dir = Path(sys.executable).resolve().parent
    bundle_root = runtime_dir.parent.parent if runtime_dir.name == "_internal" else runtime_dir.parent
    tool_dir = bundle_root / "tool"
    entry = tool_dir / "enhanced_server.py"
    if not entry.is_file():
        print(f"[ERROR] Tool entry was not found: {entry}")
        input("Press Enter to close...")
        return 2
    os.chdir(tool_dir)
    os.environ["FLIPBOOK_TOOL_ROOT"] = str(tool_dir)
    os.environ["FLIPBOOK_BUNDLE_ROOT"] = str(bundle_root)
    sys.path.insert(0, str(tool_dir))
    sys.argv = [str(entry), *sys.argv[1:]]
    runpy.run_path(str(entry), run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
