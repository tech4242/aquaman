"""Shared fixtures: a faithful fake of the Hermes >= 0.18.1 secret-source
contract (shapes copied from hermes-agent v2026.7.7.2
``agent/secret_sources/base.py``, api v1), injected into sys.modules so the
suite stays stdlib-only with no Hermes install."""

import re
import sys
import types
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Dict, List, Optional

import pytest


def install_fake_hermes_base(monkeypatch):
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

    class SecretSource:
        api_version = 1
        name = ""
        label = ""
        shape = "mapped"
        scheme = None

        def fetch(self, cfg, home_path):  # pragma: no cover - abstract stand-in
            raise NotImplementedError

    _ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

    def is_valid_env_name(name):
        return bool(name) and bool(_ENV_NAME_RE.match(name))

    base = types.ModuleType("agent.secret_sources.base")
    base.ErrorKind = ErrorKind
    base.FetchResult = FetchResult
    base.SecretSource = SecretSource
    base.is_valid_env_name = is_valid_env_name
    base.SECRET_SOURCE_API_VERSION = 1

    agent_pkg = types.ModuleType("agent")
    sources_pkg = types.ModuleType("agent.secret_sources")
    monkeypatch.setitem(sys.modules, "agent", agent_pkg)
    monkeypatch.setitem(sys.modules, "agent.secret_sources", sources_pkg)
    monkeypatch.setitem(sys.modules, "agent.secret_sources.base", base)
    return base


@pytest.fixture()
def hermes_base(monkeypatch):
    return install_fake_hermes_base(monkeypatch)
