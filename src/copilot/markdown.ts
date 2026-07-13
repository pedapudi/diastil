/* Markdown-lite renderer for chat messages — the subset models actually
 * emit: paragraphs, headings, unordered/ordered lists, fenced code blocks,
 * inline code/bold/italic, and http(s) links. Built with DOM nodes, never
 * innerHTML, so model output cannot inject markup; unknown syntax degrades
 * to plain text. Deliberately no tables/images/html passthrough. */

export function renderMarkdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  // fenced code blocks split the document; everything between is prose
  const parts = src.split(/^```[^\n]*\n?/m)
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const pre = document.createElement('pre')
      pre.className = 'dia-md-pre'
      pre.textContent = parts[i].replace(/\n$/, '')
      frag.appendChild(pre)
    } else if (parts[i].trim()) {
      renderProse(parts[i], frag)
    }
  }
  return frag
}

function renderProse(text: string, out: DocumentFragment): void {
  const lines = text.split('\n')
  let para: string[] = []
  let list: HTMLElement | null = null

  const flushPara = () => {
    const t = para.join(' ').trim()
    para = []
    if (!t) return
    const p = document.createElement('p')
    p.className = 'dia-md-p'
    inline(t, p)
    out.appendChild(p)
  }
  const flushList = () => { list = null }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)

    if (heading) {
      flushPara(); flushList()
      const h = document.createElement('div')
      h.className = 'dia-md-h'
      inline(heading[2], h)
      out.appendChild(h)
    } else if (bullet || ordered) {
      flushPara()
      const tag = ordered ? 'ol' : 'ul'
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = document.createElement(tag)
        list.className = 'dia-md-list'
        out.appendChild(list)
      }
      const li = document.createElement('li')
      inline((bullet ?? ordered)![1], li)
      list.appendChild(li)
    } else if (line.trim() === '') {
      flushPara(); flushList()
    } else {
      flushList()
      para.push(line)
    }
  }
  flushPara()
}

/** inline spans: `code`, **bold**, *italic* / _italic_, [label](https://…) */
function inline(text: string, into: HTMLElement): void {
  const token =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/
  let rest = text
  while (rest) {
    const m = token.exec(rest)
    if (!m) { into.appendChild(document.createTextNode(rest)); return }
    if (m.index > 0) into.appendChild(document.createTextNode(rest.slice(0, m.index)))
    const hit = m[0]
    if (hit.startsWith('`')) {
      const code = document.createElement('code')
      code.className = 'dia-md-code'
      code.textContent = hit.slice(1, -1)
      into.appendChild(code)
    } else if (hit.startsWith('**')) {
      const b = document.createElement('strong')
      inline(hit.slice(2, -2), b)
      into.appendChild(b)
    } else if (hit.startsWith('*') || hit.startsWith('_')) {
      const i = document.createElement('em')
      inline(hit.slice(1, -1), i)
      into.appendChild(i)
    } else {
      const label = /^\[([^\]]+)\]/.exec(hit)![1]
      const a = document.createElement('a')
      a.className = 'dia-md-link'
      a.href = m[6]
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      inline(label, a)
      into.appendChild(a)
    }
    rest = rest.slice(m.index + hit.length)
  }
}
