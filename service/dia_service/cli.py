"""The `dia` CLI.

  dia <deck.html>        open the editor on a local file (watch + write back)
  dia edit <deck.html>   same, explicit
  dia ingest <file.html> open the editor with the import review on the file
  dia present <deck.html>open the deck in the browser (it presents itself)
  dia validate <file>…   profile-validate saved decks (exit 1 on errors)
  dia serve              run the inference service alone
  dia serve --editor     run the service AND host the editor (built-in demo deck)

`edit`/`ingest` host everything from one process: the inference service,
the /file bridge (allowlisted to the opened file), and the built editor
bundle at /editor. The editor bundle is looked up in $DIA_EDITOR_DIST,
then next to this package (repo layout: <repo>/dist).
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import webbrowser
from pathlib import Path
from urllib.parse import quote

from .validate import validate_html

# NOTE: `.main` (fastapi/uvicorn/adk) is imported lazily inside the commands
# that host the service — `dia validate` and `dia present` must work with
# nothing installed beyond the standard library.


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _find_editor_dist() -> Path | None:
    env = os.environ.get("DIA_EDITOR_DIST")
    candidates = [Path(env)] if env else []
    candidates.append(Path(__file__).resolve().parents[2] / "dist")  # repo layout
    candidates.append(Path.cwd() / "dist")
    for c in candidates:
        if (c / "index.html").is_file():
            return c
    return None


def _serve_editor_on(path: Path, query_key: str) -> int:
    """Host service + file bridge + editor, open the browser on the file."""
    try:
        from . import main as service_main
    except ModuleNotFoundError as exc:
        print(f"dia: service dependencies missing ({exc.name}) — install with "
              "`pip install -e service/` (see service/README.md)", file=sys.stderr)
        return 2
    if not path.is_file():
        print(f"dia: no such file: {path}", file=sys.stderr)
        return 2

    dist = _find_editor_dist()
    if dist is None:
        print(
            "dia: built editor not found — run `npm run build` in the diastil "
            "repo or set DIA_EDITOR_DIST to the dist directory",
            file=sys.stderr,
        )
        return 2

    resolved = path.resolve()
    service_main.OPENED_FILES.add(resolved)
    service_main.mount_editor(dist)

    url = (
        f"http://{service_main.HOST}:{service_main.PORT}/editor/"
        f"?{query_key}={quote(str(resolved))}"
    )
    print(f"dia: editing {resolved}")
    print(f"dia: {url}")
    threading.Timer(0.8, lambda: webbrowser.open_new_tab(url)).start()
    service_main.run()
    return 0


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------

def cmd_edit(path: str) -> int:
    return _serve_editor_on(Path(path), "file")


def cmd_ingest(path: str) -> int:
    return _serve_editor_on(Path(path), "import")


def cmd_present(path: str) -> int:
    p = Path(path).resolve()
    if not p.is_file():
        print(f"dia: no such file: {p}", file=sys.stderr)
        return 2
    webbrowser.open_new_tab(p.as_uri())
    print(f"dia: presenting {p}")
    return 0


def cmd_validate(paths: list[str]) -> int:
    any_errors = False
    for raw in paths:
        p = Path(raw)
        if not p.is_file():
            print(f"dia: no such file: {p}", file=sys.stderr)
            any_errors = True
            continue
        report = validate_html(p.read_text(encoding="utf-8"))
        errors = [f for f in report["findings"] if f["level"] == "error"]
        advisories = [f for f in report["findings"] if f["level"] == "advisory"]
        verdict = "ok" if report["ok"] else "OUT OF PROFILE"
        print(
            f"{p}: {verdict} — {report['slideCount']} slides, "
            f"{len(errors)} errors, {len(advisories)} advisories"
        )
        for f in report["findings"]:
            loc = f" at {f['locator']}" if f["locator"] else ""
            print(f"  [{f['level']}] {f['rule']}{loc}: {f['message']}")
        any_errors = any_errors or not report["ok"]
    return 1 if any_errors else 0


def cmd_serve(open_editor: bool = False) -> int:
    try:
        from . import main as service_main
    except ModuleNotFoundError as exc:
        print(f"dia: service dependencies missing ({exc.name}) — install with "
              "`pip install -e service/` (see service/README.md)", file=sys.stderr)
        return 2
    if open_editor:
        dist = _find_editor_dist()
        if dist is None:
            print(
                "dia: built editor not found — run `npm run build` in the diastil "
                "repo or set DIA_EDITOR_DIST to the dist directory",
                file=sys.stderr,
            )
            return 2
        service_main.mount_editor(dist)
        url = f"http://{service_main.HOST}:{service_main.PORT}/editor/"
        print(f"dia: editor at {url} (opens on the built-in demo deck)")
        threading.Timer(0.8, lambda: webbrowser.open_new_tab(url)).start()
    service_main.run()
    return 0


# ---------------------------------------------------------------------------
# entry
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)

    # `dia <deck.html>` sugar: a path as the first arg means edit
    if argv and argv[0] not in {"edit", "ingest", "present", "validate", "serve", "eval", "-h", "--help"}:
        argv.insert(0, "edit")

    parser = argparse.ArgumentParser(prog="dia", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("edit", help="open the editor on a local deck").add_argument("path")
    sub.add_parser("ingest", help="open the editor importing a foreign deck").add_argument("path")
    sub.add_parser("present", help="open a saved deck in the browser").add_argument("path")
    sub.add_parser("validate", help="profile-validate saved decks").add_argument("paths", nargs="+")
    sv = sub.add_parser("serve", help="run the inference service (add --editor to also host the editor)")
    sv.add_argument("--editor", action="store_true",
                    help="also host the editor at /editor (opens on the built-in demo deck)")
    ev = sub.add_parser("eval", help="run skill evals against the configured endpoint")
    ev.add_argument("--skill", default=None)
    ev.add_argument("--strict", action="store_true")

    args = parser.parse_args(argv)
    if args.cmd == "edit":
        sys.exit(cmd_edit(args.path))
    elif args.cmd == "ingest":
        sys.exit(cmd_ingest(args.path))
    elif args.cmd == "present":
        sys.exit(cmd_present(args.path))
    elif args.cmd == "validate":
        sys.exit(cmd_validate(args.paths))
    elif args.cmd == "eval":
        from .evals import main as eval_main

        eval_argv = (["--skill", args.skill] if args.skill else []) + (["--strict"] if args.strict else [])
        sys.exit(eval_main(eval_argv))
    else:
        sys.exit(cmd_serve(open_editor=args.editor))
