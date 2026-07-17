/* Charts derive deterministically from their data attributes — the same
 * truth-vs-rendering contract as scenes: attrs are canonical, the derived
 * group rebuilds idempotently, everything token-bound. */

import { describe, expect, it } from 'vitest'
import { parseChartValues, renderChart } from './chart'

const NS = 'http://www.w3.org/2000/svg'

function chart(attrs: Record<string, string>): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement
  svg.setAttribute('class', 'dia-chart')
  svg.setAttribute('viewBox', '0 0 430 300')
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v)
  document.body.appendChild(svg)
  return svg
}

describe('parseChartValues', () => {
  it('parses label:number lists with , or ; separators', () => {
    expect(parseChartValues('Q1:12, Q2:19.5; Q3:-7')).toEqual([
      { label: 'Q1', v: 12 }, { label: 'Q2', v: 19.5 }, { label: 'Q3', v: -7 },
    ])
  })
  it('rejects malformed entries wholesale', () => {
    expect(parseChartValues('Q1=12')).toBeNull()
    expect(parseChartValues('')).toBeNull()
  })
})

describe('renderChart', () => {
  it('bar: one token-bound rect per value, heights proportional', () => {
    const svg = chart({ 'data-chart': 'bar', 'data-values': 'a:10, b:20', 'data-max': '20' })
    renderChart(svg)
    const bars = [...svg.querySelectorAll('g.dia-chart-derived rect')]
    expect(bars.length).toBe(2)
    const h = (r: Element): number => parseFloat(r.getAttribute('height')!)
    expect(h(bars[1])).toBeCloseTo(2 * h(bars[0]), 0)
    expect(bars[0].getAttribute('style')).toContain('var(--dia-accent)')
  })

  it('line: a polyline plus a dot per point', () => {
    const svg = chart({ 'data-chart': 'line', 'data-values': '0:1, 1:3, 2:2' })
    renderChart(svg)
    expect(svg.querySelectorAll('g.dia-chart-derived polyline').length).toBe(1)
    expect(svg.querySelectorAll('g.dia-chart-derived circle').length).toBe(3)
  })

  it('re-rendering replaces the derived group instead of stacking', () => {
    const svg = chart({ 'data-chart': 'scatter', 'data-values': '1:1, 2:2' })
    renderChart(svg)
    renderChart(svg)
    expect(svg.querySelectorAll('g.dia-chart-derived').length).toBe(1)
    expect(svg.querySelectorAll('circle').length).toBe(2)
  })

  it('hand-authored content outside the derived group survives', () => {
    const svg = chart({ 'data-chart': 'bar', 'data-values': 'a:5' })
    const note = document.createElementNS(NS, 'text')
    note.textContent = 'annotation'
    svg.appendChild(note)
    renderChart(svg)
    expect(svg.contains(note)).toBe(true)
  })
})
