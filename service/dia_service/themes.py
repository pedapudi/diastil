"""The deck colour schemes, as data.

The palettes were being restated in four places — `src/chrome/tokens.css`
(the editor's own themes), `skills/dia-authoring/SKILL.md` (four pasteable
`:root` blocks plus a twelve-row table), `src/chrome/pickers.ts` (swatches),
and a hardcoded copy in `scaffold.py`. Four statements of one fact drift:
the skill's dracula block and its dracula table row disagreed on `ink-soft`,
and the table carried no `good`/`bad` at all, so a deck that needed pass/fail
colour was told to "look up the zicato palette or reuse the nearest block's
pair" — which is guessing.

This module is the one machine-readable statement for anything that WRITES a
deck. `tokens.css` remains the source it was extracted from, and
`tests/test_themes.py` reads that file and fails if the two ever part company
— the lockstep the twin validators already use.

Scheme choice is part of authoring, not a default to inherit. A body of decks
that are all `paper` reads as one author who stopped deciding, so `subject_of`
carries the one-line brief per scheme that the scaffolding tools and the agent
manual both quote, rather than each restating it.
"""

from __future__ import annotations

# name -> (paper, ink, ink-soft, ink-faint, accent, rule, good, bad)
_PALETTES: dict[str, tuple[str, ...]] = {
    "paper": ("#F2EEDE", "#1A1A1A", "#33312B", "#85837A", "#1E6FCC", "#C6C3B6", "#216609", "#CC3E28"),
    "solarized-light": ("#FDF6E3", "#586E75", "#657B83", "#93A1A1", "#268BD2", "#E7DCBE", "#6B9B0B", "#DC322F"),
    "google-light": ("#FFFFFF", "#474A4E", "#5F6368", "#9FA1A4", "#1B9CB8", "#E2E3E4", "#34A853", "#EA4335"),
    "lunaria-light": ("#EBE4E1", "#363434", "#484646", "#898584", "#3778A9", "#CEC8C5", "#497D46", "#783C1F"),
    "belafonte-day": ("#D5CCBA", "#34292D", "#45373C", "#7F736E", "#426A79", "#BBB1A3", "#6E6A4E", "#BE100E"),
    "selenized-black": ("#181818", "#DEDEDE", "#B9B9B9", "#606060", "#56D8C9", "#353535", "#83C746", "#FF5E56"),
    "ubuntu": ("#300A24", "#EEEEEC", "#CBC3C9", "#8A7383", "#34E2E2", "#4B2640", "#8AE234", "#CC0000"),
    "solarized-dark": ("#04222B", "#93A1A1", "#839496", "#5E7079", "#2AA198", "#0E3540", "#8BB80E", "#E0483C"),
    "dracula": ("#282A36", "#F8F8F2", "#D4D4CF", "#6272A4", "#BD93F9", "#44475A", "#50FA7B", "#FF5555"),
    "monokai": ("#1e1f1c", "#f8f8f2", "#c9cabf", "#8f908a", "#66d9ef", "#3a3b34", "#a6e22e", "#f92672"),
    "google-dark": ("#202124", "#FFFFFF", "#E8EAED", "#989A9D", "#24C1E0", "#444548", "#34A853", "#EA4335"),
    "lunaria-eclipse": ("#323F46", "#DFE2ED", "#C9CDD7", "#8D949D", "#C8429F", "#4D5960", "#BEDBC1", "#BA9088"),
    "belafonte-night": ("#20111B", "#D5CCBA", "#968C83", "#675B59", "#6F8E97", "#35272E", "#A6A07A", "#D6403E"),
    "zenburn": ("#3A3A3A", "#DCDCCC", "#C5C5B8", "#83837C", "#8CD0D3", "#575754", "#8FB28F", "#CC9393"),
    "relaxed": ("#353A44", "#F7F7F7", "#D9D9D9", "#7F8287", "#7EAAC7", "#53575F", "#A0AC77", "#BC5653"),
    "espresso": ("#323232", "#FFFFFF", "#D9D9D9", "#8A8A8A", "#6C99BB", "#4C4C4C", "#A5C261", "#D25252"),
}

_TOKENS = (
    "paper", "ink", "ink-soft", "ink-faint", "accent", "rule", "good", "bad",
)

# What each scheme is FOR. The list is short on purpose: naming a subject for
# every one of the sixteen would be inventing distinctions, so the eight that
# earn a recommendation carry one and the rest are available by name.
_SUBJECTS: dict[str, str] = {
    "paper": "print-register technical work, reports, the neutral default",
    "solarized-light": "warm reading decks, teaching, essays",
    "lunaria-light": "soft humanist subjects, design, product",
    "belafonte-day": "archival, historical, literary material",
    "selenized-black": "systems and terminal subjects, neutral dark rooms",
    "ubuntu": "warm dark, community and open-source subjects",
    "solarized-dark": "cool dark, data-heavy evening venues",
    "dracula": "vivid dark, developer-culture audiences",
}

#: every scheme, light first, in the order a chooser should see them
THEME_NAMES: tuple[str, ...] = tuple(_PALETTES)

#: the scheme a deck falls back to when the author names none. It is the
#: house default, not a recommendation — see `subject_lines()`.
DEFAULT_THEME = "paper"

LIGHT_THEMES: tuple[str, ...] = (
    "paper", "solarized-light", "google-light", "lunaria-light", "belafonte-day",
)


def palette(name: str) -> dict[str, str]:
    """The eight colour tokens of one scheme. Unknown names raise, so a typo
    is an error rather than a silent fall back to the default."""
    if name not in _PALETTES:
        raise KeyError(
            f"unknown theme {name!r} — one of: {', '.join(THEME_NAMES)}"
        )
    return dict(zip(_TOKENS, _PALETTES[name]))


def theme_tokens_css(name: str, indent: str = "  ") -> str:
    """The `--dia-*` colour declarations of one scheme, ready to paste into a
    deck's `:root`. Faces and the type scale are prescriptive and identical
    across schemes, so they are the template's business, not this module's."""
    p = palette(name)
    return "\n".join(f"{indent}--dia-{k}: {p[k]};" for k in _TOKENS)


def subject_lines() -> list[str]:
    """`name — what it is for`, for the schemes that carry a recommendation."""
    return [f"{name} — {why}" for name, why in _SUBJECTS.items()]


def is_light(name: str) -> bool:
    return name in LIGHT_THEMES
