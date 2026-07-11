/* Core shared types. Module agents implement against these — do not edit. */

/* ---------- document ---------- */

/** A loaded deck. The live DOM inside `root` IS the document; save = serialize. */
export interface Deck {
  /** shadow root hosting the deck's <style> blocks and slides */
  root: ShadowRoot
  /** the deck's theme <style id="dia-theme"> element (tokens live here) */
  themeStyle: HTMLStyleElement
  /** original full-document attributes we preserve on save (lang, title, head extras) */
  headExtras: string
  title: string
  fileName: string
  /** dialect version stamp */
  version: string
}

/** slides are `section.dia-slide` children of root, in document order */
export type SlideEl = HTMLElement

/* ---------- selection ---------- */

export type Selection =
  | { kind: 'none' }
  | { kind: 'slide'; slide: SlideEl }
  | { kind: 'element'; el: HTMLElement; slide: SlideEl }
  | { kind: 'scene-node'; node: SVGGElement; scene: SVGSVGElement; slide: SlideEl }
  | { kind: 'scene-edge'; edge: SVGGElement; scene: SVGSVGElement; slide: SlideEl }

/* ---------- ops ---------- */

/** Every mutation is an Op: apply() performs it, invert() returns the undo op.
 * Ops carry a human-readable label and an author for the op log. */
export interface Op {
  label: string
  author: 'you' | 'copilot'
  apply(): void
  invert(): Op
}

export interface OpLogEntry { op: Op; at: number }

/* ---------- events ---------- */

export type EditorEvent =
  | { type: 'selection'; sel: Selection }
  | { type: 'op'; entry: OpLogEntry }
  | { type: 'undo' | 'redo' }
  | { type: 'altitude'; altitude: Altitude }
  | { type: 'current-slide'; index: number }
  | { type: 'deck-loaded' }
  | { type: 'slides-changed' }

export type Altitude = 'table' | 'stage'

/* ---------- scene ---------- */

export type NodeShape = 'rect' | 'rounded' | 'pill' | 'ellipse' | 'diamond'
export type EdgeRoute = 'straight' | 'ortho' | 'curve'
export type AnchorSide = 'N' | 'S' | 'E' | 'W' | 'auto'

export interface NodeGeom { x: number; y: number; w: number; h: number }

/* ---------- ingest ---------- */

export interface RegionNote {
  slideIndex: number
  /** css-path-ish locator within the converted slide */
  locator: string
  kind: 'island' | 'low-structure' | 'stripped-chrome' | 'lifted-svg'
  note: string
}

export interface ImportReport {
  sourceName: string
  slideCount: number
  /** deterministic confidence per slide, 0..1 (structural heuristics, not pixels) */
  confidence: number[]
  regions: RegionNote[]
  tokens: Record<string, string>
  warnings: string[]
}

export interface ImportResult {
  /** full serialized dialect document */
  deckHtml: string
  report: ImportReport
  /** original source per slide for the review compare (self-contained html) */
  originalSlides: string[]
}

/* ---------- service ---------- */

export interface ChatContext {
  altitude: Altitude
  slideIndex: number
  selectionHtml: string | null
  tokensCss: string
  flowNeighborsHtml?: string[]
}

export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'ops'; ops: ProposedOp[] }
  | { type: 'done' }
  | { type: 'error'; message: string }

/** serializable op proposal from the copilot; the editor compiles it to an Op */
export interface ProposedOp {
  action: 'set-text' | 'set-token' | 'set-style' | 'insert-html' | 'remove' | 'move-node' | 'insert-edge' | 'retarget-edge'
  target: string
  value?: string
  extra?: Record<string, string | number>
  label: string
}
