import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDocumentLayout, documentLayout, rectsForBlock, setDocumentLayout } from './pagelayout'

describe('compiled document layout', () => {
  beforeEach(() => clearDocumentLayout())

  it('indexes immutable page-space rectangles by semantic block id', () => {
    const block = document.createElement('p')
    block.dataset.diaId = 'b1'
    setDocumentLayout({
      jobId: 'job-1',
      pages: [{ n: 1, wPt: 612, hPt: 792 }],
      byBlock: new Map([['b1', [{ blockId: 'b1', page: 1, xMin: 72, xMax: 540, yMin: 90, yMax: 112 }]]]),
    })
    expect(documentLayout()?.jobId).toBe('job-1')
    expect(rectsForBlock(block)).toEqual([
      { blockId: 'b1', page: 1, xMin: 72, xMax: 540, yMin: 90, yMax: 112 },
    ])
  })

  it('announces replacement and clearing to page consumers', () => {
    const seen = vi.fn()
    window.addEventListener('dia-document-layout', seen)
    setDocumentLayout({ jobId: 'j', pages: [], byBlock: new Map() })
    clearDocumentLayout()
    expect(seen).toHaveBeenCalledTimes(2)
    window.removeEventListener('dia-document-layout', seen)
  })
})
