"""Run Hermes' own secret-source conformance kit against the aquaman source.

Hermes' developer guide calls green conformance "the review bar for calling a
backend contract-compliant" (website/docs/developer-guide/secret-source-plugin.md).
The rest of this suite runs stdlib-only against a faithful fake; this module is
the real thing — the actual ABC, registry, and ``apply_all`` orchestrator from
an installed hermes-agent.

Skipped when hermes-agent is not installed, so the default
``pytest tests/`` stays dependency-free. To run it:

    uv run --with pytest --with hermes-agent python -m pytest tests/test_conformance.py -q
"""

import pytest

# Must precede the vendored-kit import: the kit imports the real registry at
# module scope, which would be a collection error rather than a skip.
pytest.importorskip(
    "agent.secret_sources.registry",
    reason="hermes-agent not installed; run with --with hermes-agent",
)

from _hermes_conformance import SecretSourceConformance  # noqa: E402

from aquaman_hermes import plugin  # noqa: E402


class TestAquamanSourceConformance(SecretSourceConformance):
    """The aquaman source against the upstream contract checks."""

    @pytest.fixture
    def source(self):
        built = plugin.build_secret_source()
        assert built is not None, (
            "build_secret_source() returned None against a real hermes-agent — "
            "the contract import shape drifted"
        )
        return built


def test_registers_against_the_real_contract():
    """Guards the class attributes the real registry rejects sources on."""
    from agent.secret_sources.base import SECRET_SOURCE_API_VERSION
    from agent.secret_sources.registry import (
        _reset_registry_for_tests,
        register_source,
    )

    source = plugin.build_secret_source()
    assert source is not None
    assert source.api_version == SECRET_SOURCE_API_VERSION
    assert source.shape in ("mapped", "bulk")

    _reset_registry_for_tests()
    try:
        assert register_source(source), (
            "the real registry rejected the aquaman source — check name, "
            "shape, scheme, and api_version"
        )
    finally:
        _reset_registry_for_tests()


def test_provider_isolated_vars_still_refused_on_real_contract(tmp_path, monkeypatch):
    """The two-tier security model must hold against the real FetchResult.

    LLM provider keys stay process-isolated on the loopback proxy path; a
    config.yaml binding must never downgrade that to env materialization.
    """
    monkeypatch.setenv("AQUAMAN_LOOPBACK_TOKEN", "aqm_lb_" + "e" * 48)
    source = plugin.build_secret_source()
    result = source.fetch(
        {
            "enabled": True,
            "env": {"ANTHROPIC_API_KEY": "aquaman://anthropic/api_key"},
        },
        tmp_path,
    )
    assert "ANTHROPIC_API_KEY" not in result.secrets
    assert any("process-isolated" in w for w in result.warnings)
