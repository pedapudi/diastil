/* Deterministic SVG→scene lift — exactness or nothing. */

import { describe, expect, it } from 'vitest'
import { liftSimpleSvg, parsePathData } from './svglift'

function svgOf(inner: string, viewBox = '0 0 200 100'): SVGSVGElement {
  const host = document.createElement('div')
  host.innerHTML = `<svg viewBox="${viewBox}">${inner}</svg>`
  return host.querySelector('svg') as SVGSVGElement
}

describe('liftSimpleSvg', () => {
  it('lifts rects and circles into nodes in place, preserving order', () => {
    const svg = svgOf(
      '<rect x="10" y="10" width="60" height="30" style="fill: rgb(200, 10, 10)"/>' +
      '<circle cx="120" cy="50" r="20" style="fill: none; stroke: rgb(0, 0, 0); stroke-width: 2px"/>',
    )
    expect(liftSimpleSvg(svg)).toBe(2)
    expect(svg.classList.contains('dia-scene')).toBe(true)
    const nodes = svg.querySelectorAll('g[data-dia-node]')
    expect(nodes.length).toBe(2)
    expect(nodes[0].getAttribute('data-shape')).toBe('rect')
    expect(nodes[0].getAttribute('data-x')).toBe('10')
    expect(nodes[0].getAttribute('data-w')).toBe('60')
    expect(nodes[0].getAttribute('style')).toContain('--dia-node-fill: rgb(200, 10, 10)')
    expect(nodes[1].getAttribute('data-shape')).toBe('ellipse')
    expect(nodes[1].getAttribute('data-x')).toBe('100') // cx - r
    expect(nodes[1].getAttribute('style')).toContain('--dia-node-fill: none')
    expect(nodes[1].getAttribute('style')).toContain('--dia-node-stroke-w: 2px')
    // derived artifacts rendered
    expect(nodes[0].querySelector('rect.dia-node-shape')).not.toBeNull()
    expect(nodes[1].querySelector('ellipse.dia-node-shape')).not.toBeNull()
  })

  it('keeps text and transformed shapes verbatim', () => {
    const svg = svgOf(
      '<rect x="0" y="0" width="50" height="20"/>' +
      '<rect x="0" y="30" width="50" height="20" transform="rotate(10)"/>' +
      '<text x="5" y="15">label</text>',
    )
    expect(liftSimpleSvg(svg)).toBe(1)
    expect(svg.querySelectorAll('g[data-dia-node]').length).toBe(1)
    expect(svg.querySelectorAll('rect:not(.dia-node-shape)').length).toBe(1) // the rotated one
    expect(svg.querySelector('text')?.textContent).toBe('label')
  })

  it('skips shapes with markers, and whole svgs without a viewBox', () => {
    const marked = svgOf('<line x1="0" y1="0" x2="50" y2="50" marker-end="url(#a)"/>')
    expect(liftSimpleSvg(marked)).toBe(0)
    const host = document.createElement('div')
    host.innerHTML = '<svg><rect x="0" y="0" width="50" height="20"/></svg>'
    expect(liftSimpleSvg(host.querySelector('svg') as SVGSVGElement)).toBe(0)
  })

  it('never touches an existing scene', () => {
    const svg = svgOf('<g data-dia-node="a" data-x="0" data-y="0" data-w="10" data-h="10"></g><rect x="0" y="0" width="50" height="20"/>')
    expect(liftSimpleSvg(svg)).toBe(0)
  })

  it('freeform path → path node with a 100×100-normalized outline', () => {
    const svg = svgOf('<path d="M20,10 L80,10 L50,60 Z" style="fill: rgb(1, 2, 3)"/>')
    expect(liftSimpleSvg(svg)).toBe(1)
    const node = svg.querySelector('g[data-dia-node]')!
    expect(node.getAttribute('data-shape')).toBe('path')
    expect(node.getAttribute('data-x')).toBe('20')
    expect(node.getAttribute('data-y')).toBe('10')
    expect(node.getAttribute('data-w')).toBe('60')
    expect(node.getAttribute('data-h')).toBe('50')
    // bbox corners map to 0/100
    expect(node.getAttribute('data-path')).toBe('M0,0 L100,0 L50,100 Z')
  })

  it('polygon diamonds and dashed strokes survive with their paint', () => {
    const svg = svgOf(
      '<polygon points="50,0 100,25 50,50 0,25" style="fill: none; stroke: rgb(9, 9, 9); stroke-dasharray: 4px, 3px"/>',
    )
    expect(liftSimpleSvg(svg)).toBe(1)
    const node = svg.querySelector('g[data-dia-node]')!
    expect(node.getAttribute('style')).toContain('stroke-dasharray: 4px, 3px')
  })
})

describe('parsePathData', () => {
  it('absolutizes relative commands', () => {
    const cmds = parsePathData('m10,10 l20,0 v10 h-20 z')!
    expect(cmds.map((c) => c.c).join('')).toBe('MLVHZ')
    expect(cmds[1].args).toEqual([30, 10])
    expect(cmds[2].args).toEqual([20])
    expect(cmds[3].args).toEqual([10])
  })

  it('accepts rotation-0 arcs, rejects rotated arcs', () => {
    expect(parsePathData('M10,50 A40,40 0 1 1 90,50 Z')).not.toBeNull()
    expect(parsePathData('M10,50 A40,40 30 1 1 90,50 Z')).toBeNull()
  })

  it('rejects junk', () => {
    expect(parsePathData('not a path')).toBeNull()
    expect(parsePathData('L10,10')).toBeNull()
  })

  it('implicit lineto after moveto', () => {
    const cmds = parsePathData('M0,0 10,10 20,20')!
    expect(cmds.map((c) => c.c).join('')).toBe('MLL')
  })
})
