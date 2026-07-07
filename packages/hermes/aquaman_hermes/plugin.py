"""Hermes plugin entry point for aquaman.

Registers:
  * ``/aquaman-status`` slash command (human-facing) — proxy reachability + wiring.
  * ``aquaman_status`` tool (agent-facing) — same info as structured text.
  * ``on_session_start`` hook — one-shot health probe; logs a warning if the
    aquaman loopback proxy isn't reachable (so a misconfigured session is
    obvious instead of silently falling back to direct provider calls).

The plugin holds no credentials and makes no privileged calls. It only reads the
provider base-URL env vars that aquaman wrote into ``~/.hermes/.env`` and probes
the proxy's ``/_health`` endpoint (which is exempt from the loopback token).
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

logger = logging.getLogger("aquaman_hermes")

# Provider env vars aquaman sets — any one of them tells us where the loopback
# listener lives (scheme://host:port/<service>...).
_BASE_URL_ENV_VARS = ("ANTHROPIC_BASE_URL", "OPENAI_BASE_URL")


def _loopback_origin() -> Optional[str]:
    """Return ``http://host:port`` of the aquaman loopback listener, or None.

    Derived from whichever provider base-URL env var aquaman set. We only keep
    scheme+host+port — the per-service path (``/anthropic`` etc.) is dropped so
    we can hit ``/_health``.
    """
    for var in _BASE_URL_ENV_VARS:
        val = os.environ.get(var)
        if not val:
            continue
        parsed = urlparse(val)
        if parsed.scheme and parsed.hostname:
            port = f":{parsed.port}" if parsed.port else ""
            return f"{parsed.scheme}://{parsed.hostname}{port}"
    return None


def _probe_health(timeout: float = 1.5) -> Tuple[bool, Dict[str, Any]]:
    """Probe the proxy's /_health. Returns (reachable, info)."""
    origin = _loopback_origin()
    if not origin:
        return False, {"reason": "no aquaman base-URL env vars set (run: aquaman hermes setup)"}
    url = f"{origin}/_health"
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (loopback only)
            if resp.status != 200:
                return False, {"origin": origin, "reason": f"HTTP {resp.status}"}
            body = json.loads(resp.read().decode("utf-8"))
            return True, {"origin": origin, **body}
    except urllib.error.URLError as exc:
        return False, {"origin": origin, "reason": f"unreachable ({exc.reason})"}
    except Exception as exc:  # pragma: no cover - defensive
        return False, {"origin": origin, "reason": str(exc)}


def _status_text() -> str:
    """Render a human-readable status block."""
    origin = _loopback_origin()
    wired = [v for v in _BASE_URL_ENV_VARS if os.environ.get(v)]
    reachable, info = _probe_health()

    lines = ["aquaman — credential isolation for Hermes"]
    if not origin:
        lines.append("  ✗ Not wired. No ANTHROPIC_BASE_URL / OPENAI_BASE_URL set.")
        lines.append("    Fix: aquaman hermes setup  (then restart Hermes)")
        return "\n".join(lines)

    lines.append(f"  Loopback proxy: {origin}")
    lines.append(f"  Wired vars:     {', '.join(wired)}")
    if reachable:
        version = info.get("version", "?")
        services = info.get("services", [])
        lines.append(f"  Proxy:          ✓ responding (aquaman-proxy v{version})")
        if services:
            lines.append(f"  Services:       {', '.join(services)}")
        lines.append("  Keys are injected by the proxy — they never enter this process.")
    else:
        lines.append(f"  Proxy:          ✗ {info.get('reason', 'unreachable')}")
        lines.append("    Fix: start the daemon with `aquaman daemon`, then check `aquaman hermes doctor`")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------

def _command_status(raw_args: str = "", **_: Any) -> str:
    """`/aquaman-status` slash command handler."""
    return _status_text()


def _tool_status(args: Optional[dict] = None, **_: Any) -> str:
    """`aquaman_status` tool handler (agent-facing)."""
    return _status_text()


def _on_session_start(**_: Any) -> None:
    """One-shot reachability probe; warn (don't block) if the proxy is down."""
    origin = _loopback_origin()
    if not origin:
        return  # aquaman isn't configured for this Hermes install — stay silent.
    reachable, info = _probe_health()
    if reachable:
        logger.info("aquaman: loopback proxy reachable at %s (keys isolated)", origin)
    else:
        logger.warning(
            "aquaman: loopback proxy at %s is NOT reachable (%s). Provider calls "
            "may fail or fall back to direct keys. Start it with `aquaman daemon`.",
            origin, info.get("reason", "unreachable"),
        )


_TOOL_SCHEMA = {
    "type": "object",
    "properties": {},
    "additionalProperties": False,
}


def register(ctx) -> None:
    """Hermes plugin entry point."""
    ctx.register_command(
        "aquaman-status",
        _command_status,
        description="Show aquaman credential-proxy status (reachability + wiring).",
    )
    try:
        ctx.register_tool(
            name="aquaman_status",
            toolset="aquaman",
            schema=_TOOL_SCHEMA,
            handler=_tool_status,
            description="Report aquaman credential-proxy status: whether the loopback "
                        "proxy is reachable and which provider env vars are wired.",
            emoji="🔱",
        )
    except Exception as exc:  # pragma: no cover - tool registry API drift safety
        logger.debug("aquaman: tool registration skipped (%s)", exc)
    ctx.register_hook("on_session_start", _on_session_start)
    logger.debug("aquaman plugin registered (command + tool + on_session_start)")
