"""Skill evals — the ingest corpus as measurable golden cases (plan §7).

Each case is a folder under service/evals/<skill>/<name>/; the runner calls
the configured endpoint once per case and scores the output with the same
deterministic checks the pipeline itself enforces:

  translate-slide/<name>/input.html    (+ optional tokens.css)
  repair-fidelity/<name>/source.html + candidate.html + mismatch.txt
  lift-diagram/<name>/input.svg        (+ optional meta.toml: min_nodes, min_edges)

Scores are written to service/evals/results.json — a prompt or model change
becomes a diff in this file, not a vibe. Run with `dia eval` (needs the
installed service and a reachable endpoint); exit is 0 unless --strict.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import agents
from .validate import _parse, validate_html

EVALS_DIR = Path(__file__).parent.parent / "evals"


# ---------------------------------------------------------------------------
# deterministic checks (mirror the pipeline's own gates)
# ---------------------------------------------------------------------------

def visible_texts(html: str) -> list[str]:
    """Every element's own normalized text, script/style excluded."""
    out: list[str] = []
    for el in _parse(html).walk():
        if el.tag in ("script", "style", "noscript", "#doc"):
            continue
        t = " ".join(el.text.split())
        if t:
            out.append(t)
    return out


def text_coverage(source_html: str, output_html: str) -> float:
    """char-weighted fraction of source texts that reappear verbatim."""
    blob = " ".join(" ".join(el.text.split()) for el in _parse(output_html).walk())
    mapped = total = 0
    for t in visible_texts(source_html):
        total += len(t)
        if t in blob:
            mapped += len(t)
    return mapped / total if total else 1.0


def profile_ok(fragment_html: str) -> bool:
    """plant the fragment in a minimal probe deck and profile-validate it"""
    probe = (
        '<!doctype html><html data-dia-version="1"><head>'
        '<style id="dia-theme">:root{--dia-p:0}</style></head><body>'
        f"{fragment_html}"
        '<script id="dia-runtime"></script></body></html>'
    )
    return validate_html(probe)["ok"]


def is_single_slide(html: str) -> bool:
    root = _parse(html)
    tops = [
        el for el in root.walk()
        if el.tag == "section" and "dia-slide" in el.classes()
        and not any(p is not el and p.tag == "section" for p in _ancestors(el))
    ]
    return len(tops) == 1


def _ancestors(el):  # noqa: ANN001 — internal helper on validate.El
    cur = el.parent
    while cur is not None:
        yield cur
        cur = cur.parent


def scene_counts(html: str) -> tuple[int, int]:
    root = _parse(html)
    nodes = sum(1 for el in root.walk() if "data-dia-node" in el.attrs)
    edges = sum(1 for el in root.walk() if "data-dia-edge" in el.attrs)
    return nodes, edges


# ---------------------------------------------------------------------------
# case discovery + scoring
# ---------------------------------------------------------------------------

@dataclass
class CaseResult:
    skill: str
    name: str
    checks: dict[str, bool] = field(default_factory=dict)
    coverage: float | None = None
    error: str | None = None

    @property
    def passed(self) -> bool:
        return self.error is None and all(self.checks.values()) and (self.coverage is None or self.coverage >= 0.98)


async def run_case(skill: str, case_dir: Path, config: dict) -> CaseResult:
    res = CaseResult(skill=skill, name=case_dir.name)
    try:
        if skill == "translate-slide":
            source = (case_dir / "input.html").read_text(encoding="utf-8")
            tokens = _maybe(case_dir / "tokens.css") or ":root { --dia-paper: #fff; }"
            prompt = f"<token-css>\n{tokens}\n</token-css>\n\n<source-slide>\n{source}\n</source-slide>"
            out, _thinking = await agents.run_skill_once(skill, prompt, config)
            res.checks["single-dia-slide"] = is_single_slide(out)
            res.checks["in-profile"] = profile_ok(out)
            res.coverage = text_coverage(source, out)

        elif skill == "repair-fidelity":
            source = (case_dir / "source.html").read_text(encoding="utf-8")
            candidate = (case_dir / "candidate.html").read_text(encoding="utf-8")
            mismatch = (case_dir / "mismatch.txt").read_text(encoding="utf-8")
            tokens = _maybe(case_dir / "tokens.css") or ":root { --dia-paper: #fff; }"
            prompt = (
                f"<token-css>\n{tokens}\n</token-css>\n\n"
                f"<converted-slide>\n{candidate}\n</converted-slide>\n\n"
                f"<mismatch>\n{mismatch}\n\nRelevant source excerpt:\n{source}\n</mismatch>"
            )
            out, _thinking = await agents.run_skill_once(skill, prompt, config, images=_case_images(case_dir))
            res.checks["single-dia-slide"] = is_single_slide(out)
            res.checks["in-profile"] = profile_ok(out)
            # the repair must restore/keep every source text, not only the candidate's
            res.coverage = text_coverage(source, out)

        elif skill == "lift-diagram":
            svg = (case_dir / "input.svg").read_text(encoding="utf-8")
            out, _thinking = await agents.run_skill_once(skill, svg, config, images=_case_images(case_dir))
            meta = _meta(case_dir / "meta.toml")
            nodes, edges = scene_counts(out)
            res.checks["is-dia-scene"] = 'class="dia-scene"' in out or "dia-scene" in out.split(">", 1)[0]
            res.checks["scene-in-profile"] = profile_ok(f'<section class="dia-slide">{out}</section>')
            res.checks[f"nodes>={meta.get('min_nodes', 1)}"] = nodes >= int(meta.get("min_nodes", 1))
            res.checks[f"edges>={meta.get('min_edges', 0)}"] = edges >= int(meta.get("min_edges", 0))
            res.coverage = text_coverage(svg, out)
        else:
            res.error = f"unknown skill {skill}"
    except Exception as exc:  # noqa: BLE001 — a failed case is a result, not a crash
        res.error = str(exc)
    return res


def _maybe(p: Path) -> str | None:
    return p.read_text(encoding="utf-8") if p.is_file() else None


def _case_images(case_dir: Path) -> list[str]:
    """*.png in the case dir, sorted by name, as data URIs — mirrors the
    editor's [original, candidate, heatmap] convention (name them 1-*.png,
    2-*.png, 3-*.png). No pngs -> text-only run, same as before."""
    import base64

    return [
        "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode("ascii")
        for p in sorted(case_dir.glob("*.png"))
    ]


def _meta(p: Path) -> dict:
    if not p.is_file():
        return {}
    import tomllib

    with p.open("rb") as f:
        return tomllib.load(f)


# ---------------------------------------------------------------------------
# runner
# ---------------------------------------------------------------------------

async def run_all(skill_filter: str | None = None, evals_dir: Path = EVALS_DIR) -> list[CaseResult]:
    config = agents.load_config()
    results: list[CaseResult] = []
    for skill_dir in sorted(d for d in evals_dir.iterdir() if d.is_dir()):
        if skill_filter and skill_dir.name != skill_filter:
            continue
        for case_dir in sorted(d for d in skill_dir.iterdir() if d.is_dir()):
            results.append(await run_case(skill_dir.name, case_dir, config))
    return results


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    strict = "--strict" in args
    skill = None
    if "--skill" in args:
        skill = args[args.index("--skill") + 1]

    if not agents.ADK_AVAILABLE:
        print(f"dia eval: adk not installed ({agents.ADK_IMPORT_ERROR})", file=sys.stderr)
        return 2

    results = asyncio.run(run_all(skill))
    if not results:
        print("dia eval: no cases found", file=sys.stderr)
        return 2

    ok = 0
    for r in results:
        mark = "PASS" if r.passed else "FAIL"
        ok += r.passed
        cov = f" coverage={r.coverage:.3f}" if r.coverage is not None else ""
        checks = " ".join(f"{k}={'y' if v else 'N'}" for k, v in r.checks.items())
        err = f" error: {r.error}" if r.error else ""
        print(f"[{mark}] {r.skill}/{r.name}{cov} {checks}{err}")
    print(f"\n{ok}/{len(results)} cases passed")

    out = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "model": agents.endpoint_for(agents.load_config()).get("model"),
        "cases": [
            {"skill": r.skill, "name": r.name, "passed": r.passed,
             "coverage": r.coverage, "checks": r.checks, "error": r.error}
            for r in results
        ],
    }
    (EVALS_DIR / "results.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"results → {EVALS_DIR / 'results.json'}")
    return 1 if strict and ok < len(results) else 0
