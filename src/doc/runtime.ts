/* The saved artifact's only script: read-only comment markers.
 *
 * A diastil document reads in any browser with zero dependencies — but a
 * reader opening it should SEE that a passage carries discussion, not have
 * to open the file in the editor to find out. This draws a dotted underline
 * under every OPEN thread's quote and titles it with the first note.
 *
 * It never edits: it wraps matched text in a plain <span> with inline styles
 * and no dialect attributes, in the live DOM only. Nothing here is saved
 * back — the editor regenerates the body from the LaTeX source on load — and
 * the whole thing is fail-silent, so a document whose markers cannot be
 * drawn still reads perfectly.
 *
 * DOC_RUNTIME is a CONSTANT string. serializeDoc emits it verbatim, so the
 * byte-stability contract (DOC-PROFILE §5) holds by construction. */

export const DOC_RUNTIME = `(function () {
  function draw() {
    try {
      var el = document.getElementById('dia-comments')
      var article = document.querySelector('article.dia-doc')
      if (!el || !article) return
      var threads = (JSON.parse(el.textContent || '{}').threads || []).filter(function (t) {
        return t && t.status === 'open' && t.anchor && t.anchor.quote
      })
      for (var i = 0; i < threads.length; i++) {
        var t = threads[i]
        var note = t.notes && t.notes[0]
        mark(article, t.anchor.quote,
          note ? (note.by || 'someone') + ': ' + note.text : 'comment')
      }
    } catch (e) { /* a document must read even when its markers cannot */ }
  }
  function mark(article, quote, tip) {
    var walk = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, null)
    var node
    while ((node = walk.nextNode())) {
      var parent = node.parentNode
      if (!parent || parent.hasAttribute('data-doc-note')) continue
      var at = node.data.indexOf(quote)
      if (at < 0) continue
      var tail = node.splitText(at)
      tail.splitText(quote.length)
      var span = document.createElement('span')
      span.setAttribute('data-doc-note', '')
      span.title = tip
      span.style.borderBottom = '1px dotted currentColor'
      span.style.opacity = '0.8'
      parent.replaceChild(span, tail)
      span.appendChild(tail)
      return
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', draw)
  } else {
    draw()
  }
})()`
