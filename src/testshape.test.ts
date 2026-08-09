/* A test suite cannot police itself, so this does the one part it can.
 *
 * A duplicated `describe` block is invisible to every other gate: vitest runs
 * it twice, both copies pass, and the total goes UP — so the suite reports
 * more coverage than it has. That happened here: a script meant to merge two
 * overlapping blocks assumed one preceded the other, sliced on that
 * assumption, and left both in the tree along with an unbalanced brace that
 * nested every following describe inside the damaged one. Nothing failed. The
 * count rose by 27 and read as success.
 *
 * The same shape arrives from an ordinary bad merge — two branches that both
 * appended a suite to the same file — which is how the sibling of this bug
 * reached main earlier in the same session.
 *
 * Names, not bodies: two blocks doing the same work under different names is
 * a judgement call, but two blocks under the SAME name is always either a
 * duplicate or a name that lies about what it covers. */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

function testFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...testFiles(p))
    else if (entry.endsWith('.test.ts')) out.push(p)
  }
  return out
}

/** top-level `describe('…'` titles, in source order */
function topLevelDescribes(src: string): string[] {
  return [...src.matchAll(/^describe(?:\.\w+)?\(\s*(['"`])(.*?)\1/gm)].map((m) => m[2])
}

/** every `it('…'` title, at any indent */
function itTitles(src: string): string[] {
  return [...src.matchAll(/^\s+it(?:\.\w+)?(?:\.each\([\s\S]*?\))?\(\s*(['"`])(.*?)\1/gm)].map((m) => m[2])
}

function duplicates(names: string[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const n of names) {
    if (seen.has(n)) dupes.add(n)
    seen.add(n)
  }
  return [...dupes]
}

describe('the test suite has no duplicated blocks', () => {
  const files = testFiles(here)

  it('finds test files to check at all', () => {
    // a broken walker reporting zero files would make everything below vacuous
    expect(files.length).toBeGreaterThan(30)
  })

  it('no file declares the same top-level describe twice', () => {
    const offenders = files
      .map((f) => ({ file: relative(here, f), dupes: duplicates(topLevelDescribes(readFileSync(f, 'utf-8'))) }))
      .filter((r) => r.dupes.length > 0)
    expect(offenders, `duplicated describe blocks: ${JSON.stringify(offenders, null, 1)}`).toEqual([])
  })

  it('no file declares the same it twice', () => {
    const offenders = files
      .map((f) => ({ file: relative(here, f), dupes: duplicates(itTitles(readFileSync(f, 'utf-8'))) }))
      .filter((r) => r.dupes.length > 0)
    expect(offenders, `duplicated test names: ${JSON.stringify(offenders, null, 1)}`).toEqual([])
  })
})
