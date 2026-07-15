#!/usr/bin/env node
/* figlint — attachment checks for HAND-DRAWN svg figures in a deck.
 *
 * Scenes derive their edges, so arrows can't dangle; hand-drawn figures
 * are frozen coordinates, where every edit risks stranding an arrowhead
 * or a connector end. This lint parses each non-scene <svg> in a deck and
 * verifies:
 *   1. every chevron (V-shaped 3-point subpath) has its apex ON another
 *      path's point — an arrowhead must decorate a real line end
 *   2. every open subpath terminal is anchored: on a box edge, inside a
 *      box (in-glyph decoration), or coincident with another path point
 *
 * Usage: node scripts/figlint.mjs <deck.html> [--eps N]
 * Exit 1 when anything dangles.  stdlib only.
 */

import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) { console.error('usage: figlint <deck.html>'); process.exit(2) }
const EPS = Number(process.argv[process.argv.indexOf('--eps') + 1]) || 3
const html = readFileSync(file, 'utf8')

/* ---------- collect non-scene svgs, with their slide index ---------- */

const svgs = []
{
  const sections = html.split(/<section class="dia-slide/).slice(1)
  sections.forEach((sec, i) => {
    for (const m of sec.matchAll(/<svg\b[^>]*>([\s\S]*?)<\/svg>/g)) {
      const openTag = m[0].slice(0, m[0].indexOf('>') + 1)
      if (/class="[^"]*dia-scene/.test(openTag)) continue
      svgs.push({ slide: i + 1, body: m[1] })
    }
  })
}

/* ---------- parse geometry ---------- */

function parseTranslate(tag) {
  const t = /transform="translate\((-?[\d.]+)[ ,]+(-?[\d.]+)\)"/.exec(tag)
  return t ? { x: +t[1], y: +t[2] } : { x: 0, y: 0 }
}

/** absolute-command path data (M L H V Z, m l relative) → subpaths of points */
function subpathsOf(d, off) {
  const toks = d.match(/[MmLlHhVvZz]|-?[\d.]+(?:e-?\d+)?/g) ?? []
  const subs = []
  let cur = null
  let x = 0
  let y = 0
  let i = 0
  let cmd = ''
  const flush = () => { if (cur && cur.pts.length > 0) subs.push(cur); cur = null }
  while (i < toks.length) {
    if (/^[A-Za-z]$/.test(toks[i])) { cmd = toks[i]; i++; if (/z/i.test(cmd)) { if (cur) cur.closed = true; flush(); continue } }
    const read = () => +toks[i++]
    switch (cmd) {
      case 'M': flush(); x = read(); y = read(); cur = { pts: [], closed: false }; break
      case 'm': flush(); x += read(); y += read(); cur = { pts: [], closed: false }; break
      case 'L': x = read(); y = read(); break
      case 'l': x += read(); y += read(); break
      case 'H': x = read(); break
      case 'h': x += read(); break
      case 'V': y = read(); break
      case 'v': y += read(); break
      default: return null // curves and arcs: skip attachment analysis
    }
    if (cmd === 'M') cmd = 'L'
    if (cmd === 'm') cmd = 'l'
    cur?.pts.push({ x: x + off.x, y: y + off.y })
  }
  flush()
  return subs
}

for (const svg of svgs) {
  svg.boxes = []      // {x, y, w, h}
  svg.polys = []      // closed subpaths (diamonds, doc glyphs)
  svg.lines = []      // open subpaths
  svg.chevrons = []   // {apex}

  for (const m of svg.body.matchAll(/<rect\b[^>]*>/g)) {
    const a = (n) => { const r = new RegExp(`${n}="(-?[\\d.]+)"`).exec(m[0]); return r ? +r[1] : 0 }
    const off = parseTranslate(m[0])
    svg.boxes.push({ x: a('x') + off.x, y: a('y') + off.y, w: a('width'), h: a('height') })
  }
  for (const m of svg.body.matchAll(/<(?:circle|ellipse)\b[^>]*>/g)) {
    const a = (n, d0) => { const r = new RegExp(`${n}="(-?[\\d.]+)"`).exec(m[0]); return r ? +r[1] : d0 }
    const cx = a('cx', 0)
    const cy = a('cy', 0)
    const rx = a('rx', a('r', 0))
    const ry = a('ry', a('r', 0))
    svg.boxes.push({ x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry })
  }
  svg.texts = []
  for (const m of svg.body.matchAll(/<text\b[^>]*>/g)) {
    const a = (n) => { const r = new RegExp(`${n}="(-?[\\d.]+)"`).exec(m[0]); return r ? +r[1] : 0 }
    svg.texts.push({ x: a('x'), y: a('y') })
  }
  for (const m of svg.body.matchAll(/<path\b[^>]*>/g)) {
    const d = /\bd="([^"]+)"/.exec(m[0])?.[1]
    if (!d) continue
    const subs = subpathsOf(d, parseTranslate(m[0]))
    if (!subs) continue
    for (const sub of subs) {
      if (sub.closed) { svg.polys.push(sub.pts); continue }
      const pts = sub.pts
      const seg = (a, b) => Math.hypot(b.x - a.x, b.y - a.y)
      if (pts.length === 3 && seg(pts[0], pts[1]) <= 10 && seg(pts[1], pts[2]) <= 10) {
        svg.chevrons.push({ apex: pts[1] })
      } else {
        svg.lines.push(pts)
      }
    }
  }
}

/* ---------- attachment checks ---------- */

const near = (a, b, eps) => Math.hypot(a.x - b.x, a.y - b.y) <= eps

function onSegment(p, a, b, eps) {
  const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2
  if (len2 === 0) return near(p, a, eps)
  let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2
  t = Math.max(0, Math.min(1, t))
  return near(p, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }, eps)
}

function onBoxEdge(svg, p, eps) {
  for (const b of svg.boxes) {
    const c = [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }]
    for (let i = 0; i < 4; i++) if (onSegment(p, c[i], c[(i + 1) % 4], eps)) return true
  }
  for (const poly of svg.polys) {
    for (let i = 0; i < poly.length; i++) if (onSegment(p, poly[i], poly[(i + 1) % poly.length], eps)) return true
  }
  return false
}

function insideBox(svg, p) {
  if (svg.boxes.some((b) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h)) return true
  // closed glyphs (doc outlines, diamonds) shelter their decoration too
  return svg.polys.some((poly) => insidePoly(p, poly))
}

function insidePoly(p, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** a leader may end at a label — near a text anchor */
function nearText(svg, p) {
  return svg.texts.some((t) => Math.hypot(t.x - p.x, t.y - p.y) <= 18)
}

/** length of the part of segment a→b inside the box (Liang–Barsky) */
function clipLength(a, b, bx) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  let t0 = 0
  let t1 = 1
  for (const [p, q] of [
    [-dx, a.x - bx.x], [dx, bx.x + bx.w - a.x],
    [-dy, a.y - bx.y], [dy, bx.y + bx.h - a.y],
  ]) {
    if (p === 0) { if (q < 0) return 0; continue }
    const r = q / p
    if (p < 0) { if (r > t1) return 0; if (r > t0) t0 = r }
    else { if (r < t0) return 0; if (r < t1) t1 = r }
  }
  return Math.hypot(dx, dy) * Math.max(0, t1 - t0)
}

function onAnyPathPoint(svg, p, eps, skip) {
  for (const pts of svg.lines) {
    if (pts === skip) continue
    for (let i = 0; i < pts.length; i++) {
      if (near(p, pts[i], eps)) return true
      if (i > 0 && onSegment(p, pts[i - 1], pts[i], eps)) return true
    }
  }
  return svg.polys.some((poly) => poly.some((q) => near(p, q, eps)))
}

let bad = 0
for (const svg of svgs) {
  for (const ch of svg.chevrons) {
    // a chevron and its shaft must not merely anchor EACH OTHER — the
    // head of an arrow points AT something: a box edge or another path.
    // (no nearText: a LEADER may end at a label, an ARROWHEAD may not)
    const shaft = svg.lines.find((pts) =>
      near(ch.apex, pts[0], 8) || near(ch.apex, pts[pts.length - 1], 8)) ?? null
    // dead-on at a label: tight radius AND axis-aligned with the anchor
    const atLabel = svg.texts.some((t) =>
      near(ch.apex, t, 10) && (Math.abs(t.x - ch.apex.x) <= 4 || Math.abs(t.y - ch.apex.y) <= 4))
    const lands = onBoxEdge(svg, ch.apex, EPS) || insideBox(svg, ch.apex) ||
      onAnyPathPoint(svg, ch.apex, EPS, shaft) || atLabel
    if (!shaft && !lands) {
      console.log(`slide ${svg.slide}: ORPHAN ARROWHEAD at (${ch.apex.x}, ${ch.apex.y}) — no line ends here`)
      bad++
    } else if (shaft && !lands) {
      console.log(`slide ${svg.slide}: ARROW POINTS AT NOTHING — apex (${ch.apex.x}, ${ch.apex.y}) touches no box, path, or label`)
      bad++
    }
  }
  // connectors route AROUND boxes: flag any segment that passes THROUGH a
  // box interior. Decoration fully inside (or on) a box is welcome; a line
  // that stops at an edge has no interior span. Liang–Barsky clip length.
  for (const pts of svg.lines) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      for (const bx of svg.boxes) {
        const within = (p) => p.x >= bx.x - EPS && p.x <= bx.x + bx.w + EPS &&
          p.y >= bx.y - EPS && p.y <= bx.y + bx.h + EPS
        // a TERMINAL inside a box is decoration or a leader pointing at
        // something within — but an interior BEND inside a box means the
        // connector turns inside it: still a pass-through
        const aExempt = i === 1 && within(a)
        const bExempt = i === pts.length - 1 && within(b)
        if (aExempt || bExempt) continue
        // clip against the SHRUNKEN interior: a line running along a box
        // edge (grid lines on chart cells) is not a pass-through
        const inner = { x: bx.x + EPS, y: bx.y + EPS, w: bx.w - 2 * EPS, h: bx.h - 2 * EPS }
        if (inner.w > 0 && inner.h > 0 && clipLength(a, b, inner) > 6) {
          console.log(`slide ${svg.slide}: CONNECTOR CROSSES A BOX — segment (${a.x},${a.y})→(${b.x},${b.y}) passes through box at (${bx.x},${bx.y})`)
          bad++
        }
      }
    }
  }
  for (const pts of svg.lines) {
    const ends = [pts[0], pts[pts.length - 1]]
    const anchor = (p) => onBoxEdge(svg, p, EPS) || insideBox(svg, p) ||
      svg.chevrons.some((ch) => near(p, ch.apex, 8)) || // a line stops at the arrowhead's base
      onAnyPathPoint(svg, p, EPS, pts)
    // only CONNECTORS are held to attachment: a line with at least one end
    // on a box edge. Free strokes (charts, decorations) are exempt, but a
    // connector's far end must land on geometry, an arrowhead, or a label.
    if (!ends.some((p) => onBoxEdge(svg, p, EPS))) continue
    for (const p of ends) {
      if (!anchor(p) && !nearText(svg, p)) {
        console.log(`slide ${svg.slide}: DANGLING CONNECTOR END at (${p.x}, ${p.y}) — leaves a box and lands on nothing`)
        bad++
      }
    }
  }
}

const figCount = svgs.length
if (bad === 0) console.log(`figlint: ok — ${figCount} hand-drawn figures, every arrow lands`)
process.exit(bad === 0 ? 0 : 1)
