#!/usr/bin/env node
/* capture-mirror-fixture — freeze a paper's synctex + page ink for the
 * blockmirror crop-math replay test (src/doc/blockmirror.fixture.test.ts).
 *
 * The live cycle for tuning the compiled mirror is: rebuild, restart the
 * daemon, recompile a real paper, wait for the mirror pass, inspect in the
 * browser — 4-6 minutes per try. Two things go in the fixture and they
 * play opposite roles. The synctex BOX TREE (page, rectangle, and whose
 * source line's material stands in it) is the crop math's whole input.
 * Each page's INK (which points hold marks, at which device rows) is the
 * ORACLE: nothing in production reads it, and the fixture test uses it to
 * check that a crop holds all of its block's ink and none of a neighbour's
 * — an answer computed a completely different way from the one under test.
 * Both are sitting in the daemon's workdir the moment a compile finishes.
 * This script freezes them into one JSON fixture so `npm test` can replay
 * the real pipeline (src/doc/blockmirror.ts's cutDocument) against a paper
 * in milliseconds, no daemon, no browser, no canvas.
 *
 * Usage:
 *   node scripts/capture-mirror-fixture.mjs --workdir /tmp/dia-tex-xxxx \
 *     --paper llama --out corpus/fixtures/mirror/llama.json
 *
 * The workdir is whatever the dia daemon left behind after compiling a
 * corpus paper (see the issue #7 write-up for how to produce one): it needs
 * main.synctex.gz, main.pdf and one page-N-r<dpi>.png per rendered page
 * (pdftoppm's naming; a page the browser never scrolled to may be missing,
 * which is fine — the fixture just omits it, same as a real pass that never
 * decoded that page).
 *
 * PNG decoding is hand-rolled (zlib inflate + PNG defiltering) rather than
 * pulled in from a dependency: pdftoppm's output is always 8-bit, non-
 * interlaced, greyscale/RGB/RGBA — a few dozen lines cover it, and node's
 * built-in zlib does the actual inflate. No new dependency, dev or runtime.
 *
 * Ink is scanned with the same rule the oracle applies in the test — sum of
 * channel diffs from the page's own top-left pixel, thresholded at
 * src/doc/pageink.ts's `INK`. That threshold is duplicated here (this
 * script has no TypeScript loader to import it with); if it ever moves,
 * recapture. */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { gzipSync, inflateSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// kept in sync by hand with src/doc/pageink.ts's exported `INK` — see the file
// header above
const INK_THRESHOLD = 24

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i++ }
  }
  return out
}

function usage() {
  console.error('usage: capture-mirror-fixture --workdir <dir> --paper <name> [--out <path>] [--dpi <n>]')
  process.exit(2)
}

const args = parseArgs(process.argv.slice(2))
if (!args.workdir || !args.paper) usage()
const workdir = resolve(args.workdir)
const paper = args.paper
// its own subdirectory, not corpus/fixtures/ directly — that directory's
// *.json are all read as DECK corpus fixtures by src/ingest/corpus.test.ts,
// which would choke on a mirror fixture's unrelated shape
const outPath = resolve(repoRoot, args.out ?? `corpus/fixtures/mirror/${paper}.json`)

/* ---------- 1. synctex, via the daemon's own parser ---------- */

function findSynctex() {
  const gz = join(workdir, 'main.synctex.gz')
  if (existsSync(gz)) return gz
  const plain = join(workdir, 'main.synctex')
  if (existsSync(plain)) return plain
  console.error(`capture-mirror-fixture: no main.synctex(.gz) in ${workdir}`)
  process.exit(1)
}

function parseSynctex(path) {
  const python = resolve(repoRoot, 'service/.venv/bin/python')
  const bin = existsSync(python) ? python : 'python3'
  const script = 'import json,sys\nfrom dia_service.texcompile import parse_synctex\n' +
    'print(json.dumps(parse_synctex(sys.argv[1])))\n'
  const raw = execFileSync(bin, ['-c', script, path], {
    cwd: join(repoRoot, 'service'), maxBuffer: 1024 * 1024 * 64,
  })
  return JSON.parse(raw.toString('utf8'))
}

console.log(`capture-mirror-fixture: parsing synctex from ${workdir}`)
const synctexPath = findSynctex()
const synctex = parseSynctex(synctexPath)
console.log(`  ${synctex.lines.length} records, ${synctex.pages.length} pages known to synctex`)

/* ---------- 2. page geometry, via pdfinfo (paper size ISN'T in synctex —
 * see parse_synctex's docstring: its w/h is the text block, not the page) */

function pdfPageSizes(pdfPath, count) {
  const out = execFileSync('pdfinfo', ['-f', '1', '-l', String(count), pdfPath]).toString('utf8')
  const rot = new Map()
  for (const m of out.matchAll(/^Page\s+(\d+)\s+rot:\s+(\d+)/gm)) rot.set(Number(m[1]), Number(m[2]))
  const sizes = new Map()
  for (const m of out.matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/gm)) {
    const n = Number(m[1])
    let w = Number(m[2]), h = Number(m[3])
    if ((rot.get(n) ?? 0) % 180 === 90) [w, h] = [h, w] // poppler hands back a transposed image
    sizes.set(n, { wPt: w, hPt: h })
  }
  return sizes
}

const pdfPath = join(workdir, 'main.pdf')
if (!existsSync(pdfPath)) { console.error(`capture-mirror-fixture: no main.pdf in ${workdir}`); process.exit(1) }
// ask pdfinfo for generously more pages than synctex saw — a references
// section can run past the last line synctex attributed to \bibliography
const declaredCount = Math.max(1, ...synctex.pages.map((p) => p.n), ...synctex.lines.map((l) => l.page))
const pageSizes = pdfPageSizes(pdfPath, declaredCount + 4)
console.log(`  ${pageSizes.size} page sizes from pdfinfo`)

/* ---------- 3. PNG decoding (zlib inflate + PNG defiltering) ---------- */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG (bad signature)')
  let off = 8
  let width = 0, height = 0, bitDepth = 0, colorType = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data.readUInt8(8)
      colorType = data.readUInt8(9)
      if (data.readUInt8(12) !== 0) throw new Error('interlaced PNG not supported')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    off += 8 + len + 4
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth} (pdftoppm always writes 8)`)
  // greyscale, RGB, RGBA — the three shapes pdftoppm can emit
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : -1
  if (channels < 0) throw new Error(`unsupported PNG color type ${colorType}`)
  // node's zlib speaks the zlib (RFC1950) wrapper IDAT uses directly —
  // no separate deflate framing to strip
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = new Uint8Array(height * stride)
  let pos = 0
  let prevRow = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const row = raw.subarray(pos, pos + stride)
    pos += stride
    const outRow = out.subarray(y * stride, y * stride + stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? outRow[x - channels] : 0
      const b = prevRow[x]
      const c = x >= channels ? prevRow[x - channels] : 0
      let v = row[x]
      switch (filter) {
        case 0: break
        case 1: v = (v + a) & 0xff; break
        case 2: v = (v + b) & 0xff; break
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
          break
        }
        default: throw new Error(`bad PNG filter byte ${filter}`)
      }
      outRow[x] = v
    }
    prevRow = outRow
  }
  return { width, height, channels, data: out }
}

/* ---------- 4. ink: the oracle's scan, over real pixels ---------- */

function pageInkFromPng(png, wPt, hPt) {
  const scale = png.width / wPt
  const cols = Math.max(1, Math.ceil(wPt))
  const cells = new Uint8Array(cols * png.height)
  const paper = [png.data[0], png.data[1], png.data[2] ?? png.data[0]]
  let left = cols, right = -1
  for (let y = 0; y < png.height; y++) {
    const row = y * png.width * png.channels
    for (let x = 0; x < png.width; x++) {
      const i = row + x * png.channels
      const r = png.data[i], g = png.channels >= 2 ? png.data[i + 1] : r, b = png.channels >= 3 ? png.data[i + 2] : r
      const d = Math.abs(r - paper[0]) + Math.abs(g - paper[1]) + Math.abs(b - paper[2])
      if (d <= INK_THRESHOLD) continue
      const c = Math.min(cols - 1, Math.floor(x / scale))
      cells[y * cols + c] = 1
      if (c < left) left = c
      if (c > right) right = c
    }
  }
  return {
    cols, rows: png.height, scale, wPt, hPt,
    extent: right >= left ? { xMin: left, xMax: right + 1 } : null,
    cells,
  }
}

/* ---------- 5. drive it over every rendered page ---------- */

const pngRe = /^page-(\d+)-r(\d+)\.png$/
const found = new Map() // page -> {path, dpi}
for (const f of readdirSync(workdir)) {
  const m = pngRe.exec(f)
  if (!m) continue
  const n = Number(m[1]), dpi = Number(m[2])
  if (args.dpi && dpi !== Number(args.dpi)) continue
  const held = found.get(n)
  if (!held || dpi > held.dpi) found.set(n, { path: join(workdir, f), dpi })
}
if (found.size === 0) { console.error(`capture-mirror-fixture: no page-N-r*.png in ${workdir}`); process.exit(1) }
const dpis = new Set([...found.values()].map((v) => v.dpi))
if (dpis.size > 1) console.warn(`capture-mirror-fixture: mixed dpi across pages (${[...dpis]}) — pass --dpi to pin one`)

const pages = []
for (const [n, { path, dpi }] of [...found].sort((a, b) => a[0] - b[0])) {
  const size = pageSizes.get(n)
  if (!size) { console.warn(`  page ${n}: no pdfinfo size — skipped`); continue }
  const png = decodePng(readFileSync(path))
  const ink = pageInkFromPng(png, size.wPt, size.hPt)
  const gz = gzipSync(Buffer.from(ink.cells))
  pages.push({
    n, wPt: ink.wPt, hPt: ink.hPt, cols: ink.cols, rows: ink.rows, scale: ink.scale,
    extent: ink.extent, dpi,
    cellsGz: gz.toString('base64'),
  })
  console.log(`  page ${n}: ${png.width}x${png.height}px @ r${dpi} -> ${ink.cols}x${ink.rows} cells, ` +
    `${(gz.length / 1024).toFixed(1)}KB gz`)
}

const fixture = {
  paper,
  capturedAt: new Date().toISOString(),
  inkThreshold: INK_THRESHOLD,
  // `boxes` is what the mirror actually crops from — the engine's own
  // rectangles. `lines` (the point-per-source-line scroll map) rides along
  // because the PDF panel still reads it and a fixture is the cheapest
  // place to hold its shape down. `pages` is synctex's per-page TEXT BLOCK,
  // which is the measure every crop's width is divided by.
  synctex: {
    xSemantics: synctex.xSemantics,
    ySemantics: synctex.ySemantics,
    boxSemantics: synctex.boxSemantics,
    mainTag: synctex.mainTag,
    lines: synctex.lines,
    boxes: synctex.boxes,
    pages: synctex.pages,
  },
  pages,
}

writeFileSync(outPath, JSON.stringify(fixture))
const kb = (Buffer.byteLength(JSON.stringify(fixture)) / 1024).toFixed(0)
console.log(`capture-mirror-fixture: wrote ${outPath} (${kb} KB, ${pages.length} pages)`)
