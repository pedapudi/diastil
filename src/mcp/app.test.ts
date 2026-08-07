/* The MCP App bridge only speaks to a real MCP host. The gate matters: the
 * service-served editor is reachable at a known localhost URL, so a bridge
 * that answered ANY parent would hand every open deck to any website that
 * iframed it. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { initMcpApp } from './app'

const w = window as unknown as {
  parent: unknown
  __diaServiceSameOrigin?: boolean
}

afterEach(() => {
  delete w.__diaServiceSameOrigin
  vi.restoreAllMocks()
})

describe('the MCP App bridge engages only as an MCP App', () => {
  it('stays silent on a bare page — no parent frame to talk to', () => {
    const post = vi.fn()
    vi.spyOn(window, 'parent', 'get').mockReturnValue(window)
    initMcpApp()
    expect(post).not.toHaveBeenCalled()
  })

  it('stays silent when the SERVICE served this page, even inside a frame', () => {
    // dia serve declares the topology; a service-served editor is never an MCP
    // App resource, and answering a parent there is the cross-origin leak
    const post = vi.fn()
    vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage: post } as unknown as Window)
    w.__diaServiceSameOrigin = true
    initMcpApp()
    expect(post).not.toHaveBeenCalled()
  })

  it('handshakes when framed by a host and not service-served', () => {
    const post = vi.fn()
    vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage: post } as unknown as Window)
    initMcpApp()
    expect(post).toHaveBeenCalledTimes(1)
    const msg = post.mock.calls[0][0] as { method?: string; jsonrpc?: string }
    expect(msg.jsonrpc).toBe('2.0')
    expect(msg.method).toBe('ui/initialize')
  })
})
