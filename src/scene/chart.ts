/* Charts as DATA — the scene contract applied to quantities.
 *
 * `svg.dia-chart` carries its truth in attributes:
 *   data-chart  — bar | line | scatter
 *   data-values — "Q1:12, Q2:19, Q3:7"  (entries split on , or ; —
 *                 label:number; line/scatter treat numeric labels as x)
 *   data-max    — optional y ceiling (else a nice ceiling of the data)
 *   data-unit   — optional y unit suffix ("%", "ms")
 *
 * renderChart() derives the visible chart into ONE replaceable group
 * (g.dia-chart-derived), token-bound throughout, so the file presents
 * without JS and re-themes with the deck — exactly like scene routing.
 * The editor re-derives on load and after ops; hand-written derived
 * content is never the truth. */

const NS = 'http://www.w3.org/2000/svg'

export interface ChartEntry { label: string; v: number }

export function parseChartValues(raw: string | null): ChartEntry[] | null {
  if (!raw) return null
  const out: ChartEntry[] = []
  for (const part of raw.split(/[,;]/)) {
    const p = part.trim()
    if (!p) continue
    const m = /^(.*?):\s*(-?\d+(?:\.\d+)?)$/.exec(p)
    if (!m) return null
    out.push({ label: m[1].trim(), v: parseFloat(m[2]) })
  }
  return out.length ? out : null
}

/** a friendly ceiling: 1/2/5 × 10^k at or above the data max */
function niceCeil(v: number): number {
  if (v <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p
  return 10 * p
}

const r1 = (n: number): number => Math.round(n * 10) / 10

export function isChart(el: Element): el is SVGSVGElement {
  return el instanceof SVGSVGElement && el.classList.contains('dia-chart')
}

export function renderChart(svg: SVGSVGElement): void {
  const kind = svg.getAttribute('data-chart')
  const values = parseChartValues(svg.getAttribute('data-values'))
  if (!kind || !values) return // the validator names the problem
  const vb = (svg.getAttribute('viewBox') ?? '0 0 430 300').trim().split(/[\s,]+/).map(Number)
  const [, , W, H] = vb.length === 4 && vb.every(Number.isFinite) ? vb : [0, 0, 430, 300]

  const doc = svg.ownerDocument
  let g = svg.querySelector(':scope > g.dia-chart-derived')
  if (!g) {
    g = doc.createElementNS(NS, 'g')
    g.setAttribute('class', 'dia-chart-derived')
    svg.appendChild(g)
  }
  g.textContent = ''
  g.setAttribute('style', 'font-family: var(--dia-face-label); font-size: 10px;')

  const padL = Math.round(W * 0.11)
  const padR = Math.round(W * 0.04)
  const padT = Math.round(H * 0.06)
  const padB = Math.round(H * 0.12)
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const unit = svg.getAttribute('data-unit') ?? ''
  const declaredMax = parseFloat(svg.getAttribute('data-max') ?? '')
  const ymax = Number.isFinite(declaredMax) && declaredMax > 0
    ? declaredMax
    : niceCeil(Math.max(...values.map((e) => e.v)))
  const yOf = (v: number): number => padT + plotH * (1 - Math.max(0, Math.min(1, v / ymax)))

  const el = (tag: string, attrs: Record<string, string>, text?: string): Element => {
    const node = doc.createElementNS(NS, tag)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
    if (text !== undefined) node.textContent = text
    g!.appendChild(node)
    return node
  }

  // frame: baseline + gridlines at 0 · ½ · full, labels in the margin
  el('path', { d: `M${padL},${padT + plotH} H${W - padR}`, style: 'stroke: var(--dia-rule); stroke-width: 1; fill: none;' })
  for (const f of [0.5, 1]) {
    el('path', {
      d: `M${padL},${r1(yOf(ymax * f))} H${W - padR}`,
      style: 'stroke: var(--dia-rule); stroke-width: 1; stroke-dasharray: 2 4; fill: none;',
    })
  }
  for (const f of [0, 0.5, 1]) {
    el('text', {
      x: String(padL - 6), y: String(r1(yOf(ymax * f) + 3)), 'text-anchor': 'end',
      style: 'fill: var(--dia-ink-faint);',
    }, `${r1(ymax * f)}${unit}`)
  }

  const numericX = values.every((e) => Number.isFinite(parseFloat(e.label)))
  const xOf = (i: number): number => {
    if ((kind === 'line' || kind === 'scatter') && numericX) {
      const xs = values.map((e) => parseFloat(e.label))
      const lo = Math.min(...xs)
      const hi = Math.max(...xs)
      return hi === lo ? padL + plotW / 2 : padL + plotW * ((xs[i] - lo) / (hi - lo))
    }
    return padL + (plotW * (i + 0.5)) / values.length
  }

  if (kind === 'bar') {
    const band = plotW / values.length
    const barW = Math.max(4, band * 0.58)
    values.forEach((e, i) => {
      const x = padL + band * i + (band - barW) / 2
      const y = yOf(e.v)
      el('rect', {
        x: r1(x).toString(), y: r1(y).toString(), width: r1(barW).toString(),
        height: r1(padT + plotH - y).toString(),
        style: 'fill: var(--dia-accent);',
      })
      el('text', {
        x: r1(x + barW / 2).toString(), y: r1(y - 4).toString(), 'text-anchor': 'middle',
        style: 'fill: var(--dia-ink-soft);',
      }, `${e.v}${unit}`)
      el('text', {
        x: r1(x + barW / 2).toString(), y: String(padT + plotH + 14), 'text-anchor': 'middle',
        style: 'fill: var(--dia-ink-faint);',
      }, e.label)
    })
  } else {
    if (kind === 'line') {
      const pts = values.map((e, i) => `${r1(xOf(i))},${r1(yOf(e.v))}`).join(' ')
      el('polyline', { points: pts, style: 'fill: none; stroke: var(--dia-accent); stroke-width: 1.6; stroke-linejoin: round;' })
    }
    values.forEach((e, i) => {
      el('circle', {
        cx: r1(xOf(i)).toString(), cy: r1(yOf(e.v)).toString(),
        r: kind === 'scatter' ? '2.8' : '2.2',
        style: 'fill: var(--dia-accent);',
      })
    })
    // x labels: ends only when numeric (dense), every entry otherwise
    const labelIdx = numericX ? [0, values.length - 1] : values.map((_, i) => i)
    for (const i of new Set(labelIdx)) {
      el('text', {
        x: r1(xOf(i)).toString(), y: String(padT + plotH + 14), 'text-anchor': 'middle',
        style: 'fill: var(--dia-ink-faint);',
      }, values[i].label)
    }
  }
}

/** derive every chart under a root — idempotent, called at load and
 * after ops, exactly like scene routing */
export function renderAllCharts(root: ParentNode): void {
  for (const svg of root.querySelectorAll<SVGSVGElement>('svg.dia-chart')) renderChart(svg)
}
