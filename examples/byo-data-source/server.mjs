/**
 * WP126 参考实现：**自带数据接口**（Node 单文件，假数据，可运行）。
 *
 * 这是给「自带数据接口（高级）」那张卡的用户看的一把尺：
 * 一个服务只要能按 `@agentsws/contracts` 的 `byo-data-source.ts` 那份公开格式
 * 回 JSON，就能挂进 Agents 工坊——这一份用假数据演全部四个端点 + 测试连接。
 *
 * **不做任何平台预设**：这里不叫任何第三方数据平台的名字，也不演示怎么对接
 * 任何一个真实平台——数据全是编的。
 *
 * 跑法：`node examples/byo-data-source/server.mjs`（默认 127.0.0.1:8787，
 * `BYO_PORT` 环境变量可改）。密钥随便填（这一份不校验）。
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.BYO_PORT ?? 8787)

/** 假数据：一个编出来的小库（与真实平台无任何关系）。 */
const CREATORS = [
  {
    channel: 'youtube',
    handle: 'samplestudio',
    display_name: 'Sample Studio',
    url: 'https://www.youtube.com/@samplestudio',
    followers: 52_000,
    engagement_rate: 0.041,
    category: '3c',
    region: 'CN',
    observed_at: new Date().toISOString(),
  },
  {
    channel: 'youtube',
    handle: 'anothercreator',
    display_name: 'Another Creator',
    url: 'https://www.youtube.com/@anothercreator',
    followers: 12_000,
    engagement_rate: 0.052,
    category: 'beauty',
    region: 'CN',
    observed_at: new Date().toISOString(),
  },
]

const CONTENT = [
  {
    id: 'c_1',
    kind: 'video',
    published_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    views: 41_000,
    likes: 2_300,
    comments: 180,
    shares: 90,
  },
  {
    id: 'c_2',
    kind: 'video',
    published_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    views: 18_000,
    likes: 900,
    comments: 60,
    shares: 30,
  },
]

const CONTACTS = [
  { kind: 'email', value: 'hello@samplestudio.example', source: '主页公开邮箱' },
]

/** 归一化对象的形状就是契约那份公开格式；这里只做最浅的校验。 */
function match(q) {
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return CREATORS
  return CREATORS.filter((c) =>
    words.some((w) => `${c.handle} ${c.display_name} ${c.category ?? ''}`.toLowerCase().includes(w)),
  )
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

const server = createServer(async (req, res) => {
  // 鉴权就一种：Bearer。这一份不校验密钥值，但**没有**就 401——形状要全。
  if ((req.headers.authorization ?? '') === '')
    return send(res, 401, { code: 'unauthorized', message: '缺 Authorization 头（Bearer 密钥）。' })

  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const body = await readBody(req)
  if (body === undefined)
    return send(res, 400, { code: 'invalid_input', message: '请求体不是合法 JSON。' })

  if (req.method === 'POST' && url.pathname === '/byo/v1/search') {
    const limit = Math.min(Math.max(1, Number(body.limit ?? 20)), 50)
    const creators = match(body.q)
      .filter(
        (c) =>
          (body.min_followers === undefined || c.followers >= body.min_followers) &&
          (body.max_followers === undefined || c.followers <= body.max_followers),
      )
      .slice(0, limit)
    return send(res, 200, { creators })
  }

  if (req.method === 'POST' && url.pathname === '/byo/v1/profile') {
    const creator = CREATORS.find((c) => c.handle === body.handle)
    if (creator === undefined)
      return send(res, 404, { code: 'not_found', message: `没有 ${body.handle} 这个人。` })
    return send(res, 200, { creator, recent_content: CONTENT })
  }

  if (req.method === 'POST' && url.pathname === '/byo/v1/audit') {
    const creator = CREATORS.find((c) => c.handle === body.handle)
    if (creator === undefined)
      return send(res, 404, { code: 'not_found', message: `没有 ${body.handle} 这个人。` })
    // 假数据也守规矩：样本不够就说不够，不编
    return send(res, 200, {
      creator,
      sample_size: 2,
      insufficient_samples: true,
      risk_flags: ['single_source'],
      note: '参考实现只有假数据，样本永远不够。',
    })
  }

  if (req.method === 'POST' && url.pathname === '/byo/v1/contacts') {
    const creator = CREATORS.find((c) => c.handle === body.handle)
    if (creator === undefined) return send(res, 200, { contacts: [] })
    return send(res, 200, { contacts: creator.handle === 'samplestudio' ? CONTACTS : [] })
  }

  return send(res, 404, { code: 'not_found', message: `不认识的路径：${url.pathname}` })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`BYO 参考实现在 http://127.0.0.1:${PORT} 上（假数据；Ctrl-C 停）`)
})
