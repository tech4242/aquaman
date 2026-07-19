"""Hermes plugin entry point for aquaman.

Registers:
  * ``/aquaman-status`` slash command (human-facing) — proxy reachability + wiring.
  * ``aquaman_status`` tool (agent-facing) — same info as structured text.
  * ``on_session_start`` hook — one-shot health probe; logs a warning if the
    aquaman loopback proxy isn't reachable (so a misconfigured session is
    obvious instead of silently falling back to direct provider calls).
  * ``aquaman`` secret source (Hermes >= 0.18.1, feature-detected via
    ``hasattr(ctx, "register_secret_source")``) — resolves explicit
    ``ENV_VAR: aquaman://service/key`` bindings from ``secrets.aquaman.env``
    in Hermes' config.yaml through the proxy's token-gated loopback
    ``/broker/resolve`` endpoint.

Security model split (deliberate — keep it this way):
  * **LLM provider keys** (ANTHROPIC_API_KEY / OPENAI_API_KEY) flow through the
    loopback *proxy* path: Hermes holds only a placeholder, the proxy injects
    the real key upstream. Process-isolated. The secret source REFUSES to
    resolve bindings for these vars so the isolation can't be accidentally
    (or maliciously, via a poisoned config.yaml) downgraded.
  * **Project/tool secrets** (GitHub tokens, DB URLs, ...) have no base-URL
    lever in Hermes, so the secret source materializes them into Hermes'
    process env at startup — same residency as any Hermes secret source
    (this is NOT process isolation, and the docs say so), but backed by the
    user's own vault with per-read hash-chained audit instead of a plaintext
    ``.env`` line.

The command/tool/hook surface holds no credentials. The secret source holds
them only transiently while handing them to Hermes' orchestrator.
"""

from __future__ import annotations

import json
import logging
import os
import re
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


# ---------------------------------------------------------------------------
# Secret source (Hermes >= 0.18.1 — agent.secret_sources contract, api v1)
# ---------------------------------------------------------------------------

# Same grammar as aquaman-coder's projects.yaml refs and the proxy's
# SAFE_SERVICE_NAME / key validation in daemon.ts.
_AQUAMAN_REF_RE = re.compile(
    r"^aquaman://(?P<service>[a-z0-9][a-z0-9._-]*)/(?P<key>[a-zA-Z0-9][a-zA-Z0-9._-]*)$"
)
_DEFAULT_TOKEN_ENV = "AQUAMAN_LOOPBACK_TOKEN"
_DEFAULT_LOOPBACK_URL = "http://127.0.0.1:8585"
_DEFAULT_REQUEST_TIMEOUT = 5.0

# LLM provider keys stay on the loopback-proxy path (placeholder in Hermes'
# env, real key injected proxy-side — process isolation). The secret source
# refuses to resolve bindings for them so a config.yaml edit can't silently
# downgrade the isolation to env materialization.
_PROXY_ISOLATED_VARS: Dict[str, str] = {
    "ANTHROPIC_API_KEY": "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY": "OPENAI_BASE_URL",
}
_LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")


def _wired_placeholder_vars() -> "frozenset[str]":
    """Provider api-key vars currently wired as loopback placeholders.

    A provider key var is a placeholder (not a real credential) exactly when
    its base-URL var points at a loopback host — i.e. aquaman's proxy path is
    active for that provider. Those vars must not be overwritten by ANY secret
    source: a real key there would leak into Hermes' env AND break the
    proxy's token gate (the placeholder IS the loopback token).
    """
    wired = set()
    for key_var, url_var in _PROXY_ISOLATED_VARS.items():
        parsed = urlparse(os.environ.get(url_var) or "")
        if parsed.hostname in _LOOPBACK_HOSTS:
            wired.add(key_var)
    return frozenset(wired)


def _scrub_secret_text(text: str, cfg: Optional[dict] = None) -> str:
    """Remove the loopback token from text destined for Hermes' startup log.

    Error/warning strings in a FetchResult are logged by Hermes at startup —
    they must never carry the token, even when an unexpected exception message
    embeds it (urllib errors can echo request headers).
    """
    names = {_DEFAULT_TOKEN_ENV}
    if isinstance(cfg, dict) and cfg.get("token_env"):
        names.add(str(cfg["token_env"]))
    for name in names:
        value = os.environ.get(name)
        if value:
            text = text.replace(value, "[REDACTED:loopback-token]")
    return text


def _broker_resolve_http(
    origin: str, token: str, service: str, key: str, timeout: float
) -> Tuple[Optional[str], Optional[str], Optional[int]]:
    """POST /broker/resolve on the loopback listener.

    Returns ``(value, error, http_status)`` — exactly one of value/error is
    set. Module-level so tests can monkeypatch it. Never raises for HTTP-level
    failures; lets URLError/timeout propagate for the caller to classify.
    """
    payload = json.dumps({"service": service, "key": key}).encode("utf-8")
    req = urllib.request.Request(
        f"{origin}/broker/resolve",
        data=payload,
        headers={"content-type": "application/json", "x-aquaman-token": token},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (loopback only)
            body = json.loads(resp.read().decode("utf-8"))
            return body.get("value"), None, resp.status
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8"))
            message = detail.get("error") or f"HTTP {exc.code}"
            if detail.get("fix"):
                message += f" (fix: {detail['fix']})"
        except Exception:
            message = f"HTTP {exc.code}"
        return None, message, exc.code


def build_secret_source():
    """Construct the ``aquaman`` SecretSource instance, or None.

    Returns None when the host has no secret-source contract (Hermes <
    0.18.1) or the import shape drifted — callers treat None as "sugar-only
    mode", never an error.
    """
    try:
        from agent.secret_sources.base import (  # type: ignore[import-not-found]
            ErrorKind,
            FetchResult,
            SecretSource,
            is_valid_env_name,
        )
    except Exception:
        return None

    class AquamanSource(SecretSource):
        """Mapped source: explicit ENV_VAR → aquaman://service/key bindings.

        Contract compliance (agent/secret_sources/base.py, api v1):
        fetch() never raises, never prompts, never writes os.environ —
        it returns what it WOULD contribute and the orchestrator applies.
        No disk cache: the proxy is local and fast, and caching resolved
        values to disk would defeat aquaman's residency posture.
        """

        api_version = 1
        name = "aquaman"
        label = "Aquaman Proxy"
        shape = "mapped"
        scheme = "aquaman"

        def override_existing(self, cfg: dict) -> bool:
            # Mirror the built-in 1Password source: an explicit
            # VAR→aquaman:// binding is the strongest user intent there is.
            return bool(isinstance(cfg, dict) and cfg.get("override_existing", True))

        def protected_env_vars(self, cfg: dict):
            token_env = _DEFAULT_TOKEN_ENV
            if isinstance(cfg, dict):
                token_env = str(cfg.get("token_env") or token_env)
            return frozenset({token_env}) | _wired_placeholder_vars()

        def fetch(self, cfg: dict, home_path) -> "FetchResult":
            cfg = cfg if isinstance(cfg, dict) else {}
            try:
                result = self._fetch(cfg)
            except Exception as exc:  # contract: never raise
                result = FetchResult(
                    error=f"aquaman source internal error: {exc}",
                    error_kind=ErrorKind.INTERNAL,
                )
            # Startup-log hygiene: whatever we surface, the token stays out.
            if result.error:
                result.error = _scrub_secret_text(result.error, cfg)
            result.warnings = [_scrub_secret_text(w, cfg) for w in result.warnings]
            return result

        def _fetch(self, cfg: dict) -> "FetchResult":
            env_map = cfg.get("env")
            if not isinstance(env_map, dict) or not env_map:
                return FetchResult(
                    error="no env bindings configured — add secrets.aquaman.env "
                          "{ENV_VAR: aquaman://service/key} to config.yaml",
                    error_kind=ErrorKind.NOT_CONFIGURED,
                )

            token_env = str(cfg.get("token_env") or _DEFAULT_TOKEN_ENV)
            token = os.environ.get(token_env)
            if not token:
                return FetchResult(
                    error=f"{token_env} is not set — run: aquaman hermes setup "
                          "(writes the loopback token into ~/.hermes/.env)",
                    error_kind=ErrorKind.NOT_CONFIGURED,
                )

            origin = str(
                cfg.get("base_url")
                or os.environ.get("AQUAMAN_LOOPBACK_URL")
                or _loopback_origin()
                or _DEFAULT_LOOPBACK_URL
            ).rstrip("/")
            timeout = float(cfg.get("request_timeout_seconds") or _DEFAULT_REQUEST_TIMEOUT)

            secrets: Dict[str, str] = {}
            warnings = []
            for var, ref in sorted(env_map.items()):
                var = str(var)
                if not is_valid_env_name(var):
                    warnings.append(f"invalid env var name {var!r} — skipped")
                    continue
                if var in _PROXY_ISOLATED_VARS:
                    warnings.append(
                        f"{var} is refused by the aquaman source: LLM provider keys "
                        "stay process-isolated on the loopback proxy path (the "
                        f"placeholder in ~/.hermes/.env). Remove the {var} binding "
                        "from secrets.aquaman.env."
                    )
                    continue
                match = _AQUAMAN_REF_RE.match(str(ref))
                if not match:
                    warnings.append(
                        f"{var}: invalid ref {ref!r} (expected aquaman://service/key) — skipped"
                    )
                    continue

                service, key = match.group("service"), match.group("key")
                try:
                    value, error, status = _broker_resolve_http(origin, token, service, key, timeout)
                except urllib.error.URLError as exc:
                    reason = getattr(exc, "reason", exc)
                    if isinstance(reason, TimeoutError) or isinstance(exc, TimeoutError):
                        return FetchResult(
                            secrets=secrets, warnings=warnings,
                            error=f"aquaman proxy timed out at {origin}",
                            error_kind=ErrorKind.TIMEOUT,
                        )
                    # Proxy down means every remaining ref fails identically —
                    # abort instead of warning N times.
                    return FetchResult(
                        secrets=secrets, warnings=warnings,
                        error=f"aquaman proxy not reachable at {origin} ({reason}) — "
                              "start it with: aquaman daemon",
                        error_kind=ErrorKind.NETWORK,
                    )
                except TimeoutError:
                    return FetchResult(
                        secrets=secrets, warnings=warnings,
                        error=f"aquaman proxy timed out at {origin}",
                        error_kind=ErrorKind.TIMEOUT,
                    )

                if error is not None:
                    if status in (401, 403):
                        return FetchResult(
                            secrets=secrets, warnings=warnings,
                            error=f"aquaman loopback token rejected ({error}) — "
                                  "re-run: aquaman hermes setup",
                            error_kind=ErrorKind.AUTH_FAILED,
                        )
                    # 404 / 400 / 500 are per-ref problems: one bad ref never
                    # sinks the rest (mirrors the built-in 1Password source).
                    warnings.append(f"{var} ({service}/{key}): {error}")
                    continue
                if not value:
                    warnings.append(
                        f"{var} ({service}/{key}): resolved to an empty value — skipped "
                        "(applying it would clobber a good .env/shell credential)"
                    )
                    continue
                secrets[var] = value

            return FetchResult(secrets=secrets, warnings=warnings)

    return AquamanSource()


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

    # Hermes >= 0.18.1: register aquaman as a secret source for project/tool
    # secrets. Feature-detected (hasattr is the documented probe); on older
    # hosts the plugin stays sugar-only. Registration failures are logged and
    # swallowed — the secret source must never break plugin load.
    if hasattr(ctx, "register_secret_source"):
        source = build_secret_source()
        if source is not None:
            try:
                ctx.register_secret_source(source)
                logger.debug("aquaman secret source registered")
            except Exception as exc:  # pragma: no cover - registry API drift safety
                logger.debug("aquaman: secret-source registration skipped (%s)", exc)

    logger.debug("aquaman plugin registered (command + tool + on_session_start)")
