"""The deck palettes and the editor's own palettes must be the same colours.

`src/chrome/tokens.css` is where the schemes are defined for the editor
chrome; `dia_service.themes` is the copy anything that WRITES a deck reads.
Two statements of one fact drift — that is how the authoring skill ended up
with a dracula `:root` block saying `ink-soft: #D8D8D2` and a dracula table
row saying `#D4D4CF` — so this reads the CSS and fails when they part.

The same shape as the twin-validator lockstep: the duplicate is deliberate
(the service must not need the editor's source at runtime), and the test is
what makes the duplicate safe.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from dia_service.themes import (
    DEFAULT_THEME,
    LIGHT_THEMES,
    THEME_NAMES,
    is_light,
    palette,
    subject_lines,
    theme_tokens_css,
)

TOKENS_CSS = Path(__file__).resolve().parents[2] / "src" / "chrome" / "tokens.css"


def css_palettes() -> dict[str, dict[str, str]]:
    """Every complete scheme in tokens.css. The bare `:root` block is the
    default scheme, which the file names by omission rather than by attribute."""
    want = ("paper", "ink", "ink-soft", "ink-faint", "accent", "rule", "good", "bad")
    out: dict[str, dict[str, str]] = {}
    css = TOKENS_CSS.read_text(encoding="utf-8")
    for m in re.finditer(r':root(?:\[data-theme="([a-z-]+)"\])?\s*\{([^}]*)\}', css):
        name = m.group(1) or DEFAULT_THEME
        found = dict(re.findall(r"--([a-z-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})", m.group(2)))
        got = {k: found[k] for k in want if k in found}
        if len(got) == len(want):
            out.setdefault(name, got)
    return out


@pytest.mark.skipif(not TOKENS_CSS.is_file(), reason="editor sources not present")
def test_every_editor_scheme_is_available_to_a_deck():
    """A scheme the editor can show and the scaffolder cannot write is a
    scheme no generated deck will ever use."""
    assert set(css_palettes()) == set(THEME_NAMES)


@pytest.mark.skipif(not TOKENS_CSS.is_file(), reason="editor sources not present")
@pytest.mark.parametrize("name", THEME_NAMES)
def test_a_scheme_is_the_same_colours_on_both_sides(name):
    expected = css_palettes()[name]
    got = palette(name)
    assert {k: v.lower() for k, v in got.items()} == {
        k: v.lower() for k, v in expected.items()
    }


def test_an_unknown_scheme_is_an_error_not_a_silent_default():
    """Falling back would hand back a deck in the wrong colours and say
    nothing — the failure this whole module exists to stop."""
    with pytest.raises(KeyError) as exc:
        palette("solarised-light")  # the British spelling, a plausible typo
    assert "solarized-light" in str(exc.value), "the error must list the real names"


def test_the_css_block_carries_every_token_a_deck_reads():
    css = theme_tokens_css("dracula")
    for token in ("paper", "ink", "ink-soft", "ink-faint", "accent", "rule", "good", "bad"):
        assert f"--dia-{token}:" in css
    # good/bad were missing from the authoring skill's table, so a deck that
    # needed pass/fail colour had to guess at them
    assert "--dia-good: #50FA7B;" in css
    assert "--dia-bad: #FF5555;" in css


def test_the_recommendations_name_real_schemes():
    for line in subject_lines():
        assert line.split(" — ")[0] in THEME_NAMES


def test_light_and_dark_are_both_offered():
    assert DEFAULT_THEME in LIGHT_THEMES
    assert all(is_light(n) for n in LIGHT_THEMES)
    assert not is_light("dracula")
    assert len(THEME_NAMES) - len(LIGHT_THEMES) >= 5, "dark schemes must be real options"


SKILL = Path(__file__).resolve().parents[2] / "skills" / "dia-authoring" / "SKILL.md"


def skill_palettes() -> dict[str, dict[str, str]]:
    """The schemes the authoring skill states, from its pasteable `:root`
    blocks and its reference table. Both forms, because the drift that
    prompted this test was BETWEEN them."""
    text = SKILL.read_text(encoding="utf-8")
    out: dict[str, dict[str, str]] = {}
    for m in re.finditer(r"/\* ([a-z-]+) —[^*]*\*/\s*:root \{([^}]*)\}", text):
        found = dict(re.findall(r"--dia-([a-z-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})", m.group(2)))
        out[m.group(1)] = found
    for row in re.findall(r"^\| ([a-z-]+) \| (.+) \|$", text, re.M):
        name, cells = row
        values = re.findall(r"`(#[0-9A-Fa-f]{3,8})`", cells)
        if name in THEME_NAMES and len(values) == 8:
            out[name] = dict(zip(
                ("paper", "ink", "ink-soft", "ink-faint", "rule", "accent", "good", "bad"),
                values,
            ))
    return out


@pytest.mark.skipif(not SKILL.is_file(), reason="skills not present")
def test_the_authoring_skill_states_the_same_colours():
    """The skill is pasted from by hand, so a wrong hex there ships in decks.
    It carried `#D8D8D2` for dracula's ink-soft where the palette says
    `#D4D4CF` — one character, and nothing could have caught it."""
    stated = skill_palettes()
    assert stated, "the skill should still carry pasteable palettes"
    for name, colours in stated.items():
        real = palette(name)
        for token, value in colours.items():
            assert value.lower() == real[token].lower(), (
                f"{name}: the skill says --dia-{token} is {value}, "
                f"the palette says {real[token]}"
            )


@pytest.mark.skipif(not SKILL.is_file(), reason="skills not present")
def test_every_scheme_reaches_someone_reading_the_skill():
    """A scheme in the code and nowhere in the docs is one no author picks."""
    assert set(skill_palettes()) == set(THEME_NAMES)
