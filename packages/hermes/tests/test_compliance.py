"""Compliance tests for the aquaman-hermes plugin (stdlib only).

The plugin is a credential-free, in-session "sugar" layer: it reads the
provider ``*_BASE_URL`` env vars aquaman wrote and probes ``/_health``. It holds
no credentials and performs no isolation — that is entirely proxy-side. These
tests therefore assert the controls that ARE applicable to such a layer: that it
does not *undermine* the isolation the proxy enforces.

Mapped controls:
  - MITRE ATLAS AML.T0098 (AI Agent Tool Credential Harvesting): the agent-facing
    ``aquaman_status`` tool and ``/aquaman-status`` command must never surface the
    loopback token or any API-key value, even when both are present in the env.
  - NIST SP 800-53 SI-10 (Information Input/Output Validation): status output
    exposes only non-secret metadata (origin host:port + env var names); the
    health probe targets the token-exempt ``/_health`` and transmits no credential.
  - NIST SP 800-53 AC-6 (Least Privilege): the plugin consults only ``*_BASE_URL``
    env vars, never ``*_API_KEY`` — it has no need for, and no access to, the key.
"""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from aquaman_hermes import plugin

# A value that must never appear in any agent-facing output. It is what aquaman
# places in ANTHROPIC_API_KEY (the loopback token / placeholder key).
SECRET_TOKEN = "aqm_lb_super_secret_token_DO_NOT_LEAK_0123456789"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in ("ANTHROPIC_BASE_URL", "OPENAI_BASE_URL",
                "ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
        monkeypatch.delenv(var, raising=False)


class _RecordingHealthHandler(BaseHTTPRequestHandler):
    """Health endpoint that records the path + headers of each request."""

    received = []  # class-level capture: list of (path, {headers})

    def do_GET(self):  # noqa: N802
        type(self).received.append((self.path, {k.lower(): v for k, v in self.headers.items()}))
        if self.path == "/_health":
            body = b'{"status":"ok","version":"0.13.0","services":["anthropic"]}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *_):  # silence
        pass


@pytest.fixture
def health_server():
    _RecordingHealthHandler.received = []
    server = HTTPServer(("127.0.0.1", 0), _RecordingHealthHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        yield port, _RecordingHealthHandler
    finally:
        server.shutdown()


# --- ATLAS AML.T0098 — the status surfaces must not harvest credentials ------

def test_t0098_status_text_never_contains_the_token_when_proxy_unreachable(monkeypatch):
    # Origin set (so the plugin is "wired") but proxy down: even the error path
    # must not echo the key that lives alongside the base URL in the env.
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:1/anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET_TOKEN)
    text = plugin._status_text()
    assert SECRET_TOKEN not in text


def test_t0098_status_tool_and_command_never_contain_the_token_when_reachable(monkeypatch, health_server):
    port, _ = health_server
    monkeypatch.setenv("ANTHROPIC_BASE_URL", f"http://127.0.0.1:{port}/anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET_TOKEN)

    tool_out = plugin._tool_status({})          # agent-facing tool handler
    command_out = plugin._command_status("")    # human-facing slash command
    assert "responding" in tool_out             # sanity: proxy was reachable
    assert SECRET_TOKEN not in tool_out
    assert SECRET_TOKEN not in command_out


def test_t0098_status_reports_var_names_not_secret_values(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:1/anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET_TOKEN)
    text = plugin._status_text()
    # It surfaces the non-secret env var NAME, never the secret value.
    assert "ANTHROPIC_BASE_URL" in text
    assert SECRET_TOKEN not in text


# --- NIST AC-6 — the plugin reads only *_BASE_URL, never *_API_KEY -----------

def test_ac6_plugin_does_not_read_api_key_env_vars():
    # Least privilege: the only env vars the plugin consults are base URLs.
    assert "ANTHROPIC_API_KEY" not in plugin._BASE_URL_ENV_VARS
    assert "OPENAI_API_KEY" not in plugin._BASE_URL_ENV_VARS
    assert set(plugin._BASE_URL_ENV_VARS) == {"ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"}


def test_ac6_api_key_alone_does_not_make_the_plugin_consider_itself_wired(monkeypatch):
    # An API key with no base URL must not be picked up as a loopback origin.
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET_TOKEN)
    assert plugin._loopback_origin() is None
    text = plugin._status_text()
    assert "Not wired" in text
    assert SECRET_TOKEN not in text


# --- NIST SI-10 — health probe is token-exempt and sends no credential -------

def test_si10_health_probe_targets_health_path_and_sends_no_credential(monkeypatch, health_server):
    port, handler = health_server
    monkeypatch.setenv("ANTHROPIC_BASE_URL", f"http://127.0.0.1:{port}/anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET_TOKEN)

    reachable, info = plugin._probe_health()
    assert reachable is True
    assert info.get("origin") == f"http://127.0.0.1:{port}"

    # Exactly one request, to the token-exempt /_health (service path stripped).
    assert len(handler.received) == 1
    path, headers = handler.received[0]
    assert path == "/_health"
    # The probe must not forward the token in any auth header.
    for name in ("x-api-key", "authorization", "x-aquaman-token"):
        assert SECRET_TOKEN not in headers.get(name, "")


def test_si10_session_start_hook_does_not_log_the_token(monkeypatch, caplog):
    # The on_session_start health probe logs reachability; with the proxy down it
    # warns — and that warning must not contain the key.
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:1/anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET_TOKEN)
    with caplog.at_level("DEBUG", logger="aquaman_hermes"):
        plugin._on_session_start()
    assert SECRET_TOKEN not in caplog.text
