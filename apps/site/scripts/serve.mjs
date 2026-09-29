/**
 * 把 `dist/` 当静态站起一个本机服务（只听 127.0.0.1，随机端口），给截图与 Lighthouse 用。
 * 行为照 Cloudflare Workers 静态资源的默认：`/x/` → `/x/index.html`，找不到回 `404.html`（状态 404）。
 * 单独跑：`node scripts/serve.mjs [端口]`。
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
}

function resolve(url) {
  const path = normalize(decodeURIComponent(new URL(url, 'http://x').pathname)).replace(
    /^(\.\.[/\\])+/,
    '',
  )
  let file = join(DIST, path)
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  return existsSync(file) ? file : null
}

export function serve(port = 0) {
  return new Promise((ok) => {
    const server = createServer((req, res) => {
      const file = resolve(req.url ?? '/')
      const status = file ? 200 : 404
      const body = file ?? join(DIST, '404.html')
      res.writeHead(status, {
        'content-type': TYPES[extname(body)] ?? 'application/octet-stream',
        'cache-control': body.includes('/_astro/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      })
      createReadStream(body).pipe(res)
    })
    server.listen(port, '127.0.0.1', () => ok(server))
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await serve(Number(process.argv[2] ?? 0))
  console.log(`http://127.0.0.1:${server.address().port}/`)
}
