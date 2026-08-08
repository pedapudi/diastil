"""Engine discovery: the ladder, the config pin, and the empty machine.

A machine with nothing installed is a first-class supported state, not an
error path — the editor still opens documents there. These tests hold the
daemon to reporting that honestly.
"""

from __future__ import annotations

import stat

import pytest

from dia_service import tex, texdl


def install(directory, name: str, version: str = "fake 1.0"):
    exe = directory / name
    exe.write_text(f"#!/bin/sh\necho '{version}'\n", encoding="utf-8")
    exe.chmod(exe.stat().st_mode | stat.S_IXUSR)
    return exe


def only(monkeypatch, directory):
    monkeypatch.setenv("PATH", str(directory))
    tex.reset_cache()


def test_nothing_installed_reports_no_engine(monkeypatch, fake_path):
    only(monkeypatch, fake_path)
    cap = tex.discover(config={})
    assert cap.engine is None
    assert cap.path is None
    assert cap.detail == "no TeX engine found"
    # ...but the client still gets an install offer where we have a build
    assert cap.downloadable == (tex.platform_key() in texdl.RELEASES)


def test_ladder_prefers_tectonic_then_latexmk(monkeypatch, fake_path):
    install(fake_path, "pdflatex")
    install(fake_path, "xelatex")
    install(fake_path, "latexmk")
    only(monkeypatch, fake_path)
    assert tex.discover(config={}).engine == "latexmk"

    install(fake_path, "tectonic", "Tectonic 0.15.0")
    tex.reset_cache()
    cap = tex.discover(config={})
    assert cap.engine == "tectonic"
    assert cap.version == "Tectonic 0.15.0"
    assert cap.synctex is True
    assert cap.managed is False


def test_managed_tectonic_outranks_path(monkeypatch, fake_path, tmp_path):
    install(fake_path, "tectonic", "Tectonic 0.14.0")
    only(monkeypatch, fake_path)
    managed = tex.managed_tectonic_path()
    managed.parent.mkdir(parents=True, exist_ok=True)
    install(managed.parent, managed.name, "Tectonic 0.15.0")
    tex.reset_cache()

    cap = tex.discover(config={})
    assert cap.engine == "tectonic"
    assert cap.path == str(managed)
    assert cap.managed is True


def test_config_pin_selects_and_never_falls_back(monkeypatch, fake_path):
    install(fake_path, "latexmk")
    install(fake_path, "xelatex")
    only(monkeypatch, fake_path)
    assert tex.discover(config={"tex": {"engine": "xelatex"}}).engine == "xelatex"

    tex.reset_cache()
    cap = tex.discover(config={"tex": {"engine": "tectonic"}})
    # a pin the tool silently ignores is worse than no pin at all
    assert cap.engine is None
    assert "tectonic" in cap.detail


def test_unrunnable_binary_is_skipped(monkeypatch, fake_path):
    broken = fake_path / "latexmk"
    broken.write_text("#!/nonexistent/interpreter\n", encoding="utf-8")
    broken.chmod(broken.stat().st_mode | stat.S_IXUSR)
    install(fake_path, "pdflatex")
    only(monkeypatch, fake_path)
    assert tex.discover(config={}).engine == "pdflatex"


def test_result_is_cached_until_refreshed(monkeypatch, fake_path):
    only(monkeypatch, fake_path)
    assert tex.discover(config={}).engine is None
    install(fake_path, "pdflatex")
    assert tex.discover(config={}).engine is None       # cached
    assert tex.discover(refresh=True, config={}).engine == "pdflatex"


@pytest.mark.parametrize("raw,expected", [
    ({}, 180.0),
    ({"tex": {"timeout_s": 30}}, 30.0),
    ({"tex": {"timeout_s": "45.5"}}, 45.5),
    ({"tex": {"timeout_s": 0}}, 180.0),        # nonsense falls back
    ({"tex": {"timeout_s": "soon"}}, 180.0),
])
def test_timeout_config(raw, expected):
    assert tex.timeout_s(raw) == expected


def test_cache_dir_honors_xdg(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg"))
    assert tex.cache_root() == tmp_path / "xdg" / "diastil"
    monkeypatch.delenv("XDG_CACHE_HOME")
    assert tex.cache_root().parts[-2:] == (".cache", "diastil")


def test_biber_absent_is_not_an_engine_failure(monkeypatch, fake_path):
    """No biber anywhere: the engine ladder is untouched, and the
    capability says so plainly rather than omitting the field."""
    install(fake_path, "pdflatex")
    only(monkeypatch, fake_path)
    cap = tex.discover(config={})
    assert cap.engine == "pdflatex"
    assert cap.biber is False
    assert tex.biber_path() is None


def test_biber_on_path_is_reported_alongside_any_engine(monkeypatch, fake_path):
    install(fake_path, "pdflatex")
    install(fake_path, "biber", "biber version 2.20")
    only(monkeypatch, fake_path)
    cap = tex.discover(config={})
    assert cap.engine == "pdflatex"
    assert cap.biber is True
    assert tex.biber_path() == str(fake_path / "biber")


def test_biber_is_reported_even_with_no_engine_at_all(monkeypatch, fake_path):
    install(fake_path, "biber", "biber version 2.20")
    only(monkeypatch, fake_path)
    cap = tex.discover(config={})
    assert cap.engine is None
    assert cap.biber is True


def test_biber_path_is_cached_until_reset(monkeypatch, fake_path):
    only(monkeypatch, fake_path)
    assert tex.biber_path() is None
    install(fake_path, "biber")
    assert tex.biber_path() is None       # cached
    tex.reset_cache()
    assert tex.biber_path() == str(fake_path / "biber")


def test_every_release_is_pinned_by_hash():
    """No user-supplied URLs, and nothing computed at runtime: the whole
    install surface is these four constants."""
    for key, release in texdl.RELEASES.items():
        assert release.url.startswith(
            "https://github.com/tectonic-typesetting/tectonic/releases/download/")
        assert len(release.sha256) == 64
        assert int(release.sha256, 16) >= 0
        assert release.size > 1_000_000
