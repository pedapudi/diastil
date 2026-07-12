/* Emit dist/diastil.html — the whole editor as ONE self-contained HTML file.
 * Opens from file:// (no server, no toolchain): the module script is inline
 * so nothing is fetched, fonts ride along as data URIs, decks open via the
 * file-input fallback and save as downloads (the File System Access picker
 * needs a secure context, which file:// is not).
 *
 * Run after `vite build`:  node scripts/standalone.mjs   (`npm run standalone`) */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const html = readFileSync(join(dist, 'index.html'), 'utf8')

const scriptMatch = /<script type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"[^>]*><\/script>/.exec(html)
const cssMatch = /<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"[^>]*>/.exec(html)
if (!scriptMatch || !cssMatch) {
  console.error('standalone: could not find the built script/css tags — run `npm run build` first')
  process.exit(1)
}

let js = readFileSync(join(dist, scriptMatch[1]), 'utf8')
// an inline script must not contain a literal </script  (it would end the tag)
js = js.replaceAll('</script', '<\\/script')

let css = readFileSync(join(dist, cssMatch[1]), 'utf8')
// fonts: /fonts/ and ../fonts/ urls become data URIs so file:// has them
css = css.replace(/url\(\s*["']?(?:\.\.\/|\/)(fonts\/[^"')]+)["']?\s*\)/g, (m, rel) => {
  const p = join(dist, rel)
  if (!existsSync(p)) {
    console.warn(`standalone: ${rel} missing — leaving the url as-is`)
    return m
  }
  const b64 = readFileSync(p).toString('base64')
  return `url(data:font/woff2;base64,${b64})`
})

// replacement FUNCTIONS: with a replacement string, `$`-sequences inside the
// minified js/css ($&, $', …) would be interpreted as substitution patterns
const out = html
  .replace(cssMatch[0], () => `<style>\n${css}\n</style>`)
  .replace(scriptMatch[0], () => `<script type="module">\n${js}\n</script>`)
  .replace(/<link rel="modulepreload"[^>]*>\s*/g, '')

const target = join(dist, 'diastil.html')
writeFileSync(target, out)
console.log(`standalone: wrote ${target} (${(out.length / 1024).toFixed(0)} KB)`)
