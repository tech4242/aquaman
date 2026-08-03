"""Shared fixtures: a faithful fake of the Hermes secret-source contract
(shapes copied from the hermes-agent 0.19.0 wheel's
``agent/secret_sources/base.py``, api v1, plus the per-fetch environment view
added on `main` after 0.19.0), injected into sys.modules so the suite stays
stdlib-only with no Hermes install.

For the real contract — the actual ABC and orchestrator from an installed
hermes-agent — see ``test_conformance.py``, which is skipped unless
hermes-agent is present."""

import os
import re
import sys
import types
from contextvars import ContextVar
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Dict, List, Optional

import pytest


def install_fake_hermes_base(monkeypatch, *, with_env_view: bool = False):
    class ErrorKind(str, Enum):
        NOT_CONFIGURED = "not_configured"
        BINARY_MISSING = "binary_missing"
        AUTH_FAILED = "auth_failed"
        AUTH_EXPIRED = "auth_expired"
        REF_INVALID = "ref_invalid"
        NETWORK = "network"
        EMPTY_VALUE = "empty_value"
        TIMEOUT = "timeout"
        INTERNAL = "internal"

    @dataclass
    class FetchResult:
        secrets: Dict[str, str] = field(default_factory=dict)
        applied: List[str] = field(default_factory=list)
        skipped: List[str] = field(default_factory=list)
        warnings: List[str] = field(default_factory=list)
        error: Optional[str] = None
        error_kind: Optional[ErrorKind] = None
        binary_path: Optional[Path] = None

        @property
        def ok(self):
            return self.error is None

    DEFAULT_FETCH_TIMEOUT_SECONDS = 120.0

    class SecretSource:
        api_version = 1
        name = ""
        label = ""
        shape = "mapped"
        scheme = None

        def fetch(self, cfg, home_path):  # pragma: no cover - abstract stand-in
            raise NotImplementedError

        # Optional-hook defaults, copied from the real base so a source that
        # does NOT override one is exercised the same way Hermes exercises it.
        def is_enabled(self, cfg):
            return bool(isinstance(cfg, dict) and cfg.get("enabled"))

        def override_existing(self, cfg):
            return bool(isinstance(cfg, dict) and cfg.get("override_existing", False))

        def protected_env_vars(self, cfg):
            return frozenset()

        def fetch_timeout_seconds(self, cfg):
            try:
                val = float((cfg or {}).get("timeout_seconds"))
            except Exception:
                return DEFAULT_FETCH_TIMEOUT_SECONDS
            return val if val > 0 else DEFAULT_FETCH_TIMEOUT_SECONDS

        def config_schema(self):
            return {}

        def remediation(self, kind, cfg):
            return ""

    _ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

    def is_valid_env_name(name):
        return bool(name) and bool(_ENV_NAME_RE.match(name))

    base = types.ModuleType("agent.secret_sources.base")
    base.ErrorKind = ErrorKind
    base.FetchResult = FetchResult
    base.SecretSource = SecretSource
    base.is_valid_env_name = is_valid_env_name
    base.SECRET_SOURCE_API_VERSION = 1
    base.DEFAULT_FETCH_TIMEOUT_SECONDS = DEFAULT_FETCH_TIMEOUT_SECONDS

    # Per-fetch environment view. Absent on 0.18.x and on released 0.19.0;
    # present on Hermes `main`. Gated so the suite can prove the plugin works
    # on BOTH host shapes rather than only the newest one.
    if with_env_view:
        _source_environment = ContextVar(
            "hermes_secret_source_environment", default=None
        )

        def set_source_environment(environ):
            return _source_environment.set(environ)

        def reset_source_environment(token):
            _source_environment.reset(token)

        def get_source_environment():
            environ = _source_environment.get()
            return environ if environ is not None else os.environ

        base.set_source_environment = set_source_environment
        base.reset_source_environment = reset_source_environment
        base.get_source_environment = get_source_environment

    agent_pkg = types.ModuleType("agent")
    sources_pkg = types.ModuleType("agent.secret_sources")
    monkeypatch.setitem(sys.modules, "agent", agent_pkg)
    monkeypatch.setitem(sys.modules, "agent.secret_sources", sources_pkg)
    monkeypatch.setitem(sys.modules, "agent.secret_sources.base", base)
    return base


@pytest.fixture()
def hermes_base(monkeypatch):
    """Released-0.19.0 shape: no per-fetch environment view."""
    return install_fake_hermes_base(monkeypatch)


@pytest.fixture()
def hermes_base_env_view(monkeypatch):
    """Post-0.19.0 `main` shape: ContextVar per-fetch environment view."""
    return install_fake_hermes_base(monkeypatch, with_env_view=True)
