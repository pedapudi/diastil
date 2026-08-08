"""TeX toolchain discovery.

Finds a usable engine and reports what it can do, so the editor can gate
the compile UI honestly: a machine with no TeX gets `engine: null` plus a
`downloadable` flag, not a broken button. The ladder, best first:

  1. managed tectonic   ~/.cache/diastil/tectonic/<version>/tectonic
  2. tectonic on PATH
  3. latexmk            (drives whatever engine the document wants)
  4. xelatex
  5. pdflatex

Tectonic leads because it is the one engine that needs no TeX Live: it
fetches packages on demand and we can install it ourselves (texdl.py).
`[tex] engine = "xelatex"` in config.toml pins the choice; an engine named
there that is not installed is reported as missing rather than silently
replaced — a pin the tool ignores is worse than no pin.

Probes are cheap (`--version`, 3s cap) and the result is cached in-process;
`discover(refresh=True)` re-probes after an install or a config change.

Poppler's command-line tools are discovered the same way, for a different
job: turning a compiled PDF into page images the editor can show inline.
They are a separate axis from the engine — a machine can rasterize PDFs it
cannot produce, and vice versa — so they get their own capability flag.

`biber` is a third, separate axis, discovered the same PATH-only way
(biber_path()): it is biblatex's real bibliography backend, and a machine
can have a fine TeX engine and no biber at all. See biber_path()'s
docstring for why there is no managed download for it, and
texcompile.biblatex_bibtex_backend_finding for what happens when a
document needs it and it is missing.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path

from . import agents

# The engines we know how to drive, best first. compile.py has a matching
# argv builder for each — adding one here without one there is a bug.
ENGINES = ("tectonic", "latexmk", "xelatex", "pdflatex")

# Version pinned by texdl.py; the managed install lives under it so an
# upgrade lands in a new directory instead of overwriting a running binary.
TECTONIC_VERSION = "0.15.0"

PROBE_TIMEOUT_S = 3.0

# Poppler utilities we shell out to for page rasterization. Invoked, never
# imported: poppler's Python bindings are a build-time dependency we refuse
# to impose, and `pdftoppm` ships with every PDF viewer on Linux and with
# `brew install poppler` on macOS. `pdfinfo` is optional — it only makes the
# page-size answer cheaper and more exact (see texcompile.page_geometry).
PAGE_TOOLS = ("pdftoppm", "pdfinfo")


@dataclass
class TexCapability:
    """What the daemon can do about LaTeX right now.

    engine/path/version are None when nothing was found. `synctex` is a
    static property of the engine (all four support it); it exists so the
    client can disable SyncTeX-dependent UI without knowing engine names.
    `downloadable` says POST /tex/install would plausibly work here —
    i.e. we have a pinned tectonic build for this platform.

    `page_render` is independent of all of the above: it says a compiled PDF
    can be turned into page images, which is what the editor's island
    previews need. It is reported even when there is no engine at all,
    because the two are genuinely separate installs.

    `biber` is independent too, and for the same reason: it is biblatex's
    real bibliography backend (see biber_path()), a document can need it
    with any of the four engines, and a machine can have TeX but no biber
    or vice versa. Reported even when there is no engine at all so the
    client can say why citations will be wrong before the user even tries.
    """

    engine: str | None = None
    path: str | None = None
    version: str | None = None
    synctex: bool = False
    downloadable: bool = False
    managed: bool = False
    detail: str | None = None
    page_render: bool = False
    biber: bool = False

    def as_dict(self) -> dict:
        # the wire format is camelCase like the rest of the API (jobId,
        # durationMs); only this one field has two words in it
        d = asdict(self)
        d["pageRender"] = d.pop("page_render")
        return d


# ---------------------------------------------------------------------------
# cache dir
# ---------------------------------------------------------------------------

def cache_root() -> Path:
    """XDG_CACHE_HOME-aware ~/.cache/diastil. Honors the env var because
    the managed install must land where the user's system says caches go —
    on a machine with a small home and a big cache mount, guessing wrong
    means a 20MB download in the wrong place."""
    xdg = os.environ.get("XDG_CACHE_HOME")
    base = Path(xdg) if xdg else Path.home() / ".cache"
    return base / "diastil"


def managed_tectonic_dir(version: str = TECTONIC_VERSION) -> Path:
    return cache_root() / "tectonic" / version


def managed_tectonic_path(version: str = TECTONIC_VERSION) -> Path:
    exe = "tectonic.exe" if os.name == "nt" else "tectonic"
    return managed_tectonic_dir(version) / exe


# ---------------------------------------------------------------------------
# probing
# ---------------------------------------------------------------------------

_VERSION_LINE = re.compile(r"^[^\r\n]{0,200}")


def _dedupe(line: str) -> str:
    """`tectonic 0.15.0Tectonic 0.15.0` -> `tectonic 0.15.0`.

    Tectonic prints clap's version string and its own banner back to back
    with no separator. Only an exact case-insensitive doubling is collapsed,
    so no other engine's version can be mangled by this."""
    half, odd = divmod(len(line), 2)
    if not odd and half and line[:half].lower() == line[half:].lower():
        return line[:half]
    return line


def probe_version(path: str | Path) -> str | None:
    """Run `<engine> --version` and return its first line, or None if the
    binary does not exist / is not runnable / hangs. Nothing here is fatal:
    an unprobeable engine is simply not offered."""
    try:
        proc = subprocess.run(
            [str(path), "--version"],
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT_S,
            # a probe must never inherit a terminal or wait on stdin
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    out = (proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")
    for line in out.splitlines():
        line = line.strip()
        if line:
            m = _VERSION_LINE.match(line)
            return _dedupe(m.group(0) if m else line)
    # pdflatex --version writes to stdout; if a build writes nothing at all
    # but exits cleanly, treat it as present with an unknown version
    return "" if proc.returncode == 0 else None


def platform_key() -> str | None:
    """`<os>-<arch>` for the platforms we ship a pinned tectonic for, else
    None (the client then shows "no engine" without an install offer)."""
    import platform as _platform
    import sys

    machine = _platform.machine().lower()
    arch = {
        "x86_64": "x86_64", "amd64": "x86_64",
        "aarch64": "aarch64", "arm64": "aarch64",
    }.get(machine)
    if arch is None:
        return None
    if sys.platform.startswith("linux"):
        return f"linux-{arch}"
    if sys.platform == "darwin":
        return f"macos-{arch}"
    return None


def _downloadable() -> bool:
    from .texdl import RELEASES

    return platform_key() in RELEASES


# ---------------------------------------------------------------------------
# poppler (PDF page rasterization)
# ---------------------------------------------------------------------------

_tools: dict[str, str | None] = {}


def tool_path(name: str) -> str | None:
    """Absolute path of a poppler utility, or None if it is not installed.

    Cached like the engine probes: /health is polled and /compile/{id}/pages
    is hit once per compile, and a PATH walk per call buys nothing — a tool
    does not appear mid-session. `reset_cache()` forgets, for tests and for
    the user who just installed poppler.

    Resolved to an absolute path on purpose: everything downstream execs it,
    and execing a bare name would re-read PATH in the child's environment
    rather than the one we probed."""
    if name not in PAGE_TOOLS:
        return None
    if name not in _tools:
        _tools[name] = shutil.which(name)
    return _tools[name]


def page_render_tool() -> str | None:
    """`'pdftoppm'` when this machine can rasterize a PDF page, else None."""
    return "pdftoppm" if tool_path("pdftoppm") else None


def page_info_tool() -> str | None:
    """`'pdfinfo'` when page geometry can be read without rendering, else
    None. Optional: page_geometry() falls back to measuring rendered pixels."""
    return "pdfinfo" if tool_path("pdfinfo") else None


# ---------------------------------------------------------------------------
# biber (biblatex's real bibliography backend — issue #23)
# ---------------------------------------------------------------------------

_biber: dict[str, str | None] = {}


def biber_path() -> str | None:
    """Absolute path to `biber` on PATH, or None. PATH discovery only, like
    tool_path() above — deliberately NOT a managed download.

    Unlike tectonic, biber has no single GitHub Releases page with one
    checksummed archive per platform; upstream ships per-platform binaries
    through SourceForge under names that move release to release. texdl.py's
    whole design is that nothing is fetched without a URL and sha256 pinned
    in code and verified before use (see its module docstring); a URL or
    hash we cannot ourselves confirm would be exactly the "invented" pin
    that design refuses to ship, so installing biber is left to the user —
    their OS package manager, TeX Live/MacTeX (both bundle it), or CTAN.

    Once biber IS on PATH, nothing else here has to change to use it: a
    real compile (this repo's own managed tectonic 0.15.0, verified by
    hand while fixing issue #23) shells out to an external `biber` on its
    own for a document using biblatex's default backend — no flag, no
    code path in this module drives it — and latexmk has auto-detected and
    run biber with zero configuration since v4.22 (2011; CTAN latexmk.txt,
    `$bibtex_use`). What biber_path() is FOR is telling the user the truth
    when it is missing: see texcompile.biblatex_bibtex_backend_finding.

    Cached like tool_path(): a compile-heavy session polls this a lot, and
    a binary does not appear mid-session. reset_cache() forgets it too."""
    if "biber" not in _biber:
        _biber["biber"] = shutil.which("biber")
    return _biber["biber"]


# ---------------------------------------------------------------------------
# discovery
# ---------------------------------------------------------------------------

_cache: TexCapability | None = None


def _candidates(config: dict) -> list[tuple[str, str]]:
    """(engine, path) pairs to probe, in order. Honors the config pin."""
    pinned = str(config.get("tex", {}).get("engine", "") or "").strip()

    ladder: list[tuple[str, str]] = []
    managed = managed_tectonic_path()
    if managed.is_file():
        ladder.append(("tectonic", str(managed)))
    for name in ENGINES:
        found = shutil.which(name)
        if found:
            ladder.append((name, found))

    if not pinned:
        return ladder
    # A pin filters the ladder — it never adds a path we did not find, and
    # never falls back to a different engine (see module docstring).
    return [c for c in ladder if c[0] == pinned]


def discover(refresh: bool = False, config: dict | None = None) -> TexCapability:
    """Best available engine. Cached: /health calls this on every poll."""
    global _cache
    if _cache is not None and not refresh:
        return _cache

    cfg = config if config is not None else agents.load_config()
    pinned = str(cfg.get("tex", {}).get("engine", "") or "").strip()
    downloadable = _downloadable()
    managed = managed_tectonic_path()
    page_render = page_render_tool() is not None
    biber = biber_path() is not None

    for engine, path in _candidates(cfg):
        version = probe_version(path)
        if version is None:
            continue
        _cache = TexCapability(
            engine=engine,
            path=path,
            version=version or None,
            synctex=True,
            downloadable=downloadable,
            managed=(engine == "tectonic" and Path(path) == managed),
            page_render=page_render,
            biber=biber,
        )
        return _cache

    detail = (
        f"config pins [tex] engine = {pinned!r}, which is not installed"
        if pinned else "no TeX engine found"
    )
    _cache = TexCapability(
        downloadable=downloadable, detail=detail, page_render=page_render,
        biber=biber)
    return _cache


def timeout_s(config: dict | None = None) -> float:
    """`[tex] timeout_s`, default 180. A first tectonic run downloads its
    package bundle, so the default is generous; a wedged engine still dies."""
    cfg = config if config is not None else agents.load_config()
    raw = cfg.get("tex", {}).get("timeout_s", 180)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 180.0
    return value if value > 0 else 180.0


def reset_cache() -> None:
    """Drop the memoized capability (tests; post-install re-discovery)."""
    global _cache
    _cache = None
    _tools.clear()
    _biber.clear()
