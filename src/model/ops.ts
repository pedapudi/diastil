/* Op constructors — the ONLY way modules mutate the document.
 * Each returns an Op with apply/invert; route through state.apply(op). */

import type { NodeGeom, Op } from '../types'
import type { Doc } from './doc'
import type { DocSource } from '../latex/source'
import { routeAll, routeEdge, setNodeGeom, getNodeGeom } from '../scene/route'
import { emitBlockTex } from '../latex/emit'
import { applySourceText } from '../doc/reconcile'

const author = (a?: 'you' | 'copilot') => a ?? 'you'

/** Put a re-emitted block back in the whitespace its span already had.
 *
 * A span owns the blank lines and newlines that SEPARATE its block from the
 * neighbours; an unedited block emits them back verbatim, but every
 * reconstruction path in emit.ts produces the block alone. Patched in raw,
 * an edited paragraph would swallow the newline after the `\section{…}`
 * above it and glue the two into one line of LaTeX — source the engine
 * still compiles, into a document that is not the one on screen.
 *
 * Both cases pass through here: the unedited emission already carries the
 * separators, so stripping and re-adding them is the identity. */
function reseated(source: DocSource, span: { start: number; end: number }, emitted: string): string {
  const slice = source.text.slice(span.start, span.end)
  const lead = /^\s*/.exec(slice)?.[0] ?? ''
  const tail = /\s*$/.exec(slice.slice(lead.length))?.[0] ?? ''
  return lead + emitted.replace(/^\s+/, '').replace(/\s+$/, '') + tail
}

/** DOM mutation + LaTeX source patch as ONE op — the document mode's only
 * legal write shape (the applyTex pattern generalized). The source patch is
 * DERIVED at apply time: run the DOM ops, re-emit the containing top-level
 * block, replace its span. Undo applies the inverse DOM ops and re-emits —
 * a block restored to its pristine DOM re-emits its memoized source slice,
 * so undo restores the source BYTE-EXACTLY by construction. */
export function syncedBlockOp(doc: Doc, blockEl: HTMLElement, domOps: Op[], label: string, by?: 'you' | 'copilot'): Op {
  return {
    label,
    author: author(by),
    apply() {
      for (const o of domOps) o.apply()
      const id = blockEl.getAttribute('data-dia-id')
      // multi-file: a block rendered from an \input'd chapter binds its
      // span in THAT file's DocSource, so the patch has to land there.
      // Single-file documents route to doc.source exactly as before —
      // their project holds nothing else (latex/project.ts).
      const source = (id && doc.project.sourceOfId(id)) || doc.source
      const span = id ? source.spanOf(id) : null
      if (span) source.patch(span.start, span.end, reseated(source, span, emitBlockTex(blockEl)))
      else console.error('dia-doc: edited block has no bound source span — source not updated')
    },
    invert() {
      const inverses = [...domOps].reverse().map((o) => o.invert())
      return syncedBlockOp(doc, blockEl, inverses, `un-${label}`, author(by))
    },
  }
}

/** replace an element's text content (role text editing).
 * The inverse restores the exact previous child nodes, not just the flattened
 * text — setText on a container (e.g. a copilot proposal) must undo cleanly. */
export function setText(el: HTMLElement, text: string, by?: 'you' | 'copilot'): Op {
  const prevNodes = [...el.childNodes]
  return {
    label: `SetText ${describe(el)}`,
    author: author(by),
    apply() { el.textContent = text },
    invert() {
      const redo = () => setText(el, text, author(by))
      return {
        label: `un-SetText ${describe(el)}`,
        author: author(by),
        apply() { el.replaceChildren(...prevNodes) },
        invert: redo,
      }
    },
  }
}

/** replace an element's inline content — rich text editing that PRESERVES
 * inline markup (strong/em/code/…); exact undo via child-node snapshot */
export function setInlineHtml(el: HTMLElement, html: string, by?: 'you' | 'copilot'): Op {
  const prevNodes = [...el.childNodes]
  return {
    label: `SetText ${describe(el)}`,
    author: author(by),
    apply() { el.innerHTML = html },
    invert() {
      const redo = () => setInlineHtml(el, html, author(by))
      return {
        label: `un-SetText ${describe(el)}`,
        author: author(by),
        apply() { el.replaceChildren(...prevNodes) },
        invert: redo,
      }
    },
  }
}

/** set/remove an attribute */
export function setAttr(el: Element, name: string, value: string | null, by?: 'you' | 'copilot'): Op {
  const prev = el.getAttribute(name)
  return {
    label: `SetAttr ${name}`,
    author: author(by),
    apply() { value === null ? el.removeAttribute(name) : el.setAttribute(name, value) },
    invert() { return setAttr(el, name, prev, author(by)) },
  }
}

/** set a deck theme token inside <style id="dia-theme"> */
export function setToken(themeStyle: HTMLStyleElement, name: string, value: string, by?: 'you' | 'copilot'): Op {
  const sheet = themeStyle.sheet as CSSStyleSheet
  const rule = [...sheet.cssRules].find(
    (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText === ':host',
  )
  const prev = rule?.style.getPropertyValue(name).trim() ?? ''
  return {
    label: `SetToken ${name}: ${value}`,
    author: author(by),
    apply() { rule?.style.setProperty(name, value) },
    invert() { return setToken(themeStyle, name, prev, author(by)) },
  }
}

/** set an inline style property on an element (last-resort write target;
 * scene styling sets the dia-node / dia-edge custom props on svg groups) */
export function setStyleProp(el: HTMLElement | SVGElement, prop: string, value: string, by?: 'you' | 'copilot'): Op {
  const prev = el.style.getPropertyValue(prop)
  return {
    label: `SetProp ${describe(el)}/${prop}`,
    author: author(by),
    apply() { el.style.setProperty(prop, value) },
    invert() { return setStyleProp(el, prop, prev, author(by)) },
  }
}

/** insert an element at (parent, index) */
export function insertEl(parent: Element, index: number, el: Element, label?: string, by?: 'you' | 'copilot'): Op {
  return {
    label: label ?? `Insert ${describe(el)}`,
    author: author(by),
    apply() { parent.insertBefore(el, parent.children[index] ?? null) },
    invert() { return removeEl(el, label && `un-${label}`, author(by)) },
  }
}

/** remove an element (remembers its position). The anchor is the following
 * SIBLING NODE, not a child index: prose blocks are mixed content, and an
 * element restored to the wrong side of a text node would come back with
 * different bytes than it left with. */
export function removeEl(el: Element, label?: string, by?: 'you' | 'copilot'): Op {
  const parent = el.parentElement ?? (el.parentNode as Element)
  const next = el.nextSibling
  return {
    label: label ?? `Delete ${describe(el)}`,
    author: author(by),
    apply() { el.remove() },
    invert() { return insertBeforeNode(parent, el, next, undefined, author(by)) },
  }
}

/** insert an element before a specific sibling node (null, or a node that
 * has since moved away, appends) */
function insertBeforeNode(parent: Element, el: Element, ref: Node | null, label?: string, by?: 'you' | 'copilot'): Op {
  return {
    label: label ?? `Insert ${describe(el)}`,
    author: author(by),
    apply() { parent.insertBefore(el, ref && ref.parentNode === parent ? ref : null) },
    invert() { return removeEl(el, label && `un-${label}`, author(by)) },
  }
}

/** move an element to (parent, index) — slide reorder, layout moves */
export function moveEl(el: Element, toParent: ParentNode, toIndex: number, label?: string, by?: 'you' | 'copilot'): Op {
  const fromParent = (el.parentElement ?? el.parentNode) as ParentNode & Element
  const fromIndex = [...fromParent.children].indexOf(el)
  return {
    label: label ?? `Move ${describe(el)}`,
    author: author(by),
    apply() {
      const ref = toParent.children[toIndex] ?? null
      toParent.insertBefore(el, ref === el ? el.nextSibling : ref)
    },
    invert() { return moveEl(el, fromParent as ParentNode & Element, fromIndex, label && `un-${label}`, author(by)) },
  }
}

/** move a scene node and reroute — ALL edges, not just its own: the moved
 * node may now sit in some unrelated edge's path, which must divert */
export function moveSceneNode(scene: SVGSVGElement, node: SVGGElement, geom: NodeGeom, by?: 'you' | 'copilot'): Op {
  const prev = getNodeGeom(node)
  const id = node.getAttribute('data-dia-node') ?? '?'
  return {
    label: `MoveNode ${id} → (${Math.round(geom.x)},${Math.round(geom.y)})`,
    author: author(by),
    apply() { setNodeGeom(node, geom); routeAll(scene) },
    invert() { return moveSceneNode(scene, node, prev, author(by)) },
  }
}

/** set (or clear) an edge's user-owned waypoint and re-route it — the
 * drag of a connector's middle handle, as ONE op */
export function setEdgeVia(scene: SVGSVGElement, edge: SVGGElement, via: string | null, by?: 'you' | 'copilot'): Op {
  const prev = edge.getAttribute('data-via')
  const ref = edge.getAttribute('data-dia-edge') ?? '?'
  return {
    label: via ? `ReRoute ${ref} via (${via})` : `ReRoute ${ref} auto`,
    author: author(by),
    apply() {
      via === null ? edge.removeAttribute('data-via') : edge.setAttribute('data-via', via)
      routeEdge(scene, edge)
    },
    invert() { return setEdgeVia(scene, edge, prev, author(by)) },
  }
}

/** whole-source replacement from the raw LaTeX editor — coarse but
 * truthful undo: one op per source-view session, restoring the exact
 * previous text, DOM children, and span bindings */
export function setDocSource(doc: Doc, newText: string, by?: 'you' | 'copilot'): Op {
  const prevText = doc.source.text
  const prevChildren = [...doc.article.children]
  // the WHOLE project's bindings: applySourceText re-composes, which clears
  // every file's spans and the owner map. Restoring only the main file's
  // would leave the chapter blocks bound to nothing — still on screen,
  // still editable-looking, their edits silently reaching no source
  const prevSpans = doc.project.snapshotBindings()
  const label = 'Edit source'
  return {
    label,
    author: author(by),
    apply() { applySourceText(doc, newText) },
    invert() {
      const redo = () => setDocSource(doc, newText, author(by))
      return {
        label: `un-${label}`,
        author: author(by),
        apply() {
          doc.source.text = prevText
          doc.project.restoreBindings(prevSpans)
          doc.article.replaceChildren(...prevChildren)
        },
        invert: redo,
      }
    },
  }
}

/** batch several ops into one undo step */
export function batch(label: string, ops: Op[], by?: 'you' | 'copilot'): Op {
  return {
    label,
    author: author(by),
    apply() { for (const o of ops) o.apply() },
    invert() {
      const inverses = [...ops].reverse().map((o) => o.invert())
      return batch(`un-${label}`, inverses, author(by))
    },
  }
}

function describe(el: Element): string {
  const role = [...el.classList].find((c) => c.startsWith('dia-'))
  return role ?? el.tagName.toLowerCase()
}
