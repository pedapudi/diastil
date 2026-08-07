/* LaTeX line highlighter for the raw source view — pure text-in/HTML-out,
 * one line at a time so the overlay can memoize per line. Kinds are kept
 * coarse on purpose: commands, comments, math shifts, braces, env names.
 * Escaping is the invariant: output must render EXACTLY the input's
 * characters, or the overlay drifts out of register with the textarea. */

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const isLetter = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')

export function highlightLine(line: string): string {
  let out = ''
  let text = ''
  const flush = () => { out += escapeHtml(text); text = '' }
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === '\\') {
      flush()
      let j = i + 1
      if (j < line.length && isLetter(line[j])) {
        while (j < line.length && isLetter(line[j])) j++
      } else if (j < line.length) {
        j++ // control symbol \% \\ \$ …
      }
      const cs = line.slice(i, j)
      // env names read as their own kind: \begin{tabular} highlights both
      if ((cs === '\\begin' || cs === '\\end') && line[j] === '{') {
        const close = line.indexOf('}', j)
        if (close > 0) {
          out += `<span class="hl-cs">${escapeHtml(cs)}</span>{<span class="hl-env">${escapeHtml(line.slice(j + 1, close))}</span>}`
          i = close + 1
          continue
        }
      }
      out += `<span class="hl-cs">${escapeHtml(cs)}</span>`
      i = j
      continue
    }
    if (c === '%') {
      flush()
      out += `<span class="hl-comment">${escapeHtml(line.slice(i))}</span>`
      return out
    }
    if (c === '$') {
      flush()
      const len = line[i + 1] === '$' ? 2 : 1
      out += `<span class="hl-math">${'$'.repeat(len)}</span>`
      i += len
      continue
    }
    if (c === '{' || c === '}') {
      flush()
      out += `<span class="hl-brace">${c === '{' ? '{' : '}'}</span>`
      i++
      continue
    }
    text += c
    i++
  }
  flush()
  return out
}
