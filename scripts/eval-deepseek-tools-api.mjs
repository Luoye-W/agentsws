import { execFileSync } from 'node:child_process'

const key =
  process.env.DEEPSEEK_API_KEY ||
  execFileSync('security', ['find-generic-password', '-s', 'agentsws-deepseek', '-w'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
const base = 'https://api.deepseek.com/v1/tools'
async function call(op, body) {
  const t = Date.now()
  try {
    const r = await fetch(`${base}/${op}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      redirect: 'manual',
    })
    const txt = await r.text()
    return { status: r.status, ms: Date.now() - t, len: txt.length, txt }
  } catch (e) {
    return { status: 'ERR', ms: Date.now() - t, err: String(e).slice(0, 150) }
  }
}
const urls = [
  'https://www.reddit.com/r/SmartGlasses/',
  'https://www.reddit.com/r/AR_MR_XR/comments/1b0s5ak/',
  'https://www.linkedin.com/company/xreal/',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://x.com/XREAL_Global',
  'https://www.amazon.com/s?k=translation+glasses',
  'https://www.trustpilot.com/review/xreal.com',
  'https://www.nytimes.com/',
  'https://en.wikipedia.org/wiki/Smartglasses',
  'https://www.google.com/search?q=smart+glasses',
  'https://www.xreal.com/',
  'https://www.zhihu.com/',
]
console.log('== FETCH ==')
for (const url of urls) {
  const r = await call('fetch', { url })
  const head = (r.txt || r.err || '').replace(/\s+/g, ' ').slice(0, 90)
  console.log(
    `${String(r.status).padEnd(4)} ${String(r.len ?? '-').padStart(7)}B ${String(r.ms).padStart(6)}ms  ${url}\n      ${head}`,
  )
}
console.log('== SEARCH ==')
for (const query of [
  'XREAL One review reddit',
  'site:reddit.com smart glasses captions',
  'smart glasses head of marketing linkedin',
  '智能眼镜 推荐 2026',
]) {
  const r = await call('search', { query, count: 10, need_content: false })
  let hosts = '-'
  try {
    const j = JSON.parse(r.txt)
    hosts = (j.results || [])
      .map((x) => {
        try {
          return new URL(x.url).hostname.replace(/^www\./, '')
        } catch {
          return '?'
        }
      })
      .join(', ')
  } catch {
    hosts = (r.txt || r.err || '').slice(0, 120)
  }
  console.log(`${r.status} ${r.ms}ms ${query}\n      ${hosts}`)
}
