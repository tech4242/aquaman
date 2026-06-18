"""aquaman-hermes — credential-isolation plugin for the Hermes agent host.

This is the optional "sugar" layer for the aquaman ↔ Hermes integration. The
actual credential isolation is done entirely by the aquaman proxy (the loopback
listener) plus the provider env vars in ``~/.hermes/.env`` — this plugin adds
in-session visibility: an ``aquaman-status`` slash command, an ``aquaman_status``
agent tool, and an ``on_session_start`` health check that warns if the proxy
isn't reachable.

See ``aquaman_hermes.plugin.register`` for the Hermes plugin entry point.
"""

from .plugin import register  # noqa: F401

__version__ = "0.13.0"
__all__ = ["register", "__version__"]
