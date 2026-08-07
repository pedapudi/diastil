"""Page rasterization: the /pages geometry and the per-page PNGs.

Two layers. Most of it runs against the fake poppler in conftest, so the
answer does not depend on what the developer happens to have installed.
The last test runs a REAL compile with the managed tectonic and checks the
one thing a fake cannot establish: which way synctex's y axis points.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from collections import Counter
from pathlib import Path

import pytest

from dia_service import tex, texcompile

HELLO = "\\documentclass{article}\\begin{document}hi\\end{document}\n"

# The fake poppler's imaginary page, and what that becomes in pixels at the
# default dpi: 200/72*130 = 361.1 -> 361, 400/72*130 = 722.2 -> 722.
PAGE_PT = (200.0, 400.0)
PAGE_PX_AT_DEFAULT = (361, 722)


def fake_pdf(pages: int) -> bytes:
    """Enough PDF for the fake poppler to read a page count out of."""
    return (b"%PDF-1.4\n1 0 obj<</Type /Pages /Count "
            + str(pages).encode() + b">>endobj\n%%EOF\n")


def make_job(tmp_path: Path, pages: int | None = 1, count: int = 1) -> texcompile.CompileJob:
    """A finished job standing on a PDF, with no engine ever run.

    `pages` is what the log claimed (None = the log said nothing); `count`
    is what the PDF actually holds. They differ in one test on purpose."""
    workdir = tmp_path / "job"
    workdir.mkdir()
    (workdir / "main.pdf").write_bytes(fake_pdf(count))
    job = texcompile.CompileJob(
        id="j1", doc_id="d1", engine="tectonic", engine_path="/nonexistent",
        workdir=workdir)
    job.status = "ok"
    job.pages = pages
    return job


# ---------------------------------------------------------------------------
# capability
# ---------------------------------------------------------------------------

def test_capability_follows_the_tool_on_path(poppler):
    assert tex.page_render_tool() == "pdftoppm"
    assert tex.tool_path("pdftoppm") == str(poppler / "pdftoppm")
    assert tex.discover().as_dict()["pageRender"] is True


def test_capability_is_off_when_pdftoppm_is_missing(empty_path):
    assert tex.page_render_tool() is None
    assert tex.page_info_tool() is None
    assert tex.discover().as_dict()["pageRender"] is False


def test_page_render_is_reported_even_with_no_engine(poppler):
    """Poppler and LaTeX are separate installs — a machine that can render a
    PDF it cannot produce must say so, not report one flag for both."""
    capability = tex.discover().as_dict()
    assert capability["engine"] is None
    assert capability["pageRender"] is True


def test_tool_path_refuses_names_we_did_not_ask_for(poppler):
    assert tex.tool_path("rm") is None


# ---------------------------------------------------------------------------
# geometry
# ---------------------------------------------------------------------------

def test_geometry_from_pdfinfo(poppler, tmp_path):
    geo = texcompile.page_geometry(make_job(tmp_path))
    assert geo == {
        "available": True, "tool": "pdftoppm", "count": 1,
        "pages": [{"n": 1, "wPt": 200.0, "hPt": 400.0}],
        "ySemantics": "topDownPt",
    }


def test_geometry_falls_back_to_measuring_pixels(poppler_without_pdfinfo, tmp_path):
    """No pdfinfo: the size comes from the rendered PNG, which is the same
    answer to within half a pixel (0.28pt at 130dpi)."""
    geo = texcompile.page_geometry(make_job(tmp_path))
    assert geo["available"] is True and geo["count"] == 1
    page = geo["pages"][0]
    assert abs(page["wPt"] - PAGE_PT[0]) < 0.3
    assert abs(page["hPt"] - PAGE_PT[1]) < 0.3


def test_geometry_reasks_when_the_pdf_is_longer_than_the_log_said(poppler, tmp_path):
    """`pdfinfo -l N` needs the count we are asking it for. When the log's
    number is short (or absent), the second call gets the whole document."""
    geo = texcompile.page_geometry(make_job(tmp_path, pages=None, count=3))
    assert geo["count"] == 3
    assert [p["n"] for p in geo["pages"]] == [1, 2, 3]


def test_geometry_is_computed_once(poppler, tmp_path, monkeypatch):
    job = make_job(tmp_path)
    calls: list[list[str]] = []
    real = texcompile._capture
    monkeypatch.setattr(texcompile, "_capture",
                        lambda argv: (calls.append(argv), real(argv))[1])
    first = texcompile.page_geometry(job)
    assert calls and texcompile.page_geometry(job) == first
    assert len(calls) == 1, "the second call re-ran poppler"


def test_rotated_pages_report_the_size_as_rendered(poppler, tmp_path, monkeypatch):
    """/Rotate 90 makes poppler hand back a transposed image; wPt/hPt
    describe the image, so an overlay stays on the right axis."""
    monkeypatch.setattr(texcompile, "_capture", lambda argv: (
        "Pages:           1\n"
        "Page    1 size:  200.00 x 400.00 pts\n"
        "Page    1 rot:   90\n"))
    geo = texcompile.page_geometry(make_job(tmp_path))
    assert geo["pages"] == [{"n": 1, "wPt": 400.0, "hPt": 200.0}]


def test_geometry_unavailable_without_poppler(empty_path, tmp_path):
    geo = texcompile.page_geometry(make_job(tmp_path))
    assert geo["available"] is False and geo["tool"] is None
    assert geo["count"] == 0 and geo["pages"] == []
    assert "pdftoppm" in geo["reason"]
    # the axis is a property of parse_synctex, not of poppler — the client
    # can trust it on a machine that cannot render anything
    assert geo["ySemantics"] == "topDownPt"


def test_geometry_unavailable_while_the_job_is_unfinished(poppler, tmp_path):
    job = make_job(tmp_path)
    job.status = "running"
    geo = texcompile.page_geometry(job)
    assert geo["available"] is False and "running" in geo["reason"]


# ---------------------------------------------------------------------------
# rendering
# ---------------------------------------------------------------------------

def test_render_writes_into_the_workdir_and_caches(poppler, tmp_path, monkeypatch):
    job = make_job(tmp_path)
    png = texcompile.render_page(job, 1, 130)
    assert png is not None and png.parent == job.workdir
    assert texcompile._png_size(png) == PAGE_PX_AT_DEFAULT

    monkeypatch.setattr(texcompile, "_capture", lambda argv: pytest.fail(
        "a cached page must not re-run pdftoppm"))
    assert texcompile.render_page(job, 1, 130) == png


def test_render_keys_the_cache_on_dpi(poppler, tmp_path):
    job = make_job(tmp_path)
    a = texcompile.render_page(job, 1, 130)
    b = texcompile.render_page(job, 1, 260)
    assert a != b
    assert texcompile._png_size(b) == (722, 1444)


def test_render_refuses_pages_that_are_not_there(poppler, tmp_path):
    job = make_job(tmp_path)
    assert texcompile.render_page(job, 2, 130) is None
    assert texcompile.render_page(job, 0, 130) is None
    assert texcompile.render_page(job, -1, 130) is None


def test_render_needs_a_finished_job(poppler, tmp_path):
    job = make_job(tmp_path)
    job.status = "error"
    assert texcompile.render_page(job, 1, 130) is None


def test_dpi_clamping():
    assert texcompile.clamp_dpi(130) == 130
    assert texcompile.clamp_dpi(1) == texcompile.PAGE_DPI_MIN
    assert texcompile.clamp_dpi(-4000) == texcompile.PAGE_DPI_MIN
    assert texcompile.clamp_dpi(10_000) == texcompile.PAGE_DPI_MAX
    assert texcompile.clamp_dpi(96.7) == 96
    # junk falls back rather than raising: a preview is not worth a 500
    assert texcompile.clamp_dpi("nonsense") == texcompile.PAGE_DPI_DEFAULT
    assert texcompile.clamp_dpi(None) == texcompile.PAGE_DPI_DEFAULT


# ---------------------------------------------------------------------------
# the HTTP surface
# ---------------------------------------------------------------------------

pytest.importorskip("httpx", reason="TestClient needs httpx")

from fastapi.testclient import TestClient  # noqa: E402

from dia_service import main  # noqa: E402


@pytest.fixture
def client():
    with TestClient(main.app) as c:
        yield c


@pytest.fixture
def compiled(client, fake_engine, poppler, monkeypatch) -> str:
    """A job that reached `ok`, on a machine with (fake) poppler."""
    monkeypatch.setattr(tex, "discover", lambda **_: tex.TexCapability(
        engine="tectonic", path=str(fake_engine), version="fake-tex 1.0",
        synctex=True, page_render=True))
    job_id = client.post(
        "/compile", json={"texSource": HELLO, "docId": "d1"}).json()["jobId"]
    client.get(f"/compile/{job_id}/events")  # drains the stream; job is done
    return job_id


def test_pages_endpoint_shape(client, compiled):
    body = client.get(f"/compile/{compiled}/pages").json()
    assert body == {
        "available": True, "tool": "pdftoppm", "count": 1,
        "pages": [{"n": 1, "wPt": 200.0, "hPt": 400.0}],
        "ySemantics": "topDownPt",
    }


def test_page_png_endpoint(client, compiled):
    res = client.get(f"/compile/{compiled}/page/1.png")
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/png"
    assert res.content[:8] == b"\x89PNG\r\n\x1a\n"
    assert "immutable" in res.headers["cache-control"]

    same = client.get(f"/compile/{compiled}/page/1.png?dpi=130")
    assert same.content == res.content, "the default dpi is not 130"


def test_page_png_honors_and_clamps_dpi(client, compiled, tmp_path):
    def size(query: str) -> tuple[int, int]:
        res = client.get(f"/compile/{compiled}/page/1.png{query}")
        assert res.status_code == 200
        blob = tmp_path / "probe.png"
        blob.write_bytes(res.content)
        return texcompile._png_size(blob)

    assert size("?dpi=72") == (200, 400)          # 1px per pt
    assert size("?dpi=1") == size("?dpi=36")      # clamped up
    assert size("?dpi=100000") == size("?dpi=300")  # clamped down


def test_page_and_pages_404s(client, compiled):
    assert client.get("/compile/nosuchjob/pages").status_code == 404
    assert client.get("/compile/nosuchjob/page/1.png").status_code == 404
    assert client.get(f"/compile/{compiled}/page/2.png").status_code == 404
    assert client.get(f"/compile/{compiled}/page/0.png").status_code == 404


def test_pages_says_why_when_there_is_no_poppler(client, fake_engine, empty_path,
                                                 monkeypatch):
    monkeypatch.setattr(tex, "discover", lambda **_: tex.TexCapability(
        engine="tectonic", path=str(fake_engine), version="fake-tex 1.0",
        synctex=True))
    job_id = client.post(
        "/compile", json={"texSource": HELLO, "docId": "d1"}).json()["jobId"]
    client.get(f"/compile/{job_id}/events")
    body = client.get(f"/compile/{job_id}/pages").json()
    assert body["available"] is False and body["tool"] is None
    assert body["reason"]
    assert client.get(f"/compile/{job_id}/page/1.png").status_code == 404


def test_health_reports_page_render(client, poppler):
    assert client.get("/health").json()["tex"]["pageRender"] is True


# ---------------------------------------------------------------------------
# the real thing: which way does synctex's y axis point?
# ---------------------------------------------------------------------------

# Captured at import, before the autouse isolated_cache fixture repoints
# XDG_CACHE_HOME at a temp directory for every test.
_REAL_XDG_CACHE = os.environ.get("XDG_CACHE_HOME")

# 200x400pt paper with a 20pt margin, one line at the top of the text block
# and one shoved to the bottom by \vfill. Two lines whose ORDER on the page
# is known by construction is the whole experiment.
PROBE_DOC = """\\documentclass[11pt]{article}
\\usepackage[paperwidth=200pt,paperheight=400pt,margin=20pt]{geometry}
\\pagestyle{empty}
\\begin{document}
TOPLINE
\\vfill
BOTTOMLINE
\\end{document}
"""


def managed_tectonic() -> Path | None:
    base = Path(_REAL_XDG_CACHE) if _REAL_XDG_CACHE else Path.home() / ".cache"
    path = base / "diastil" / "tectonic" / tex.TECTONIC_VERSION / "tectonic"
    return path if path.is_file() else None


@pytest.fixture
def real_tectonic(monkeypatch):
    """The managed tectonic, with the real cache root restored.

    Restored for tectonic's sake, not ours: its package bundle lives under
    XDG_CACHE_HOME too, and pointing that at a temp directory would turn
    this test into a 300MB download."""
    if managed_tectonic() is None:
        pytest.skip("managed tectonic is not installed")
    if _REAL_XDG_CACHE:
        monkeypatch.setenv("XDG_CACHE_HOME", _REAL_XDG_CACHE)
    else:
        monkeypatch.delenv("XDG_CACHE_HOME", raising=False)
    tex.reset_cache()
    return managed_tectonic()


@pytest.mark.integration
def test_synctex_y_is_top_down_points(real_tectonic):
    """The claim in parse_synctex's docstring, checked against a real engine.

    If y grew upward from the bottom, TOPLINE would report the LARGER value
    and every scroll target in the editor would land at its mirror image.
    """
    job = texcompile.compile_sync(tex_source=PROBE_DOC, doc_id="ysem")
    assert job.status == "ok", job.detail or job.log[-800:]
    assert job.synctex_path is not None

    out = texcompile.parse_synctex(job.synctex_path)
    first = [r for r in out["lines"] if r["page"] == 1]
    assert len(first) >= 2

    top = min(first, key=lambda r: r["y"])
    bottom = max(first, key=lambda r: r["y"])
    # the record nearer the top of the PAGE is the one earlier in the SOURCE
    assert top["line"] < bottom["line"]
    # 20pt margin + one 11pt baseline puts the first line ~31pt down
    assert 20.0 < top["y"] < 60.0
    # \vfill put the other one at the foot of a 398.5pt page
    assert bottom["y"] > 350.0
    assert texcompile.SYNCTEX_Y_SEMANTICS == "topDownPt"


# ---------------------------------------------------------------------------
# the other real thing: does x tell you which COLUMN?
# ---------------------------------------------------------------------------

# 500pt paper, 25pt margins: a 450pt text block, which \twocolumn splits
# into two 220pt columns with a 10pt gutter. So column one starts at x=25
# and column two at x=255, and any record reporting 25 for type that is in
# column two — or 450 for a width — has lost the column.
COLUMN_DOC = "".join([
    "\\documentclass[twocolumn,10pt]{article}\n",
    "\\usepackage[paperwidth=500pt,paperheight=300pt,margin=25pt]{geometry}\n",
    "\\pagestyle{empty}\n",
    "\\begin{document}\n",
    # Numbered paragraphs, one per source line, long enough to wrap: the
    # text flows straight down column one and on into column two, so the
    # source line numbers on the page are in reading order by construction.
    *(f"\\par PARA{i:02d} " + " ".join(f"word{i:02d}x{j}" for j in range(12))
      + "\n" for i in range(1, 21)),
    "\\end{document}\n",
])
PAPER_W, MARGIN, COLUMN_W = 500.0, 25.0, 220.0


@pytest.mark.integration
def test_synctex_x_is_the_column_left_edge(real_tectonic):
    """The claim the whole `x` field rests on, against a real two-column
    compile: records cluster on the two column edges, and which cluster a
    line lands in matches where its type actually is.

    A client crops a compiled block by clustering a block's records on x.
    If x were measured from TeX's 1in reference point it would read 72.27
    here, and if the parser kept the enclosing page box instead of the
    line's own type, every line that ends a page would read column one.
    """
    job = texcompile.compile_sync(tex_source=COLUMN_DOC, doc_id="xsem")
    assert job.status == "ok", job.detail or job.log[-800:]
    assert job.synctex_path is not None

    out = texcompile.parse_synctex(job.synctex_path)
    assert out["xSemantics"] == "leftPt"
    first = [r for r in out["lines"] if r["page"] == 1]
    assert len(first) >= 8, first

    # exactly what a client does: cluster the page's records on x. The two
    # clusters are the columns — at the document's own margins, NOT at
    # TeX's 72.27pt reference point, and not both at the text block's 25.
    columns = sorted(x for x, _ in Counter(r["x"] for r in first).most_common(2))
    assert columns == [MARGIN, PAPER_W - MARGIN - COLUMN_W]

    left = [r for r in first if r["x"] == columns[0] and r.get("w") == COLUMN_W]
    right = [r for r in first if r["x"] == columns[1]]
    assert len(left) >= 4 and len(right) >= 4, (left, right)
    # w is the column, not the 450pt text block, so a crop stays in-column
    assert {r["w"] for r in right} == {COLUMN_W}

    # the payoff: the text flows down column one and into column two, so
    # every line in the right cluster comes after every line in the left
    assert max(r["line"] for r in left) < min(r["line"] for r in right)


@pytest.mark.integration
def test_two_column_x_agrees_with_the_pdf_itself(real_tectonic):
    """synctex's x, checked against where poppler finds the words.

    Same compile, second witness: poppler reads the finished PDF and has
    never heard of synctex. It reports the first GLYPH where synctex
    reports the box edge, so the two differ by the paragraph indent — this
    compares where the column break falls, not coordinates."""
    tool = shutil.which("pdftotext")
    if tool is None:
        pytest.skip("poppler is not installed")
    job = texcompile.compile_sync(tex_source=COLUMN_DOC, doc_id="xtruth")
    assert job.status == "ok", job.detail

    out = subprocess.run(  # noqa: S603 — argv list, never a shell
        [tool, "-bbox", "-f", "1", "-l", "1", str(job.pdf_path), "-"],
        capture_output=True, text=True).stdout
    marks = [float(m.group(1)) for m in re.finditer(
        r'<word xMin="([\d.]+)"[^>]*>PARA\d\d</word>', out)]
    assert len(marks) >= 8, "pdftotext found no markers to check against"

    records = [r for r in texcompile.parse_synctex(job.synctex_path)["lines"]
               if r["page"] == 1 and r.get("w") == COLUMN_W]
    # both witnesses split the page in the same place: as many paragraphs
    # in column one, as many in column two
    assert ([sum(x < PAPER_W / 2 for x in marks), sum(x >= PAPER_W / 2 for x in marks)]
            == [sum(r["x"] < PAPER_W / 2 for r in records),
                sum(r["x"] >= PAPER_W / 2 for r in records)])
    # …and the page poppler is reading really is two columns wide apart,
    # so the agreement above is about columns and not about one big block
    assert max(marks) - min(marks) > COLUMN_W


@pytest.mark.integration
def test_real_pdf_geometry_and_render(real_tectonic):
    """The same real PDF through the poppler path, if poppler is installed:
    the page size must be the paper we asked geometry for, and the PNG must
    be that size scaled by the dpi."""
    if tex.page_render_tool() is None:
        pytest.skip("poppler is not installed")
    job = texcompile.compile_sync(tex_source=PROBE_DOC, doc_id="geom")
    assert job.status == "ok", job.detail

    geo = texcompile.page_geometry(job)
    assert geo["available"] is True and geo["count"] == 1
    page = geo["pages"][0]
    # geometry's paper, as rounded by TeX's own sp arithmetic
    assert abs(page["wPt"] - 199.25) < 1.0
    assert abs(page["hPt"] - 398.51) < 1.0

    png = texcompile.render_page(job, 1, 150)
    size = texcompile._png_size(png)
    assert abs(size[0] - page["wPt"] * 150 / 72) <= 1
    assert abs(size[1] - page["hPt"] * 150 / 72) <= 1
