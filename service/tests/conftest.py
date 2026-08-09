"""Shared fixtures for the compile-service tests.

Nothing here needs a real TeX installation — that is the point. A machine
with no LaTeX at all must be able to run this suite and get the same
result as a machine with TeX Live, or the suite is really a report on the
developer's laptop.
"""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

import pytest

LOGS = Path(__file__).parent / "logs"


# The stand-in engine. It ignores its argv (every engine we drive gets a
# different one) and decides what to do from the document, so a test can
# ask for success, failure, or a hang by writing one line of LaTeX.
FAKE_ENGINE = '''#!@PYTHON@
import os, sys, time

if "--version" in sys.argv:
    print("fake-tex 1.0 (dia test engine)")
    sys.exit(0)

src = ""
try:
    src = open("main.tex", encoding="utf-8").read()
except OSError:
    pass

# every run appends, so a two-pass engine is visible in the pass counter
runs = 0
if os.path.exists("passes"):
    runs = int(open("passes").read() or 0)
open("passes", "w").write(str(runs + 1))

# Replay a captured real-engine log through the whole job. A golden .log
# fixture is only worth keeping if the code that CONSUMES it runs against
# it, workdir and all, and not just parse_log in isolation.
replay = os.environ.get("DIA_FAKE_LOG")
if replay:
    log = open(replay, encoding="utf-8").read()
    open("main.log", "w", encoding="utf-8").write(log)
    sys.stdout.write(log)
    sys.exit(1)

if "%HANG" in src:
    print("fake-tex: pretending to think")
    sys.stdout.flush()
    time.sleep(30)

if "%FAIL" in src:
    log = (
        "This is fake-tex, Version 1.0\\n"
        "(./main.tex\\n"
        "./main.tex:3: Undefined control sequence.\\n"
        "l.3 \\\\nope\\n"
        "No pages of output.\\n"
    )
    open("main.log", "w").write(log)
    sys.stdout.write(log)
    sys.exit(1)

open("main.log", "w").write(
    "This is fake-tex, Version 1.0\\n"
    "(./main.tex\\n"
    "LaTeX Warning: Reference `x' undefined on input line 4.\\n"
    ")\\n"
    "Output written on main.pdf (1 page, 99 bytes).\\n"
)
open("main.synctex", "w").write(
    "SyncTeX Version:1\\nUnit:1\\nContent:\\n{1\\n"
    "[1,0:0,52215287:30785863,47268805,0\\n"
    "(1,4:4736286,5209886:30785863,655360,196608\\n]\\n}1\\n"
)
open("main.pdf", "wb").write(
    b"%PDF-1.4\\n1 0 obj<</Type /Pages /Count 1>>endobj\\n"
    b"2 0 obj<</Type /Page /Parent 1 0 R>>endobj\\n%%EOF\\n"
)
print("fake-tex: wrote main.pdf")
'''


# The stand-in poppler. Both scripts describe the same imaginary document —
# FAKE_PAGE_PT-sized pages, however many the PDF's `/Count` says — so a test
# can check that the pdfinfo path and the measure-the-pixels fallback agree.
FAKE_PAGE_PT = (200.0, 400.0)

FAKE_PDFTOPPM = r'''#!@PYTHON@
"""pdftoppm stand-in: honors -r/-f/-l/-singlefile, writes a real PNG whose
pixel size is the page size at the requested dpi and whose pixels depend on
the page number (so a test can tell page 2 from page 1)."""
import re, struct, sys, zlib

W_PT, H_PT = 200.0, 400.0

argv = sys.argv[1:]
if "-v" in argv or "--version" in argv:
    sys.stderr.write("pdftoppm version 0.0.0 (dia test)\n")
    sys.exit(0)

dpi, first, last, single, rest = 150, 1, 1, False, []
i = 0
while i < len(argv):
    a = argv[i]
    if a in ("-r", "-f", "-l"):
        value = int(float(argv[i + 1]))
        dpi, first, last = (
            (value, first, last) if a == "-r" else
            (dpi, value, last) if a == "-f" else (dpi, first, value))
        i += 2
    elif a == "-singlefile":
        single = True
        i += 1
    elif a.startswith("-"):
        i += 1
    else:
        rest.append(a)
        i += 1

pdf, prefix = rest[0], rest[1]
m = re.search(rb"/Count\s+(\d+)", open(pdf, "rb").read())
count = int(m.group(1)) if m else 1
if first < 1 or first > count:
    sys.stderr.write("Wrong page range given: the first page (%d) can not be "
                     "after the last page (%d).\n" % (first, count))
    sys.exit(99)


def chunk(tag, data):
    crc = zlib.crc32(tag + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)


w = int(round(W_PT / 72.0 * dpi))
h = int(round(H_PT / 72.0 * dpi))
raw = b"".join(b"\x00" + bytes([(y + first * 37) % 256]) * w for y in range(h))
png = (b"\x89PNG\r\n\x1a\n"
       + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(raw))
       + chunk(b"IEND", b""))
name = prefix + (".png" if single else "-%d.png" % first)
open(name, "wb").write(png)
'''

FAKE_PDFINFO = r'''#!@PYTHON@
"""pdfinfo stand-in: the `Pages:` count plus one size/rot pair per page in
the -f..-l range, in poppler's exact column layout."""
import re, sys

W_PT, H_PT = 200.0, 400.0

argv = sys.argv[1:]
first, last, rest = 1, None, []
i = 0
while i < len(argv):
    if argv[i] in ("-f", "-l"):
        if argv[i] == "-f":
            first = int(argv[i + 1])
        else:
            last = int(argv[i + 1])
        i += 2
    elif argv[i].startswith("-"):
        i += 1
    else:
        rest.append(argv[i])
        i += 1

m = re.search(rb"/Count\s+(\d+)", open(rest[0], "rb").read())
count = int(m.group(1)) if m else 1
print("Producer:        dia test")
print("Pages:           %d" % count)
for n in range(max(1, first), min(count, count if last is None else last) + 1):
    print("Page %4d size:  %.2f x %.2f pts" % (n, W_PT, H_PT))
    print("Page %4d rot:   0" % n)
print("File size:       1234 bytes")
'''


def _write_exe(path: Path, body: str) -> Path:
    path.write_text(body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


@pytest.fixture
def fake_engine(tmp_path: Path) -> Path:
    """An executable that behaves enough like a TeX engine to drive a job."""
    return _write_exe(
        tmp_path / "fake-tex", FAKE_ENGINE.replace("@PYTHON@", sys.executable)
    )


@pytest.fixture
def fake_path(tmp_path: Path) -> Path:
    """A directory of engine stand-ins, for PATH-ladder tests."""
    d = tmp_path / "bin"
    d.mkdir()
    return d


@pytest.fixture
def poppler(tmp_path: Path, monkeypatch) -> Path:
    """A PATH holding only the fake pdftoppm and pdfinfo.

    Only those two: the real poppler on the developer's machine must not
    decide whether these tests pass, and neither must its absence on CI."""
    d = tmp_path / "poppler"
    d.mkdir()
    _write_exe(d / "pdftoppm", FAKE_PDFTOPPM.replace("@PYTHON@", sys.executable))
    _write_exe(d / "pdfinfo", FAKE_PDFINFO.replace("@PYTHON@", sys.executable))
    monkeypatch.setenv("PATH", str(d))
    from dia_service import tex

    tex.reset_cache()
    return d


@pytest.fixture
def poppler_without_pdfinfo(poppler: Path) -> Path:
    """pdftoppm alone — the machine where page sizes must come from pixels."""
    (poppler / "pdfinfo").unlink()
    from dia_service import tex

    tex.reset_cache()
    return poppler


@pytest.fixture(autouse=True)
def isolated_cache(tmp_path, monkeypatch):
    """Point the managed-install cache at a temp directory and drop the
    memoized capability, so no test sees (or writes) the developer's real
    ~/.cache/diastil, and no test inherits another's discovery result."""
    from dia_service import tex, texcompile

    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    tex.reset_cache()
    yield
    tex.reset_cache()
    texcompile.reset()


@pytest.fixture
def empty_path(monkeypatch):
    """No engines anywhere on PATH."""
    monkeypatch.setenv("PATH", os.pathsep.join([]))
    from dia_service import tex

    tex.reset_cache()
    return None
