/* Op constructors — the ONLY way modules mutate the document.
 * Each returns an Op with apply/invert; route through state.apply(op). */

import type { NodeGeom, Op } from '../types'
import { routeEdgesOf, setNodeGeom, getNodeGeom } from '../scene/route'

const author = (a?: 'you' | 'copilot') => a ?? 'you'

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

/** set an inline style property on an element (last-resort write target) */
export function setStyleProp(el: HTMLElement, prop: string, value: string, by?: 'you' | 'copilot'): Op {
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

/** remove an element (remembers its position) */
export function removeEl(el: Element, label?: string, by?: 'you' | 'copilot'): Op {
  const parent = el.parentElement ?? (el.parentNode as Element)
  const index = [...(parent?.children ?? [])].indexOf(el)
  return {
    label: label ?? `Delete ${describe(el)}`,
    author: author(by),
    apply() { el.remove() },
    invert() { return insertEl(parent, index, el, undefined, author(by)) },
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

/** move a scene node and reroute its edges */
export function moveSceneNode(scene: SVGSVGElement, node: SVGGElement, geom: NodeGeom, by?: 'you' | 'copilot'): Op {
  const prev = getNodeGeom(node)
  const id = node.getAttribute('data-dia-node') ?? '?'
  return {
    label: `MoveNode ${id} → (${Math.round(geom.x)},${Math.round(geom.y)})`,
    author: author(by),
    apply() { setNodeGeom(node, geom); routeEdgesOf(scene, id) },
    invert() { return moveSceneNode(scene, node, prev, author(by)) },
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
