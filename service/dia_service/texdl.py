"""One-click tectonic install.

A machine with no TeX is the common case, and telling the user to install
TeX Live is telling them to go away for an hour. Tectonic is a single
static binary that fetches the packages a document actually needs, so the
daemon can offer to fetch it: ~14–20MB, no root, no PATH changes, entirely
inside the diastil cache directory.

Everything about the download is pinned in code. The URL is a constant, the
sha256 is a constant, and the archive is verified before a single byte is
unpacked. There is deliberately no way to point this at another URL: an
"install from URL" knob on a localhost daemon is a remote-code-execution
primitive wearing a helpful hat.

`install_tectonic(progress_cb)` reports {phase, ...} dicts as it goes so
POST /tex/install can stream them; it returns the path to the binary.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import stat
import tarfile
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .tex import (
    TECTONIC_VERSION,
    managed_tectonic_dir,
    managed_tectonic_path,
    platform_key,
)

_BASE = (
    "https://github.com/tectonic-typesetting/tectonic/releases/download"
    f"/tectonic%40{TECTONIC_VERSION}/tectonic-{TECTONIC_VERSION}-"
)


@dataclass(frozen=True)
class Release:
    url: str
    sha256: str
    size: int


# Pinned tectonic 0.15.0 assets. Linux uses the musl builds: they are
# statically linked, so they run on any glibc vintage — the gnu build
# refuses to start on older distributions.
RELEASES: dict[str, Release] = {
    "linux-x86_64": Release(
        url=_BASE + "x86_64-unknown-linux-musl.tar.gz",
        sha256="dfb82876f2986862996e564fa507a9e576e0c1e3bee63c2c1bd677c2543e6407",
        size=14175003,
    ),
    "linux-aarch64": Release(
        url=_BASE + "aarch64-unknown-linux-musl.tar.gz",
        sha256="1f59f9fb8eb65e8ba18658fc9016767e7d3e12488ded8b8fffa34254e51ce42c",
        size=13978134,
    ),
    "macos-x86_64": Release(
        url=_BASE + "x86_64-apple-darwin.tar.gz",
        sha256="dd42576eaa4c0df58c243dd78b7b864d9deb405ffdfcdadd1b79a31faceab747",
        size=19860242,
    ),
    "macos-aarch64": Release(
        url=_BASE + "aarch64-apple-darwin.tar.gz",
        sha256="24bd46566fa30d41101848405e9cbc4645edb92d8f857c9d21262174fb70cd33",
        size=19787827,
    ),
}

DOWNLOAD_TIMEOUT_S = 300

ProgressCb = Callable[[dict], None]


class InstallError(RuntimeError):
    """Install failed for a reason worth showing the user verbatim."""


def _noop(_event: dict) -> None:
    pass


def _download(release: Release, dest: Path, progress: ProgressCb) -> None:
    """Stream the asset to `dest`, hashing as we go. Progress frames carry
    bytes/total so the client can draw a real bar; `total` falls back to the
    pinned size when the server sends no Content-Length."""
    digest = hashlib.sha256()
    got = 0
    try:
        with urllib.request.urlopen(release.url, timeout=DOWNLOAD_TIMEOUT_S) as resp:
            total = int(resp.headers.get("Content-Length") or release.size)
            with dest.open("wb") as out:
                while True:
                    chunk = resp.read(256 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
                    digest.update(chunk)
                    got += len(chunk)
                    progress({"phase": "download", "bytes": got, "total": total})
    except urllib.error.URLError as exc:
        raise InstallError(f"download failed: {exc.reason}") from exc
    except OSError as exc:
        raise InstallError(f"download failed: {exc}") from exc

    actual = digest.hexdigest()
    if actual != release.sha256:
        raise InstallError(
            "checksum mismatch — refusing to install. "
            f"expected {release.sha256}, got {actual}"
        )


def _extract_binary(archive: Path, into: Path) -> Path:
    """Pull exactly the `tectonic` binary out of the archive, ignoring
    everything else. Extracting the whole tarball would mean trusting its
    member paths; naming the one file we want means we cannot be talked
    into writing outside `into`."""
    exe = "tectonic.exe" if os.name == "nt" else "tectonic"
    try:
        with tarfile.open(archive, "r:gz") as tar:
            member = None
            for m in tar.getmembers():
                if m.isfile() and Path(m.name).name == exe:
                    member = m
                    break
            if member is None:
                raise InstallError(f"archive contains no {exe} binary")
            src = tar.extractfile(member)
            if src is None:  # pragma: no cover — isfile() already checked
                raise InstallError(f"archive member {member.name} is unreadable")
            into.mkdir(parents=True, exist_ok=True)
            target = into / exe
            with src, target.open("wb") as out:
                shutil.copyfileobj(src, out)
    except tarfile.TarError as exc:
        raise InstallError(f"archive is corrupt: {exc}") from exc

    mode = target.stat().st_mode
    target.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return target


def install_tectonic(progress_cb: ProgressCb | None = None) -> Path:
    """Download, verify, and unpack the pinned tectonic into the diastil
    cache. Idempotent: an existing managed binary is returned untouched.
    Re-discovers afterwards so /health reports the new engine immediately."""
    from . import tex

    progress = progress_cb or _noop

    existing = managed_tectonic_path()
    if existing.is_file():
        progress({"phase": "done", "path": str(existing), "cached": True})
        tex.reset_cache()
        return existing

    key = platform_key()
    release = RELEASES.get(key or "")
    if release is None:
        raise InstallError(
            f"no pinned tectonic build for this platform ({key or 'unsupported'}) — "
            "install TeX Live or tectonic yourself and it will be picked up"
        )

    progress({"phase": "start", "version": TECTONIC_VERSION, "url": release.url})
    target_dir = managed_tectonic_dir()
    target_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="dia-texdl-") as tmp:
        archive = Path(tmp) / "tectonic.tar.gz"
        _download(release, archive, progress)
        progress({"phase": "verify", "sha256": release.sha256})
        progress({"phase": "unpack"})
        binary = _extract_binary(archive, target_dir)

    cap = tex.discover(refresh=True)
    progress({"phase": "done", "path": str(binary), "engine": cap.as_dict()})
    return binary
