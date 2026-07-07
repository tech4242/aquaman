"""Unit tests for the aquaman_hermes plugin (stdlib only, no Hermes import)."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from aquaman_hermes import plugin


@pytest.fixture(autouse=True)
def _clear_base_urls(monkeypatch):
    for var in ("ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"):
        monkeypatch.delenv(var, raising=False)


class FakeCtx:
    def __init__(self):
        self.commands = {}
        self.tools = {}
        self.hooks = {}

    def register_command(self, name, handler, description="", args_hint=""):
        self.commands[name] = handler

    def register_tool(self, name, toolset, schema, handler, **kwargs):
        self.tools[name] = handler

    def register_hook(self, hook_name, callback):
        self.hooks[hook_name] = callback


def test_loopback_origin_strips_service_path(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:8585/anthropic")
    assert plugin._loopback_origin() == "http://127.0.0.1:8585"


def test_loopback_origin_openai_with_v1(monkeypatch):
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:9000/openai/v1")
    assert plugin._loopback_origin() == "http://127.0.0.1:9000"


def test_loopback_origin_none_when_unset():
    assert plugin._loopback_origin() is None


def test_status_text_not_wired():
    text = plugin._status_text()
    assert "Not wired" in text
    assert "aquaman hermes setup" in text


def test_on_session_start_no_env_is_silent():
    # Should not raise and should not log a warning when aquaman isn't configured.
    assert plugin._on_session_start() is None


def test_register_wires_command_tool_and_hook():
    ctx = FakeCtx()
    plugin.register(ctx)
    assert "aquaman-status" in ctx.commands
    assert "aquaman_status" in ctx.tools
    assert "on_session_start" in ctx.hooks
    # Handlers are callable and return strings for the status surfaces.
    assert isinstance(ctx.commands["aquaman-status"](""), str)
    assert isinstance(ctx.tools["aquaman_status"]({}), str)


class _HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path == "/_health":
            body = json.dumps({"status": "ok", "version": "0.13.0", "services": ["anthropic"]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *_):  # silence
        pass


def test_probe_health_against_live_server(monkeypatch):
    server = HTTPServer(("127.0.0.1", 0), _HealthHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        monkeypatch.setenv("ANTHROPIC_BASE_URL", f"http://127.0.0.1:{port}/anthropic")
        reachable, info = plugin._probe_health()
        assert reachable is True
        assert info["version"] == "0.13.0"
        assert "anthropic" in info["services"]
        text = plugin._status_text()
        assert "responding" in text
    finally:
        server.shutdown()


def test_probe_health_unreachable(monkeypatch):
    # Port 1 is privileged/closed — connection refused.
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:1/anthropic")
    reachable, info = plugin._probe_health()
    assert reachable is False
    assert "reason" in info
