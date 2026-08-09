"""Asset writing — the one place client-supplied *paths* reach the disk.

The daemon is localhost-only, but "localhost-only" is not an access
control: any page the browser is showing can POST here. So every asset
name is treated as hostile.
"""

from __future__ import annotations

import base64

import pytest

from dia_service.texcompile import AssetError, write_assets

TRAVERSAL = [
    "../escape.tex",
    "../../etc/cron.d/pwn",
    "fig/../../out.tex",
    "a/b/../../../c.tex",
    "/etc/passwd",
    "/tmp/absolute.png",
    "\\windows\\style.png",
    "C:/drive.png",
    "main.tex",           # would replace the document being compiled
    "",
    " padded.tex",
]


@pytest.mark.parametrize("name", TRAVERSAL)
def test_rejected_paths(tmp_path, name):
    with pytest.raises(AssetError):
        write_assets(tmp_path, {name: "x"})
    # nothing was written on the way to the refusal
    assert list(tmp_path.rglob("*")) == []


def test_symlinked_workdir_still_contains(tmp_path):
    """macOS hands out /var/folders temp dirs that are symlinks to
    /private/var — the containment check has to survive that."""
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    write_assets(link, {"fig/a.txt": "hello"})
    assert (real / "fig" / "a.txt").read_text() == "hello"


def test_text_and_data_uri_assets(tmp_path):
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8
    names = write_assets(tmp_path, {
        "refs.bib": "@article{a, title={T}}",
        "fig/plot.png": "data:image/png;base64," + base64.b64encode(png).decode(),
    })
    assert sorted(names) == ["fig/plot.png", "refs.bib"]
    assert (tmp_path / "refs.bib").read_text().startswith("@article")
    assert (tmp_path / "fig" / "plot.png").read_bytes() == png


def test_malformed_data_uri_is_refused(tmp_path):
    with pytest.raises(AssetError, match="base64"):
        write_assets(tmp_path, {"a.png": "data:image/png,notbase64"})
    with pytest.raises(AssetError, match="undecodable"):
        write_assets(tmp_path, {"a.png": "data:image/png;base64,!!!!"})


def test_traversal_is_refused_before_the_job_exists(tmp_path, monkeypatch):
    """create() must not leave a half-built workdir behind when an asset is
    rejected — the refusal happens, then nothing remains."""
    from dia_service import tex, texcompile

    monkeypatch.setattr(tex, "discover", lambda **_: tex.TexCapability(
        engine="tectonic", path="/bin/true", version="x", synctex=True))
    with pytest.raises(AssetError):
        texcompile.create(tex_source="x", doc_id="d", assets={"../out.tex": "x"})
    assert texcompile.get("anything") is None


def test_adopts_sibling_bbl_when_no_bib(tmp_path):
    """arXiv bundles carry a precompiled .bbl named after the original main
    file; with the job named main.tex it must become main.bbl."""
    from dia_service.texcompile import _link_support_files

    source = tmp_path / "paper"
    source.mkdir()
    (source / "cot.tex").write_text("\\documentclass{article}")
    (source / "neurips_2022.bbl").write_text("\\begin{thebibliography}{1}\\end{thebibliography}")
    work = tmp_path / "work"
    work.mkdir()
    (work / "main.tex").write_text(
        "\\documentclass{article}\n\\bibliography{example_paper}\n")
    _link_support_files(work, source)
    assert (work / "diarefs.bbl").read_text().startswith("\\begin{thebibliography}")
    main = (work / "main.tex").read_text()
    assert "\\input{diarefs.bbl}" in main
    assert "\\bibliography{example_paper}" not in main


def test_leaves_bbl_alone_when_a_bib_can_regenerate_it(tmp_path):
    from dia_service.texcompile import _link_support_files

    source = tmp_path / "paper"
    source.mkdir()
    (source / "llama.tex").write_text("\\documentclass{article}")
    (source / "custom.bib").write_text("@misc{k, title={T}}")
    (source / "llama.bbl").write_text("\\begin{thebibliography}{1}\\end{thebibliography}")
    work = tmp_path / "work"
    work.mkdir()
    (work / "main.tex").write_text(
        "\\documentclass{article}\n\\bibliography{custom}\n")
    _link_support_files(work, source)
    assert not (work / "diarefs.bbl").exists()
    assert "\\bibliography{custom}" in (work / "main.tex").read_text()


# ---------------------------------------------------------------------------
# multi-file projects
# ---------------------------------------------------------------------------

def test_writes_a_chapter_into_a_subdirectory(tmp_path):
    """`\\input{chapters/intro}` ships as an asset named exactly that, so
    the workdir has to grow the directory. Before multi-file support the
    client never sent one; the path checks always allowed it."""
    written = write_assets(tmp_path, {"chapters/intro.tex": "\\section{Intro}\n"})
    assert written == ["chapters/intro.tex"]
    assert (tmp_path / "chapters" / "intro.tex").read_text() == "\\section{Intro}\n"


def test_a_nested_main_tex_is_not_the_document(tmp_path):
    """Only the workdir's OWN main.tex is the job. Refusing every file
    named main.tex anywhere refused a real project's `parts/main.tex`."""
    write_assets(tmp_path, {"parts/main.tex": "\\section{Part}\n"})
    assert (tmp_path / "parts" / "main.tex").exists()
    with pytest.raises(AssetError):
        write_assets(tmp_path, {"main.tex": "x"})


def test_links_a_chapter_subdirectory_into_the_workdir(tmp_path):
    """A CLI-opened project compiles from TEXINPUTS alone, with no grant
    and no client assets. tectonic has no kpathsea, so `chapters/` has to
    APPEAR beside main.tex — skipping directories meant a thesis opened
    from the CLI died on `File \'chapters/intro.tex\' not found`."""
    from dia_service.texcompile import _link_support_files

    source = tmp_path / "thesis"
    (source / "chapters").mkdir(parents=True)
    (source / "thesis.tex").write_text("\\documentclass{book}")
    (source / "chapters" / "intro.tex").write_text("\\chapter{Intro}\n")
    work = tmp_path / "work"
    work.mkdir()
    (work / "main.tex").write_text("\\documentclass{book}\n\\input{chapters/intro}\n")

    _link_support_files(work, source)
    assert (work / "chapters" / "intro.tex").read_text() == "\\chapter{Intro}\n"


def test_client_chapters_win_over_the_ones_on_disk(tmp_path):
    """The client\'s copies carry the user\'s unsaved edits. A subdirectory
    the assets already created is MERGED into, not replaced, so an edited
    chapter keeps its edits while its untouched siblings still arrive."""
    from dia_service.texcompile import _link_support_files

    source = tmp_path / "thesis"
    (source / "chapters").mkdir(parents=True)
    (source / "chapters" / "intro.tex").write_text("stale on disk")
    (source / "chapters" / "method.tex").write_text("untouched on disk")
    work = tmp_path / "work"
    work.mkdir()
    write_assets(work, {"chapters/intro.tex": "edited in the browser"})

    _link_support_files(work, source)
    assert (work / "chapters" / "intro.tex").read_text() == "edited in the browser"
    assert (work / "chapters" / "method.tex").read_text() == "untouched on disk"


def test_link_walk_stops_at_max_depth(tmp_path):
    """Bounded: the mirror describes a project layout, not whatever tree
    the user happened to have open."""
    from dia_service.texcompile import MAX_LINK_DEPTH, _link_support_files

    assert MAX_LINK_DEPTH == 3
    source = tmp_path / "src"
    deep = source / "a" / "b" / "c"
    deep.mkdir(parents=True)
    (deep / "far.tex").write_text("too far")
    work = tmp_path / "work"
    work.mkdir()

    _link_support_files(work, source)
    assert (work / "a" / "b").exists()
    assert not (work / "a" / "b" / "c" / "far.tex").exists()
