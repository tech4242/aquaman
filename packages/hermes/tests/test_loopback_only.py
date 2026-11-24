"""The plugin sends requests to the local aquaman proxy and to no other host.

One table row per way an address can reach the plugin and per way it can be
spelled. Each row is run against the real sender (``plugin._open``) replaced
by a recorder, so "nothing was sent" is what is asserted, not what a helper
returned. The redirect and proxy rows use real local servers.

Mapped controls:
  - NIST SP 800-53 SC-7 (Boundary Protection): the loopback token and the
    health probe leave the process only towards a loopback address.
  - NIST SP 800-53 SI-10: an address is rebuilt from its parsed scheme, host
    and port; nothing else in the text decides where a request goes.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from aquaman_hermes import plugin

TOKEN = "aqm_lb_" + "c" * 48

ENV_VARS = (
    "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL",
    "AQUAMAN_LOOPBACK_URL", "AQUAMAN_LOOPBACK_TOKEN",
    "http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY",
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in ENV_VARS:
        monkeypatch.delenv(var, raising=False)


@pytest.fixture()
def sent(monkeypatch):
    """Every request the plugin tries to send, recorded instead of sent."""
    requests = []

    def record(req, timeout):
        requests.append({"url": req.full_url, "headers": {k.lower(): v for k, v in req.header_items()}})
        raise plugin.urllib.error.URLError("recorded, not sent")

    monkeypatch.setattr(plugin, "_open", record)
    return requests


# Addresses that are not the local proxy, however they are written. Each one
# is refused wherever it arrives.
NOT_LOOPBACK = [
    ("a remote gateway", "https://gateway.example.com/anthropic"),
    ("a remote host over http", "http://gateway.example.com:8585"),
    ("the provider itself", "https://api.anthropic.com"),
    ("a private network address", "http://192.168.1.20:8585"),
    ("the unspecified address", "http://0.0.0.0:8585"),
    ("loopback as user info of another host", "http://127.0.0.1:8585@gateway.example.com/"),
    ("loopback as a password", "http://user:127.0.0.1@gateway.example.com/"),
    ("loopback as a subdomain label", "http://127.0.0.1.gateway.example.com:8585"),
    ("localhost as a subdomain label", "http://localhost.gateway.example.com:8585"),
    ("loopback in the path", "http://gateway.example.com/127.0.0.1:8585"),
    ("loopback in the fragment", "http://gateway.example.com#@127.0.0.1:8585"),
    ("loopback in the query", "http://gateway.example.com?@127.0.0.1:8585"),
    ("a backslash before the real host", "http://127.0.0.1:8585\\@gateway.example.com/"),
    ("a backslash in place of a slash", "http://gateway.example.com\\127.0.0.1"),
    ("white space inside the host", "http://127.0.0.1 .gateway.example.com"),
    ("a short form of 127.0.0.1", "http://127.1:8585"),
    ("127.0.0.1 as one number", "http://2130706433:8585"),
    ("127.0.0.1 in hex", "http://0x7f.0.0.1:8585"),
    ("an IPv6 address that is not ::1", "http://[::2]:8585"),
    ("an IPv4-mapped IPv6 address", "http://[::ffff:127.0.0.1]:8585"),
    ("a scheme that is not http", "ftp://127.0.0.1:8585"),
    ("a file URL", "file://127.0.0.1/etc/passwd"),
    ("no scheme", "127.0.0.1:8585"),
    ("a scheme-relative address", "//127.0.0.1:8585"),
    ("a port that is not a number", "http://127.0.0.1:port"),
    ("a port out of range", "http://127.0.0.1:99999"),
    ("an unclosed IPv6 bracket", "http://[::1:8585"),
    ("only a path", "/anthropic"),
    ("an empty string", ""),
    ("white space", "   "),
]

IDS = [name for name, _ in NOT_LOOPBACK]
URLS = [url for _, url in NOT_LOOPBACK]


@pytest.mark.parametrize("url", URLS, ids=IDS)
def test_an_address_that_is_not_loopback_is_no_origin(url):
    assert plugin._checked_origin(url) is None


@pytest.mark.parametrize("value", [None, 8585, ["http://127.0.0.1:8585"], {"url": "http://127.0.0.1"}, True])
def test_a_value_that_is_not_text_is_no_origin(value):
    assert plugin._checked_origin(value) is None


@pytest.mark.parametrize("url,origin", [
    ("http://127.0.0.1:8585", "http://127.0.0.1:8585"),
    ("http://127.0.0.1:8585/", "http://127.0.0.1:8585"),
    ("http://127.0.0.1:8585/anthropic", "http://127.0.0.1:8585"),
    ("http://127.0.0.1:8585/openai/v1?x=1#y", "http://127.0.0.1:8585"),
    ("http://localhost:9000/anthropic", "http://localhost:9000"),
    ("http://LOCALHOST:9000", "http://localhost:9000"),
    ("http://[::1]:8585/anthropic", "http://[::1]:8585"),
    ("https://127.0.0.1:8443", "https://127.0.0.1:8443"),
    ("http://127.0.0.1", "http://127.0.0.1"),
    ("  http://127.0.0.1:8585  ", "http://127.0.0.1:8585"),
    # User info is dropped: the request is built from host and port alone.
    ("http://user:pass@127.0.0.1:8585/x", "http://127.0.0.1:8585"),
])
def test_a_loopback_address_gives_scheme_host_and_port_only(url, origin):
    assert plugin._checked_origin(url) == origin


# --- the health probe -------------------------------------------------------

@pytest.mark.parametrize("var", ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"])
@pytest.mark.parametrize("url", URLS, ids=IDS)
def test_session_start_sends_no_probe_to_a_base_url_that_is_not_loopback(monkeypatch, sent, var, url):
    monkeypatch.setenv(var, url)
    monkeypatch.setenv("AQUAMAN_LOOPBACK_TOKEN", TOKEN)
    assert plugin._on_session_start() is None
    assert sent == []


@pytest.mark.parametrize("url", URLS, ids=IDS)
def test_the_status_command_and_tool_send_nothing_to_a_base_url_that_is_not_loopback(monkeypatch, sent, url):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", url)
    for text in (plugin._command_status(""), plugin._tool_status({})):
        assert "Not wired" in text
    assert plugin._probe_health()[0] is False
    assert sent == []


def test_the_status_says_the_base_url_is_someone_elses(monkeypatch, sent):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://gateway.example.com/anthropic")
    text = plugin._status_text()
    assert "ANTHROPIC_BASE_URL is set, but not to the aquaman loopback listener" in text
    assert "gateway.example.com" not in text
    assert sent == []


def test_a_loopback_base_url_is_used_when_another_one_is_remote(monkeypatch, sent):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://gateway.example.com/anthropic")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:8585/openai/v1")
    plugin._on_session_start()
    assert [r["url"] for r in sent] == ["http://127.0.0.1:8585/_health"]
    text = plugin._status_text()
    assert "Wired vars:     OPENAI_BASE_URL" in text
    assert "ANTHROPIC_BASE_URL" not in text


def test_the_probe_carries_no_token(monkeypatch, sent):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:8585/anthropic")
    monkeypatch.setenv("AQUAMAN_LOOPBACK_TOKEN", TOKEN)
    monkeypatch.setenv("ANTHROPIC_API_KEY", TOKEN)
    plugin._on_session_start()
    assert len(sent) == 1
    assert TOKEN not in json.dumps(sent[0])


# --- the secret source: every place its address can come from ---------------

def _fetch(cfg_extra=None):
    source = plugin.build_secret_source()
    cfg = {"enabled": True, "env": {"GITHUB_TOKEN": "aquaman://github/token"}}
    cfg.update(cfg_extra or {})
    return source.fetch(cfg, Path("/tmp"))


@pytest.mark.parametrize("url", [u for u in URLS if u.strip()], ids=[n for n, u in NOT_LOOPBACK if u.strip()])
def test_base_url_in_config_that_is_not_loopback_is_refused_and_the_token_is_not_sent(hermes_base, monkeypatch, sent, url):
    monkeypatch.setenv("AQUAMAN_LOOPBACK_TOKEN", TOKEN)
    # A correct variable beside it does not rescue a wrong setting: the
    # setting that was named decides, so the mistake is reported.
    monkeypatch.setenv("AQUAMAN_LOOPBACK_URL", "http://127.0.0.1:8585")
    result = _fetch({"base_url": url})
    assert result.secrets == {}
    assert result.error_kind == hermes_base.ErrorKind.NOT_CONFIGURED
    assert "secrets.aquaman.base_url is not a loopback address" in result.error
    assert sent == []


@pytest.mark.parametrize("url", [u for u in URLS if u.strip()], ids=[n for n, u in NOT_LOOPBACK if u.strip()])
def test_loopback_url_variable_that_is_not_loopback_is_refused_and_the_token_is_not_sent(hermes_base, monkeypatch, sent, url):
    monkeypatch.setenv("AQUAMAN_LOOPBACK_TOKEN", TOKEN)
    monkeypatch.setenv("AQUAMAN_LOOPBACK_URL", url)
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:8585/anthropic")
    result = _fetch()
    assert result.secrets == {}
    assert result.error_kind == hermes_base.ErrorKind.NOT_CONFIGURED
    assert "AQUAMAN_LOOPBACK_URL is not a loopback address" in result.error
    assert sent == []


@pytest.mark.parametrize("var", ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"])
@pytest.mark.parametrize("url", URLS, ids=IDS)
def test_a_remote_provider_base_url_never_receives_the_token(hermes_base, monkeypatch, sent, var, url):
    # No address is named for the source, so it falls back to the provider
    # base URL. A remote one is not aquaman's: the request goes to the
    # default local address, and the remote host gets nothing.
    monkeypatch.setenv("AQUAMAN_LOOPBACK_TOKEN", TOKEN)
    monkeypatch.setenv(var, url)
    _fetch()
    assert [r["url"] for r in sent] == ["http://127.0.0.1:8585/broker/resolve"]


def test_the_per_fetch_environment_is_held_to_the_same_rule(hermes_base_env_view, monkeypatch, sent):
    monkeypatch.setenv("AQUAMAN_LOOPBACK_URL", "http://127.0.0.1:8585")
    view = {"AQUAMAN_LOOPBACK_TOKEN": TOKEN, "AQUAMAN_LOOPBACK_URL": "https://gateway.example.com"}
    handle = hermes_base_env_view.set_source_environment(view)
    try:
        result = _fetch()
    finally:
        hermes_base_env_view.reset_source_environment(handle)
    assert "AQUAMAN_LOOPBACK_URL is not a loopback address" in result.error
    assert sent == []


def test_the_refusal_names_no_host_and_no_token(hermes_base, monkeypatch, sent):
    monkeypatch.setenv("AQUAMAN_LOOPBACK_TOKEN", TOKEN)
    result = _fetch({"base_url": f"https://{TOKEN}@gateway.example.com"})
    assert TOKEN not in result.error
    assert "gateway.example.com" not in result.error


@pytest.mark.parametrize("url", URLS, ids=IDS)
def test_the_sender_itself_refuses_an_address_that_is_not_loopback(sent, url):
    # A caller that skipped the check above still cannot send the token away.
    value, error, status = plugin._broker_resolve_http(url, TOKEN, "github", "token", 1.0)
    assert (value, status) == (None, None)
    assert "not a loopback address" in error
    assert sent == []


def test_the_status_surfaces_read_the_per_fetch_environment(hermes_base_env_view, monkeypatch, sent):
    # Another profile's wiring in the process environment must not be probed.
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:9999/anthropic")
    handle = hermes_base_env_view.set_source_environment({"OPENAI_BASE_URL": "http://127.0.0.1:8585/openai/v1"})
    try:
        text = plugin._status_text()
    finally:
        hermes_base_env_view.reset_source_environment(handle)
    assert "Loopback proxy: http://127.0.0.1:8585" in text
    assert [r["url"] for r in sent] == ["http://127.0.0.1:8585/_health"]


# --- redirects and proxies, against real local servers -----------------------

class _Recorder(BaseHTTPRequestHandler):
    """Records what reaches it. `mode` decides the answer."""

    def _handle(self):
        length = int(self.headers.get("content-length") or 0)
        if length:
            self.rfile.read(length)
        self.server.seen.append((self.command, self.path, {k.lower(): v for k, v in self.headers.items()}))
        if self.server.mode == "redirect":
            self.send_response(self.server.code)
            self.send_header("Location", self.server.target + self.path)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = json.dumps({"value": "from-the-wrong-host", "status": "ok", "version": "0", "services": []}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = _handle  # noqa: N815

    def log_message(self, *_):
        pass


def _serve(mode, **attrs):
    server = HTTPServer(("127.0.0.1", 0), _Recorder)
    server.seen = []
    server.mode = mode
    for key, value in attrs.items():
        setattr(server, key, value)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


@pytest.fixture()
def servers():
    started = []

    def start(mode, **attrs):
        server, origin = _serve(mode, **attrs)
        started.append(server)
        return server, origin

    yield start
    for server in started:
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize("code", [301, 302, 303, 307, 308])
def test_a_redirect_from_the_proxy_address_is_not_followed_with_the_token(servers, code):
    elsewhere, elsewhere_origin = servers("answer")
    listener, origin = servers("redirect", code=code, target=elsewhere_origin)
    value, error, status = plugin._broker_resolve_http(origin, TOKEN, "github", "token", 2.0)
    assert value is None
    assert status == code
    assert len(listener.seen) == 1
    assert elsewhere.seen == []


@pytest.mark.parametrize("code", [301, 302, 303, 307, 308])
def test_a_redirect_of_the_health_probe_is_not_followed(servers, monkeypatch, code):
    elsewhere, elsewhere_origin = servers("answer")
    listener, origin = servers("redirect", code=code, target=elsewhere_origin)
    monkeypatch.setenv("ANTHROPIC_BASE_URL", f"{origin}/anthropic")
    reachable, _ = plugin._probe_health()
    assert reachable is False
    assert len(listener.seen) == 1
    assert elsewhere.seen == []


@pytest.mark.parametrize("var", ["http_proxy", "HTTP_PROXY"])
def test_a_proxy_variable_does_not_receive_the_request_or_the_token(servers, monkeypatch, var):
    proxy, proxy_origin = servers("answer")
    listener, origin = servers("answer")
    monkeypatch.setenv(var, proxy_origin)
    monkeypatch.setenv("ANTHROPIC_BASE_URL", f"{origin}/anthropic")
    value, _, status = plugin._broker_resolve_http(origin, TOKEN, "github", "token", 2.0)
    assert status == 200 and value == "from-the-wrong-host"
    assert plugin._probe_health()[0] is True
    assert [path for _, path, _ in listener.seen] == ["/broker/resolve", "/_health"]
    assert listener.seen[0][2]["x-aquaman-token"] == TOKEN
    assert proxy.seen == []


# --- limits, stated as rows that are expected to fail -------------------------

@pytest.mark.xfail(strict=True, reason="`localhost` is accepted by name; the plugin does not check what it resolves to")
def test_limit_localhost_is_trusted_by_name_not_by_what_it_resolves_to(monkeypatch):
    # A hosts file or resolver that maps `localhost` to another machine sends
    # the request there. The setup command writes 127.0.0.1, never a name.
    assert plugin._checked_origin("http://localhost:8585") is None


@pytest.mark.xfail(strict=True, reason="any program listening on the loopback port receives the token; the address is checked, not who answers")
def test_limit_whatever_listens_on_the_loopback_port_gets_the_token(servers):
    other, origin = servers("answer")
    plugin._broker_resolve_http(origin, TOKEN, "github", "token", 2.0)
    assert all("x-aquaman-token" not in headers for _, _, headers in other.seen)
