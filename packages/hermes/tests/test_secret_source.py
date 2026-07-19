"""Unit tests for the aquaman Hermes secret source (Hermes >= 0.18.1 contract).

The real `agent.secret_sources.base` lives inside a Hermes install; these
tests inject a faithful fake (shapes copied from hermes-agent v2026.7.7.2
`agent/secret_sources/base.py`, api v1) into sys.modules so the tests run
stdlib-only, exactly like the rest of this suite.
"""

import json
import threading
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from aquaman_hermes import plugin


# The fake `agent.secret_sources.base` module (Hermes >= 0.18.1 contract)
# comes from conftest.py's `hermes_base` fixture.


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in (
        "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL",
        "AQUAMAN_LOOPBACK_URL", "AQUAMAN_LOOPBACK_TOKEN",
    ):
        monkeypatch.delenv(var, raising=False)


TOKEN = "aqm_lb_" + "e" * 48


def _cfg(env=None, **extra):
    cfg = {"enabled": True, "env": env or {}}
    cfg.update(extra)
    return cfg


# ---------------------------------------------------------------------------
# Availability / registration
# ---------------------------------------------------------------------------

def test_build_returns_none_without_hermes_contract():
    # No agent.secret_sources.base importable (pre-0.18.1 host) → sugar-only.
    assert plugin.build_secret_source() is None


def test_build_returns_source_with_contract(hermes_base):
    source = plugin.build_secret_source()
    assert source is not None
    assert source.name == "aquaman"
    assert source.scheme == "aquaman"
    assert source.shape == "mapped"
    assert source.api_version == 1


def test_register_feature_detects_secret_source(hermes_base):
    class Ctx:
        def __init__(self):
            self.commands = {}
            self.tools = {}
            self.hooks = {}
            self.sources = []

        def register_command(self, name, handler, **kw):
            self.commands[name] = handler

        def register_tool(self, name, toolset, schema, handler, **kw):
            self.tools[name] = handler

        def register_hook(self, name, cb):
            self.hooks[name] = cb

        def register_secret_source(self, source):
            self.sources.append(source)

    ctx = Ctx()
    plugin.register(ctx)
    assert len(ctx.sources) == 1
    assert ctx.sources[0].name == "aquaman"


def test_register_on_old_host_without_secret_sources():
    class OldCtx:
        def register_command(self, name, handler, **kw):
            pass

        def register_tool(self, name, toolset, schema, handler, **kw):
            pass

        def register_hook(self, name, cb):
            pass

    # No register_secret_source attr and no hermes modules — must not raise.
    plugin.register(OldCtx())


# ---------------------------------------------------------------------------
# fetch() behavior (broker HTTP stubbed at the module seam)
# ---------------------------------------------------------------------------

def _stub_broker(monkeypatch, values=None, errors=None, exc=None):
    """Replace plugin._broker_resolve_http. values: {'service/key': value}."""
    calls = []

    def fake(origin, token, service, key, timeout):
        calls.append({"origin": origin, "token": token, "ref": f"{service}/{key}"})
        if exc is not None:
            raise exc
        ref = f"{service}/{key}"
        if errors and ref in errors:
            message, status = errors[ref]
            return None, message, status
        if values and ref in values:
            return values[ref], None, 200
        return None, f"No credential found for {ref}", 404

    monkeypatch.setattr(plugin, "_broker_resolve_http", fake)
    return calls


def test_fetch_resolves_bindings(hermes_base, monkeypatch):
    monkeypatch.setenv("AQUAMAN_LOOPBACK_TOKEN", TOKEN)
    monkeypatch.setenv("AQUAMAN_LOOPBACK_URL", "http://127.0.0.1:8585")
    calls = _stub_broker(monkeypatch, values={
        "github/token": "ghp_real", "supabase/db_url": "postgres://real",
    })
    source = plugin.build_secret_source()
    result = source.fetch(_cfg({
        "GITHUB_TOKEN": "aquaman://github/token",
        "DATABASE_URL": "aquaman://supabase/db_url",
    }), Path("/tmp"))
    assert result.ok
    assert result.secrets == {"GITHUB_TOKEN": "ghp_real", "DATABASE_URL": "postgres://real"}
    assert result.warnings == []
    assert all(c["origin"] == "http://127.0.0.1:8585" and c["token"] == TOKEN for c in calls)


def test_fetch_not_configured_without_env_map(hermes_base):
    source = plugin.build_secret_source()
    result = source.fetch(_cfg(), Path("/tmp"))
    assert not result.ok
    assert result.error_kind.value == "not_configured"
    assert "secrets.aquaman.env" in result.error


def test_fetch_not_configured_without_token(hermes_base, monkeypatch):
    _stub_broker(monkeypatch)
    source = plugin.build_secret_source()
    result = source.fetch(_cfg({"X": "aquaman://github/token"}), Path("/tmp"))
    assert not result.ok
    assert result.error_kind.value == "not_configured"
    assert "aquaman hermes setup" in result.error


def test_fetch_refuses_provider_isolated_vars(hermes_base, monkeypatch):
    monkeypatch.setenv("AQUAMAN_LOOPBACK_TOKEN", TOKEN)
    calls = _stub_broker(monkeypatch, values={"github/token": "ghp_real"})
    source = plugin.build_secret_source()
    result = source.fetch(_cfg({
        "ANTHROPIC_API_KEY": "aquaman://anthropic/api_key",
        "OPENAI_API_KEY": "aquaman://openai/api_key",
        "GITHUB_TOKEN": "aquaman://github/token",
    }), Path("/tmp"))
    assert result.ok
    # LLM keys never materialize into Hermes' env — loopback proxy path only.
    assert set(result.secrets) == {"GITHUB_TOKEN"}
    assert sum("process-isolated" in w for w in result.warnings) == 2
    assert all("anthropic/api_key" not in c["ref"] for c in calls)


def test_fetch_skips_invalid_refs_and_names(hermes_base, monkeypatch):
    monkeypatch.setenv("AQUAMAN_LOOPBACK_TOKEN", TOKEN)
    _stub_broker(monkeypatch, values={"github/token": "ghp_real"})
    source = plugin.build_secret_source()
    result = source.fetch(_cfg({
        "GOOD": "aquaman://github/token",
        "BAD_REF": "op://vault/item",
        "1BADNAME": "aquaman://github/token",
    }), Path("/tmp"))
    assert result.ok
    assert set(result.secrets) == {"GOOD"}
    assert any("invalid ref" in w for w in result.warnings)
    assert any("invalid env var name" in w for w in result.warnings)


def test_fetch_missing_credential_is_per_ref_warning(hermes_base, monkeypatch):
    monkeypatch.setenv("AQUAMAN_LOOPBACK_TOKEN", TOKEN)
    _stub_broker(monkeypatch, values={"github/token": "ghp_real"})
    source = plugin.build_secret_source()
    result = source.fetch(_cfg({
        "GITHUB_TOKEN": "aquaman://github/token",
        "MISSING": "aquaman://nope/key",
    }), Path("/tmp"))
    # One bad ref never sinks the rest.
    assert result.ok
    assert result.secrets == {"GITHUB_TOKEN": "ghp_real"}
    assert any("nope/key" in w for w in result.warnings)


def test_fetch_auth_failure_is_fatal(hermes_base, monkeypatch):
    monkeypatch.setenv("AQUAMAN_LOOPBACK_TOKEN", "wrong-token")
    _stub_broker(monkeypatch, errors={"github/token": ("Loopback request rejected", 401)})
    source = plugin.build_secret_source()
    result = source.fetch(_cfg({"GITHUB_TOKEN": "aquaman://github/token"}), Path("/tmp"))
    assert not result.ok
    assert result.error_kind.value == "auth_failed"
    assert "aquaman hermes setup" in result.error


def test_fetch_proxy_down_is_fatal_network(hermes_base, monkeypatch):
    monkeypatch.setenv("AQUAMAN_LOOPBACK_TOKEN", TOKEN)
    _stub_broker(monkeypatch, exc=urllib.error.URLError(ConnectionRefusedError(61, "refused")))
    source = plugin.build_secret_source()
    result = source.fetch(_cfg({"GITHUB_TOKEN": "aquaman://github/token"}), Path("/tmp"))
    assert not result.ok
    assert result.error_kind.value == "network"
    assert "aquaman daemon" in result.error


def test_fetch_timeout_maps_to_timeout_kind(hermes_base, monkeypatch):
    monkeypatch.setenv("AQUAMAN_LOOPBACK_TOKEN", TOKEN)
    _stub_broker(monkeypatch, exc=urllib.error.URLError(TimeoutError()))
    source = plugin.build_secret_source()
    result = source.fetch(_cfg({"GITHUB_TOKEN": "aquaman://github/token"}), Path("/tmp"))
    assert not result.ok
    assert result.error_kind.value == "timeout"


def test_fetch_empty_value_skipped_with_warning(hermes_base, monkeypatch):
    monkeypatch.setenv("AQUAMAN_LOOPBACK_TOKEN", TOKEN)
    _stub_broker(monkeypatch, values={"github/token": ""})
    source = plugin.build_secret_source()
    result = source.fetch(_cfg({"GITHUB_TOKEN": "aquaman://github/token"}), Path("/tmp"))
    assert result.ok
    assert result.secrets == {}
    assert any("empty value" in w for w in result.warnings)


def test_fetch_never_raises(hermes_base, monkeypatch):
    monkeypatch.setenv("AQUAMAN_LOOPBACK_TOKEN", TOKEN)
    _stub_broker(monkeypatch, exc=ValueError("unexpected bug"))
    source = plugin.build_secret_source()
    result = source.fetch(_cfg({"GITHUB_TOKEN": "aquaman://github/token"}), Path("/tmp"))
    assert not result.ok
    assert result.error_kind.value == "internal"


def test_fetch_defensive_on_malformed_cfg(hermes_base):
    source = plugin.build_secret_source()
    for bad in (None, "nope", 42, ["list"]):
        result = source.fetch(bad, Path("/tmp"))
        assert not result.ok
        assert result.error_kind.value == "not_configured"


# ---------------------------------------------------------------------------
# Precedence / protection hooks
# ---------------------------------------------------------------------------

def test_override_existing_defaults_true(hermes_base):
    source = plugin.build_secret_source()
    assert source.override_existing({}) is True
    assert source.override_existing({"override_existing": False}) is False


def test_protected_env_vars_includes_token(hermes_base):
    source = plugin.build_secret_source()
    assert "AQUAMAN_LOOPBACK_TOKEN" in source.protected_env_vars({})
    assert "MY_TOKEN" in source.protected_env_vars({"token_env": "MY_TOKEN"})


def test_protected_env_vars_covers_wired_placeholders(hermes_base, monkeypatch):
    # ANTHROPIC wired through the loopback → its placeholder key var is
    # protected from ANY source overwriting it with a real key.
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:8585/anthropic")
    source = plugin.build_secret_source()
    protected = source.protected_env_vars({})
    assert "ANTHROPIC_API_KEY" in protected
    assert "OPENAI_API_KEY" not in protected  # openai not wired here


def test_protected_env_vars_ignores_non_loopback_base_urls(hermes_base, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
    source = plugin.build_secret_source()
    assert "ANTHROPIC_API_KEY" not in source.protected_env_vars({})


# ---------------------------------------------------------------------------
# _broker_resolve_http against a real local HTTP server
# ---------------------------------------------------------------------------

class _BrokerHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.headers.get("x-aquaman-token") != TOKEN:
            self._reply(401, {"error": "Loopback request rejected", "fix": "aquaman hermes status"})
        elif body["service"] == "github":
            self._reply(200, {"value": "ghp_live_value", "expires_at": "2026-01-01T00:00:00Z"})
        else:
            self._reply(404, {"error": f"No credential found for {body['service']}/{body['key']}",
                              "fix": f"Run: aquaman credentials add {body['service']} {body['key']}"})

    def _reply(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):  # keep test output quiet
        pass


@pytest.fixture()
def broker_server():
    server = HTTPServer(("127.0.0.1", 0), _BrokerHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    thread.join(timeout=2)


def test_broker_resolve_http_success(broker_server):
    value, error, status = plugin._broker_resolve_http(broker_server, TOKEN, "github", "token", 2.0)
    assert (value, error, status) == ("ghp_live_value", None, 200)


def test_broker_resolve_http_not_found(broker_server):
    value, error, status = plugin._broker_resolve_http(broker_server, TOKEN, "nope", "key", 2.0)
    assert value is None
    assert status == 404
    assert "No credential found" in error and "fix:" in error


def test_broker_resolve_http_bad_token(broker_server):
    value, error, status = plugin._broker_resolve_http(broker_server, "bad", "github", "token", 2.0)
    assert value is None
    assert status == 401


def test_end_to_end_fetch_against_real_server(hermes_base, broker_server, monkeypatch):
    monkeypatch.setenv("AQUAMAN_LOOPBACK_TOKEN", TOKEN)
    source = plugin.build_secret_source()
    result = source.fetch(_cfg(
        {"GITHUB_TOKEN": "aquaman://github/token"}, base_url=broker_server,
    ), Path("/tmp"))
    assert result.ok
    assert result.secrets == {"GITHUB_TOKEN": "ghp_live_value"}
