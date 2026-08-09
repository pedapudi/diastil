/* The folder-access grant: when a blind compile fails because the daemon
 * could not see a picker-opened document's folder, the BROWSER can still
 * read that folder — showDirectoryPicker() is a permission the user grants
 * inline, in a click, and the daemon never learns of it except through what
 * arrives in the existing `assets` map. write_assets() on the service side
 * already validates every name it receives (service/dia_service/texcompile.py
 * `_safe_asset_path`); this module's job is to be a good citizen on the way
 * there — read plausible support files, cap what it sends, and say what it
 * left behind rather than truncating silently.
 *
 * Split for testability: everything below "the browser part" touches
 * showDirectoryPicker/File and cannot run under a test runner with no DOM
 * file-system API. Everything above it is pure and is where the actual
 * decisions (what counts as a support file, the size budget, name safety)
 * live — those are exercised directly in folderGrant.test.ts. */

/** the daemon reads these as siblings of main.tex; everything else in the
 * folder (a .zip, a .DS_Store, a README) is dead weight against the budget
 * below.
 *
 * `tex` used to be excluded, with a comment claiming \input could not reach
 * a stray chapter. It can — that was the bug: a multi-file document did not
 * merely render poorly, it failed to compile at all, on the first missing
 * chapter. Sibling .tex now ships. What did NOT change is the shape of the
 * capability: the picker still lists one directory, and the only way below
 * it is a path the DOCUMENT ITSELF names (see grantFolderAccess). */
const TEXT_EXTENSIONS = new Set(['sty', 'cls', 'bst', 'bib', 'bbl', 'tex'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'eps', 'pdf'])

/** one file this large is almost certainly not a LaTeX support file — a
 * scanned figure or a mis-clicked folder, not a .sty */
export const MAX_FILE_BYTES = 8 * 1024 * 1024
/** the whole grant's budget; a folder can be huge, this compile POST cannot */
export const MAX_TOTAL_BYTES = 24 * 1024 * 1024

export type SkipReason = 'type' | 'too-large' | 'budget' | 'name'

export interface FileStat { name: string; size: number }
export interface SkippedFile { name: string; reason: SkipReason }

export interface GrantPlan {
  accepted: FileStat[]
  skipped: SkippedFile[]
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** a .sty/.cls/.bst/.bib/.bbl/.tex or a figure image — the set the daemon
 * can actually use to unblind a compile */
export function isSupportFile(name: string): boolean {
  const ext = extOf(name)
  return TEXT_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext)
}

/** text asset (sent as-is) vs. binary (sent as a base64 data URI) — mirrors
 * the two shapes write_assets() accepts */
export function isTextSupportFile(name: string): boolean {
  return TEXT_EXTENSIONS.has(extOf(name))
}

/** Mirrors the daemon's `_safe_asset_path` (service/dia_service/texcompile.py) for
 * a FLAT name. The picker only ever hands back one directory's own listing —
 * there is no `..` for a real entry to contain — but a name can still carry
 * a separator on an exotic filesystem or a mounted share, and the daemon's
 * own checks are the ground truth for what it will accept, so this stays a
 * mirror rather than a looser local guess. */
export function isValidAssetName(name: string, mainName?: string): boolean {
  if (!name || name.trim() !== name) return false
  if (name.startsWith('/') || name.startsWith('\\')) return false
  if (name.slice(0, 3).includes(':')) return false
  if (name.split(/[/\\]/).some((part) => part === '' || part === '.' || part === '..')) return false
  if (name === 'main.tex') return false
  // the document being edited rides as `texSource`, and the in-memory copy
  // is the one with the user's unsaved edits in it — shipping the stale
  // bytes off disk under the same roof is how you compile yesterday's draft
  if (mainName !== undefined && name === mainName) return false
  return true
}

/** Which of these files to send, and which to leave behind — pure so the
 * size-cap and skip accounting is unit-testable without a browser. Files
 * are considered in the order given; a directory listing is typically
 * alphabetical, so the budget fills alphabetically too rather than by any
 * hidden preference. */
export function planGrant(files: FileStat[], mainName?: string): GrantPlan {
  const accepted: FileStat[] = []
  const skipped: SkippedFile[] = []
  let total = 0
  for (const f of files) {
    if (!isValidAssetName(f.name, mainName)) { skipped.push({ name: f.name, reason: 'name' }); continue }
    if (!isSupportFile(f.name)) { skipped.push({ name: f.name, reason: 'type' }); continue }
    if (f.size > MAX_FILE_BYTES) { skipped.push({ name: f.name, reason: 'too-large' }); continue }
    if (total + f.size > MAX_TOTAL_BYTES) { skipped.push({ name: f.name, reason: 'budget' }); continue }
    accepted.push(f)
    total += f.size
  }
  return { accepted, skipped }
}

/** one sentence naming what was left behind and why — "skipped silently" is
 * exactly the failure mode this exists to avoid */
export function summarizeSkips(skipped: SkippedFile[]): string {
  if (skipped.length === 0) return ''
  const byReason = new Map<SkipReason, string[]>()
  for (const s of skipped) {
    const list = byReason.get(s.reason) ?? []
    list.push(s.name)
    byReason.set(s.reason, list)
  }
  const label = (r: SkipReason): string => r === 'too-large' ? 'too large'
    : r === 'budget' ? 'over the size budget'
      : r === 'name' ? 'an unsafe name'
        : 'not a LaTeX support file'
  const order: SkipReason[] = ['type', 'too-large', 'budget', 'name']
  const parts = order
    .filter((r) => byReason.has(r))
    .map((r) => {
      const names = byReason.get(r) ?? []
      const shown = names.slice(0, 3).join(', ')
      return `${names.length} ${label(r)} (${shown}${names.length > 3 ? ', …' : ''})`
    })
  return `skipped ${parts.join('; ')}`
}

/* ---------- reaching below the top level ---------- */

/** How many directory levels below the granted folder the walk may go.
 * `chapters/intro.tex` is one; `parts/two/intro.tex` is two. Nothing real
 * needs more, and the cap is the last line of defence if the "only paths
 * the document names" rule below is ever loosened. */
export const MAX_GRANT_DEPTH = 3

/** May the walk descend into this directory? ONLY when some path the
 * document itself \inputs runs through it.
 *
 * This is what keeps widening the grant to .tex from becoming "read
 * anything the user has". The picker grants one directory; before this
 * change the walk read that directory and stopped. It still does — the
 * only thing that reaches deeper is a path written in the document's own
 * source, so what the grant can see is bounded by the DOCUMENT, not by
 * the size or shape of the folder the user happened to pick. */
export function descendInto(relPath: string, wanted: readonly string[]): boolean {
  return wanted.some((w) => w.startsWith(`${relPath}/`))
}

/** May a file BELOW the top level be read? Only when it is exactly a path
 * the document named — a wanted directory is a keyhole, not a door. */
export function acceptNested(relPath: string, wanted: readonly string[]): boolean {
  return wanted.includes(relPath)
}

/* ---------- the browser part ---------- */

/** the File System Access API's shape, as far as this module uses it — not
 * in TypeScript's DOM lib (Chromium-only, no cross-browser spec yet) */
interface FSFileHandleLike { kind: 'file'; name: string; getFile(): Promise<File> }
interface FSDirHandleLike {
  kind: 'directory'
  name: string
  values(): AsyncIterableIterator<FSFileHandleLike | FSDirHandleLike>
}

function pickerFn(): (() => Promise<FSDirHandleLike>) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { showDirectoryPicker?: () => Promise<FSDirHandleLike> }
  return typeof w.showDirectoryPicker === 'function' ? w.showDirectoryPicker : null
}

/** feature-detect before offering the affordance — Chromium-only today, and
 * a surface that offers a dead button is worse than one that says nothing */
export function folderGrantAvailable(): boolean {
  return pickerFn() !== null
}

/** the shape write_assets() expects: base64 data URI for binary (figures),
 * plain text for styles/classes/bib/bbl */
async function readAsset(file: File): Promise<string> {
  if (isTextSupportFile(file.name)) return file.text()
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return `data:application/octet-stream;base64,${btoa(binary)}`
}

export interface FolderGrantResult {
  folderName: string
  assets: Record<string, string>
  skipped: SkippedFile[]
}

/** Ask the browser for a folder and read its support files into an assets
 * map.
 *
 * THE TOP LEVEL, PLUS WHAT THE DOCUMENT ASKED FOR. The picker lists a
 * single directory; that directory's support files are read as they always
 * were. `wanted` — the project-relative paths the document's own
 * \input/\include name (latex/project.ts scanInputPaths) — is the ONLY way
 * the walk goes deeper, one named file at a time, MAX_GRANT_DEPTH levels
 * at most. An unbounded recursive walk is exactly the "huge folder" the
 * size budget exists to guard against, and "the user granted a folder" is
 * not the same permission as "read everything under it".
 *
 * `mainName` is the open document's own file name, which is skipped: it
 * ships as `texSource`, from memory, edits included.
 *
 * Must be called from a user gesture (directly inside a click handler, not
 * after an intervening await) — the browser enforces this itself and throws
 * otherwise. Resolves null if the API is unavailable or the user cancels the
 * picker; neither is a failure worth reporting. */
export async function grantFolderAccess(
  wanted: readonly string[] = [],
  mainName?: string,
): Promise<FolderGrantResult | null> {
  const picker = pickerFn()
  if (!picker) return null
  let dir: FSDirHandleLike
  try {
    dir = await picker()
  } catch {
    return null // cancelled, or denied — the browser already told the user
  }
  const files: { name: string; file: File }[] = []
  await walkGrant(dir, '', wanted, files, 0)
  const plan = planGrant(files.map((f) => ({ name: f.name, size: f.file.size })), mainName)
  const accepted = new Set(plan.accepted.map((a) => a.name))
  const assets: Record<string, string> = {}
  for (const f of files) {
    if (!accepted.has(f.name)) continue
    assets[f.name] = await readAsset(f.file)
  }
  return { folderName: dir.name, assets, skipped: plan.skipped }
}

async function walkGrant(
  dir: FSDirHandleLike,
  prefix: string,
  wanted: readonly string[],
  out: { name: string; file: File }[],
  depth: number,
): Promise<void> {
  for await (const entry of dir.values()) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.kind === 'file') {
      // top level as before; below it, only a file the document named
      if (prefix === '' || acceptNested(rel, wanted)) {
        out.push({ name: rel, file: await entry.getFile() })
      }
      continue
    }
    if (depth + 1 >= MAX_GRANT_DEPTH) continue
    if (!descendInto(rel, wanted)) continue
    await walkGrant(entry, rel, wanted, out, depth + 1)
  }
}
