"""`aquaman-hermes` console script — install/uninstall the directory plugin.

Hermes loads directory plugins from ``$HERMES_HOME/plugins/<name>/`` (default
``~/.hermes/plugins/<name>/``), each needing a ``plugin.yaml`` + an
``__init__.py`` exporting ``register(ctx)``. The plugin module is stdlib-only
and self-contained, so this installer copies it verbatim as the directory's
``__init__.py``. That means it works under the Hermes interpreter even when the
``aquaman_hermes`` package itself isn't installed in Hermes' environment
(Hermes typically runs in its own ``uv tool`` venv).

Usage:
    aquaman-hermes install      # copy plugin into ~/.hermes/plugins/aquaman/
    aquaman-hermes uninstall    # remove it
    aquaman-hermes status       # show install + enablement state
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

PLUGIN_NAME = "aquaman"


def _hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))


def _plugin_dir() -> Path:
    return _hermes_home() / "plugins" / PLUGIN_NAME


def _bundled(name: str) -> Path:
    return Path(__file__).resolve().parent / name


def cmd_install(_: argparse.Namespace) -> int:
    dest = _plugin_dir()
    dest.mkdir(parents=True, exist_ok=True)
    manifest = _bundled("plugin.yaml")
    module = _bundled("plugin.py")
    if not manifest.is_file() or not module.is_file():
        print(f"error: bundled plugin files missing under {manifest.parent}", file=sys.stderr)
        return 1
    shutil.copyfile(manifest, dest / "plugin.yaml")
    # Copy the stdlib-only module verbatim as the directory's __init__.py so the
    # plugin is self-contained and loads under Hermes' own interpreter.
    shutil.copyfile(module, dest / "__init__.py")
    print(f"✓ Installed aquaman plugin into {dest}")
    print("\nNext steps:")
    print(f"  1. Enable it:        hermes plugins enable {PLUGIN_NAME}")
    print("     (or add 'aquaman' to plugins.enabled in ~/.hermes/config.yaml)")
    print("  2. Wire the proxy:   aquaman hermes setup")
    print("  3. Verify in-session: /aquaman-status")
    return 0


def cmd_uninstall(_: argparse.Namespace) -> int:
    dest = _plugin_dir()
    if dest.exists():
        shutil.rmtree(dest)
        print(f"✓ Removed {dest}")
    else:
        print(f"Nothing to remove at {dest}")
    return 0


def cmd_status(_: argparse.Namespace) -> int:
    dest = _plugin_dir()
    installed = (dest / "plugin.yaml").is_file() and (dest / "__init__.py").is_file()
    print(f"Plugin dir:  {dest}")
    print(f"Installed:   {'yes' if installed else 'no'}")
    if not installed:
        print("Install with: aquaman-hermes install")
        return 1
    print("Enable with:  hermes plugins enable aquaman  (if not already enabled)")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="aquaman-hermes",
        description="Install the aquaman credential-isolation plugin into Hermes.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("install", help="Copy the plugin into ~/.hermes/plugins/aquaman/").set_defaults(func=cmd_install)
    sub.add_parser("uninstall", help="Remove the installed plugin").set_defaults(func=cmd_uninstall)
    sub.add_parser("status", help="Show install + enablement state").set_defaults(func=cmd_status)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
