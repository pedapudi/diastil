/* The compile controller: the state machine first (it is where the ordering
 * bugs live — a stale job's `done`, a health poll landing mid-compile), then
 * one end-to-end pass over a stubbed service so the SSE plumbing is exercised
 * without a daemon. Nothing here touches the network. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  INITIAL_COMPILE_STATE, compileGrant, compileNow, compileState, createAutoCompiler, reduceCompile,
  resetCompileState, setCompileGrant, texAvailable, texDownloadable, texHint,
  TEX_INSTALL_HINT, TEX_NO_ENGINE_HINT, TEX_OFFLINE_HINT,
  type CompileEvent, type CompileState,
} from './doccompile'
import { loadDocFromTex } from '../model/doc'
import type { TexCapability } from '../service/client'

function run(events: CompileEvent[], from: CompileState = INITIAL_COMPILE_STATE): CompileState {
  return events.reduce(reduceCompile, from)
}

const ENGINE: TexCapability = {
  engine: 'tectonic', path: '/usr/bin/tectonic', version: 'tectonic 0.15.0',
  synctex: true, downloadable: true, managed: false, detail: null,
}
const NO_ENGINE: TexCapability = {
  engine: null, path: null, version: null,
  synctex: false, downloadable: true, managed: false, detail: 'no TeX engine found',
}

const online = (tex: TexCapability | null): CompileEvent => ({ kind: 'service', online: true, tex })

function doneFrame(over: Record<string, unknown> = {}): CompileEvent {
  return {
    kind: 'frame',
    frame: {
      type: 'done', jobId: 'j1', docId: 'd', status: 'ok', engine: 'tectonic',
      pages: 12, durationMs: 3100, errors: [], detail: null, ...over,
    },
  }
}

describe('reduceCompile', () => {
  it('starts offline until /health says otherwise', () => {
    expect(INITIAL_COMPILE_STATE.status).toBe('offline')
  })

  it('online with an engine lands on idle, not on a stale offline verdict', () => {
    const s = run([online(ENGINE)])
    expect(s.status).toBe('idle')
    expect(s.engine).toBe('tectonic')
  })

  it('online without an engine is no-engine, and remembers the install offer', () => {
    const s = run([online(NO_ENGINE)])
    expect(s.status).toBe('no-engine')
    expect(s.downloadable).toBe(true)
    expect(s.detail).toBe('no TeX engine found')
  })

  it('losing the daemon goes back to offline and forgets the engine', () => {
    const s = run([online(ENGINE), { kind: 'service', online: false, tex: null }])
    expect(s.status).toBe('offline')
    expect(s.engine).toBeNull()
  })

  it('a health poll mid-compile never interrupts the compile', () => {
    const s = run([online(ENGINE), { kind: 'start' }, online(NO_ENGINE)])
    expect(s.status).toBe('compiling')
  })

  it('a health poll after a result does not overwrite it', () => {
    const s = run([online(ENGINE), { kind: 'start' }, doneFrame(), online(ENGINE)])
    expect(s.status).toBe('ok')
    expect(s.pages).toBe(12)
  })

  it('done(ok) carries pages and duration', () => {
    const s = run([online(ENGINE), { kind: 'start' }, doneFrame()])
    expect(s).toMatchObject({ status: 'ok', pages: 12, ms: 3100, errors: [], warnings: [] })
  })

  it('done(error) splits findings by level', () => {
    const s = run([online(ENGINE), { kind: 'start' }, doneFrame({
      status: 'error',
      pages: null,
      errors: [
        { level: 'error', file: './main.tex', line: 12, message: 'Undefined control sequence.' },
        { level: 'warning', file: null, line: 4, message: 'Reference `x` undefined.' },
      ],
    })])
    expect(s.status).toBe('failed')
    expect(s.errors).toHaveLength(1)
    expect(s.warnings).toHaveLength(1)
    expect(s.errors[0].line).toBe(12)
  })

  it('a cancelled job is not a failure — it is a compile the user replaced', () => {
    const s = run([online(ENGINE), { kind: 'start' }, doneFrame({ status: 'cancelled' })])
    expect(s.status).toBe('idle')
  })

  it('findings with no message are dropped rather than rendered blank', () => {
    const s = run([{ kind: 'start' }, doneFrame({
      status: 'error',
      errors: [{ level: 'error', message: '   ' }, { level: 'error', message: 'real' }, null, 7],
    })])
    expect(s.errors.map((e) => e.message)).toEqual(['real'])
  })

  it('a nonsense line number becomes null instead of an impossible jump', () => {
    const s = run([{ kind: 'start' }, doneFrame({
      status: 'error',
      errors: [{ level: 'error', file: 'main.tex', line: -3, message: 'bad' }],
    })])
    expect(s.errors[0].line).toBeNull()
  })

  it('phase frames keep the compile running and pick up the engine', () => {
    const s = run([{ kind: 'start' }, { kind: 'frame', frame: { type: 'phase', phase: 'start', engine: 'latexmk' } }])
    expect(s.status).toBe('compiling')
    expect(s.engine).toBe('latexmk')
  })

  it('start clears the previous run’s findings', () => {
    const s = run([
      { kind: 'start' },
      doneFrame({ status: 'error', errors: [{ level: 'error', message: 'boom' }] }),
      { kind: 'start' },
    ])
    expect(s.errors).toEqual([])
    expect(s.pages).toBeNull()
  })

  it('a failed request states its own status and reason', () => {
    const s = run([online(ENGINE), { kind: 'fail', status: 'no-engine', detail: 'no TeX engine available' }])
    expect(s).toMatchObject({ status: 'no-engine', detail: 'no TeX engine available' })
  })

  it('install progress rides alongside the status', () => {
    const s = run([online(NO_ENGINE), { kind: 'install', pct: 0.5, note: 'downloading…' }])
    expect(s.installing).toBe(0.5)
    expect(s.status).toBe('no-engine')
  })
})

/* ---------- gates ---------- */

describe('a blind compile failing on a missing file', () => {
  const doneFail = {
    type: 'done', status: 'failed',
    errors: [{ level: 'error', file: 'main.tex', line: 37, message: "LaTeX Error: File `neurips_2022.sty' not found." }],
  }
  it('says WHY instead of leaving the missing-file error bare', () => {
    const s = run([online(ENGINE), { kind: 'start' }, { kind: 'frame', frame: doneFail, blind: true }])
    expect(s.status).toBe('failed')
    expect(s.detail).toContain('dia edit')
    expect(s.warnings[0]?.message).toContain('invisible to the compile')
    // this is the ONE shape the folder-grant offer gates on
    expect(s.blindMissing).toBe(true)
  })
  it('stays quiet when the compile could see the folder', () => {
    const s = run([online(ENGINE), { kind: 'start' }, { kind: 'frame', frame: doneFail, blind: false }])
    expect(s.detail ?? '').not.toContain('dia edit')
    expect(s.warnings).toHaveLength(0)
    expect(s.blindMissing).toBe(false)
  })
  it('stays quiet on failures that are not about missing files', () => {
    const other = { type: 'done', status: 'failed', errors: [{ level: 'error', file: 'main.tex', line: 5, message: 'Undefined control sequence.' }] }
    const s = run([online(ENGINE), { kind: 'start' }, { kind: 'frame', frame: other, blind: true }])
    expect(s.detail ?? '').not.toContain('dia edit')
    expect(s.blindMissing).toBe(false)
  })
  it('a fresh compile clears a stale blindMissing before the next result lands', () => {
    const s = run([
      online(ENGINE), { kind: 'start' }, { kind: 'frame', frame: doneFail, blind: true },
      { kind: 'start' },
    ])
    expect(s.blindMissing).toBe(false)
  })
  it('a request-level failure (offline, no-engine) is not a blindMissing failure', () => {
    const s = run([
      online(ENGINE), { kind: 'start' }, { kind: 'frame', frame: doneFail, blind: true },
      { kind: 'fail', status: 'offline', detail: TEX_OFFLINE_HINT },
    ])
    expect(s.blindMissing).toBe(false)
  })
})

describe('capability gates', () => {
  afterEach(() => { resetCompileState() })

  function broadcast(online_: boolean, tex: TexCapability | null): void {
    window.dispatchEvent(new CustomEvent('dia-service-status', { detail: { online: online_, tex } }))
  }

  it('offline: no compile, no install offer, the hint names `dia serve`', () => {
    broadcast(false, null)
    expect(texAvailable()).toBe(false)
    expect(texDownloadable()).toBe(false)
    expect(texHint()).toBe(TEX_OFFLINE_HINT)
  })

  it('daemon up, no engine, downloadable: the offer is the hint', () => {
    broadcast(true, NO_ENGINE)
    expect(texAvailable()).toBe(false)
    expect(texDownloadable()).toBe(true)
    expect(texHint()).toBe(TEX_INSTALL_HINT)
  })

  it('daemon up, no engine, nothing to download: say so plainly', () => {
    broadcast(true, { ...NO_ENGINE, downloadable: false })
    expect(texDownloadable()).toBe(false)
    expect(texHint()).toBe(TEX_NO_ENGINE_HINT)
  })

  it('engine present: compiling is available', () => {
    broadcast(true, ENGINE)
    expect(texAvailable()).toBe(true)
    expect(texDownloadable()).toBe(false)
  })
})

/* ---------- the SSE flow, against a stubbed service ---------- */

function sseStream(frames: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`))
      controller.close()
    },
  })
}

/** a stub standing in for the daemon: POST /compile then the event stream */
function stubService(frames: unknown[], opts: { post?: Response } = {}): ReturnType<typeof vi.fn> {
  const calls = vi.fn(async (url: string | URL) => {
    const href = String(url)
    if (href.endsWith('/compile')) {
      return opts.post ?? new Response(JSON.stringify({ jobId: 'job42', engine: 'tectonic', texinputs: false }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href.includes('/events')) return new Response(sseStream(frames), { status: 200 })
    if (href.endsWith('/pdf')) return new Response(new Blob([new Uint8Array([37, 80, 68, 70])]), { status: 200 })
    throw new Error(`unexpected fetch: ${href}`)
  })
  vi.stubGlobal('fetch', calls)
  return calls as unknown as ReturnType<typeof vi.fn>
}

function makeDoc(tex: string) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return loadDocFromTex(tex, host, 'paper.tex')
}

const TINY = `\\documentclass{article}
\\begin{document}
Hello.
\\end{document}
`

describe('compileNow over a stubbed service', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetCompileState() })

  it('consumes phase/log/done frames and ends ok', async () => {
    const fetchMock = stubService([
      { type: 'phase', phase: 'start', engine: 'tectonic', jobId: 'job42' },
      { type: 'log', line: 'This is tectonic' },
      { type: 'done', jobId: 'job42', status: 'ok', engine: 'tectonic', pages: 3, durationMs: 1200, errors: [] },
    ])
    const result = await compileNow(makeDoc(TINY))
    expect(result).toMatchObject({ jobId: 'job42', ok: true, pages: 3, ms: 1200 })
    expect(compileState().status).toBe('ok')

    // the source, not the rendered body, is what gets compiled
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { texSource: string; docId: string }
    expect(body.texSource).toBe(TINY)
    expect(body.docId).toBe('paper.html')
  })

  it('a failing document is a normal outcome: failed, with findings', async () => {
    stubService([
      { type: 'log', line: './main.tex:3: Undefined control sequence.' },
      {
        type: 'done', jobId: 'job42', status: 'error', engine: 'tectonic', pages: null, durationMs: 800,
        errors: [{ level: 'error', file: './main.tex', line: 3, message: 'Undefined control sequence.' }],
      },
    ])
    const result = await compileNow(makeDoc(TINY))
    expect(result?.ok).toBe(false)
    expect(compileState().status).toBe('failed')
    expect(compileState().errors[0].message).toBe('Undefined control sequence.')
  })

  it('a 503 from the daemon reads as no-engine, with the daemon’s own reason', async () => {
    stubService([], {
      post: new Response(JSON.stringify({ detail: 'no TeX engine available' }), { status: 503 }),
    })
    expect(await compileNow(makeDoc(TINY))).toBeNull()
    expect(compileState()).toMatchObject({ status: 'no-engine', detail: 'no TeX engine available' })
  })

  it('an unreachable service is offline, not a document failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed to fetch') }))
    expect(await compileNow(makeDoc(TINY))).toBeNull()
    expect(compileState()).toMatchObject({ status: 'offline', detail: TEX_OFFLINE_HINT })
  })

  it('a stream that ends without a done frame is reported, not left spinning', async () => {
    stubService([{ type: 'log', line: 'half a compile' }])
    expect(await compileNow(makeDoc(TINY))).toBeNull()
    expect(compileState().status).toBe('failed')
  })

  it('malformed frames are skipped, not fatal', async () => {
    const enc = new TextEncoder()
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/compile')) return new Response(JSON.stringify({ jobId: 'job42' }), { status: 200 })
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('data: {not json\n\n'))
          c.enqueue(enc.encode('data: "a bare string"\n\n'))
          c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'done', status: 'ok', pages: 1, durationMs: 5, errors: [] })}\n\n`))
          c.close()
        },
      }), { status: 200 })
    }))
    const result = await compileNow(makeDoc(TINY))
    expect(result?.ok).toBe(true)
  })

  it('a superseded compile stops writing to the shared state', async () => {
    // the second compile finishes first; the first must not claim the chip
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const enc = new TextEncoder()
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/compile')) return new Response(JSON.stringify({ jobId: 'j' }), { status: 200 })
      const slow = href.includes('slow')
      return new Response(new ReadableStream<Uint8Array>({
        async start(c) {
          if (slow) await gate
          c.enqueue(enc.encode(`data: ${JSON.stringify({
            type: 'done', status: slow ? 'error' : 'ok', pages: slow ? null : 9, durationMs: 1,
            errors: slow ? [{ level: 'error', message: 'stale' }] : [],
          })}\n\n`))
          c.close()
        },
      }), { status: 200 })
    }))
    // route the first compile's event stream to the slow branch
    const doc = makeDoc(TINY)
    const original = globalThis.fetch
    let first = true
    vi.stubGlobal('fetch', ((url: string | URL, init?: RequestInit) => {
      const href = String(url)
      if (href.includes('/events') && first) { first = false; return original(`${href}?slow`, init) }
      return original(url, init)
    }) as typeof fetch)

    const stale = compileNow(doc)
    const fresh = await compileNow(doc)
    release()
    expect(await stale).toBeNull()
    expect(fresh?.ok).toBe(true)
    expect(compileState()).toMatchObject({ status: 'ok', pages: 9, errors: [] })
  })
})

/* ---------- the folder grant riding along on the compile POST ---------- */

describe('a granted folder’s assets ride along on the compile', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetCompileState() })

  it('with no grant, the POST body carries no assets key', async () => {
    const fetchMock = stubService([
      { type: 'done', jobId: 'job42', status: 'ok', engine: 'tectonic', pages: 1, durationMs: 5, errors: [] },
    ])
    await compileNow(makeDoc(TINY))
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { assets?: unknown }
    expect(body.assets).toBeUndefined()
  })

  it('a granted folder’s assets are attached to the very next compile', async () => {
    setCompileGrant('papers', { 'neurips_2022.sty': '% a style file', 'fig1.png': 'data:application/octet-stream;base64,AA==' }, 1)
    expect(compileGrant()).toMatchObject({ folderName: 'papers', skippedCount: 1 })

    const fetchMock = stubService([
      { type: 'done', jobId: 'job42', status: 'ok', engine: 'tectonic', pages: 1, durationMs: 5, errors: [] },
    ])
    await compileNow(makeDoc(TINY))
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { assets?: Record<string, string> }
    expect(body.assets).toEqual({
      'neurips_2022.sty': '% a style file',
      'fig1.png': 'data:application/octet-stream;base64,AA==',
    })
  })

  it('the grant persists across compiles until reset — the session-scoped promise', async () => {
    setCompileGrant('papers', { 'neurips_2022.sty': '% a style file' })
    stubService([{ type: 'done', jobId: 'job1', status: 'ok', engine: 'tectonic', pages: 1, durationMs: 5, errors: [] }])
    const doc = makeDoc(TINY)
    await compileNow(doc)

    const fetchMock = stubService([{ type: 'done', jobId: 'job2', status: 'ok', engine: 'tectonic', pages: 1, durationMs: 5, errors: [] }])
    await compileNow(doc)
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { assets?: Record<string, string> }
    expect(body.assets).toEqual({ 'neurips_2022.sty': '% a style file' })
  })

  it('resetCompileState clears the grant along with everything else', async () => {
    setCompileGrant('papers', { 'x.sty': 'y' })
    resetCompileState()
    expect(compileGrant()).toBeNull()
  })
})

/* ---------- auto-compile ---------- */

/* The native view rests as the compiled render, which only works if a
 * compile follows every edit — and only stays usable if a burst of edits is
 * ONE compile and a compile never overlaps itself. Fake timers, a stubbed
 * runner: the daemon has nothing to do with these rules. */
describe('createAutoCompiler', () => {
  afterEach(() => { vi.useRealTimers() })

  function harness() {
    vi.useFakeTimers()
    let running = 0
    let peak = 0
    const calls: number[] = []
    let release: (() => void) | null = null
    const run = (): Promise<void> => {
      calls.push(Date.now())
      running++
      peak = Math.max(peak, running)
      return new Promise<void>((resolve) => {
        release = () => { running--; resolve() }
      })
    }
    return { run, calls, finish: () => release?.(), peak: () => peak }
  }

  it('turns a burst of edits into one compile', async () => {
    const h = harness()
    const auto = createAutoCompiler(h.run, 1500)
    auto.note()
    await vi.advanceTimersByTimeAsync(600)
    auto.note()
    await vi.advanceTimersByTimeAsync(600)
    auto.note()
    expect(h.calls.length).toBe(0) // still typing
    await vi.advanceTimersByTimeAsync(1500)
    expect(h.calls.length).toBe(1)
  })

  it('never runs two compiles at once, and owes exactly one more', async () => {
    const h = harness()
    const auto = createAutoCompiler(h.run, 100)
    auto.note()
    await vi.advanceTimersByTimeAsync(100)
    expect(h.calls.length).toBe(1)

    // three edits while the engine is busy: one trailing run, not three
    for (let i = 0; i < 3; i++) {
      auto.note()
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(h.calls.length).toBe(1)
    expect(auto.busy()).toBe(true)

    h.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls.length).toBe(2)
    expect(h.peak()).toBe(1)
  })

  it('does not retry on its own — only an edit arms it again', async () => {
    const failures: number[] = []
    vi.useFakeTimers()
    const auto = createAutoCompiler(async () => {
      failures.push(1)
      throw new Error('the engine fell over')
    }, 100)
    auto.note()
    await vi.advanceTimersByTimeAsync(100)
    expect(failures.length).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(failures.length).toBe(1)
    expect(auto.busy()).toBe(false)

    auto.note()
    await vi.advanceTimersByTimeAsync(100)
    expect(failures.length).toBe(2)
  })

  it('cancel drops the pending run', async () => {
    const h = harness()
    const auto = createAutoCompiler(h.run, 100)
    auto.note()
    auto.cancel()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.calls.length).toBe(0)
    expect(auto.busy()).toBe(false)
  })
})
