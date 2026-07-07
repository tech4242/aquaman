"""Unit tests for the aquaman-hermes installer CLI (stdlib only).

Each test points HERMES_HOME at a tmp dir so install/uninstall/status operate
on a throwaway plugin directory rather than the real ~/.hermes.
"""

import pytest

from aquaman_hermes import cli


@pytest.fixture
def hermes_home(tmp_path, monkeypatch):
    home = tmp_path / "hermes"
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


def _plugin_dir(home):
    return home / "plugins" / "aquaman"


def test_hermes_home_honors_env(hermes_home):
    assert cli._hermes_home() == hermes_home
    assert cli._plugin_dir() == _plugin_dir(hermes_home)


def test_hermes_home_defaults_to_dot_hermes(tmp_path, monkeypatch):
    monkeypatch.delenv("HERMES_HOME", raising=False)
    monkeypatch.setattr(cli.Path, "home", staticmethod(lambda: tmp_path))
    assert cli._hermes_home() == tmp_path / ".hermes"


def test_install_copies_manifest_and_module(hermes_home, capsys):
    rc = cli.main(["install"])
    assert rc == 0

    dest = _plugin_dir(hermes_home)
    assert (dest / "plugin.yaml").is_file()
    assert (dest / "__init__.py").is_file()

    # The module is copied verbatim as __init__.py so the directory plugin is
    # self-contained under Hermes' own interpreter.
    assert (dest / "__init__.py").read_text() == cli._bundled("plugin.py").read_text()
    assert (dest / "plugin.yaml").read_text() == cli._bundled("plugin.yaml").read_text()

    out = capsys.readouterr().out
    assert "Installed aquaman plugin" in out
    assert "hermes plugins enable aquaman" in out


def test_install_is_idempotent(hermes_home):
    assert cli.main(["install"]) == 0
    assert cli.main(["install"]) == 0
    dest = _plugin_dir(hermes_home)
    assert (dest / "plugin.yaml").is_file()
    assert (dest / "__init__.py").is_file()


def test_install_fails_when_bundled_files_missing(hermes_home, tmp_path, monkeypatch, capsys):
    # Point _bundled at an empty dir so the source files are absent.
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setattr(cli, "_bundled", lambda name: empty / name)

    rc = cli.main(["install"])
    assert rc == 1
    assert "bundled plugin files missing" in capsys.readouterr().err
    # Nothing should have been written.
    assert not (_plugin_dir(hermes_home) / "__init__.py").exists()


def test_status_reports_not_installed(hermes_home, capsys):
    rc = cli.main(["status"])
    assert rc == 1
    out = capsys.readouterr().out
    assert "Installed:   no" in out
    assert "aquaman-hermes install" in out


def test_status_reports_installed(hermes_home, capsys):
    cli.main(["install"])
    capsys.readouterr()  # drop install output

    rc = cli.main(["status"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "Installed:   yes" in out
    assert "hermes plugins enable aquaman" in out


def test_uninstall_removes_plugin_dir(hermes_home, capsys):
    cli.main(["install"])
    dest = _plugin_dir(hermes_home)
    assert dest.exists()

    capsys.readouterr()
    rc = cli.main(["uninstall"])
    assert rc == 0
    assert not dest.exists()
    assert "Removed" in capsys.readouterr().out


def test_uninstall_when_nothing_installed(hermes_home, capsys):
    rc = cli.main(["uninstall"])
    assert rc == 0
    assert "Nothing to remove" in capsys.readouterr().out


def test_main_requires_a_subcommand():
    # argparse exits 2 when the required subcommand is omitted.
    with pytest.raises(SystemExit) as exc:
        cli.main([])
    assert exc.value.code == 2
