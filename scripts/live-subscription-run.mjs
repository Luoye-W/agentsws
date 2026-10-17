#!/usr/bin/env node
/**
 * WP362：**真机验收**——用 ChatGPT 订阅登录、选它当默认模型、在随便聊里跑一轮「问一句 + 联网搜索」（决策 938）。
 *
 * 默认不进 CI；由主会话和 Luoye 在本机一起跑。走的是**产品里那一整条路**（真 `createServer`，在进程里直接
 * 调它的 HTTP 路由，不监听端口）：设置 → 模型的订阅登录 → 「默认模型」下拉里选订阅 → 随便聊发一句。
 *
 * 纪律：
 * - **临时数据目录 + 临时秘密库密钥**：密钥只在这个进程的内存里；跑完（成没成都一样）整个目录删掉；
 * - **设备码登录由人在手机上完成**：屏幕上出一个网址和一串码，用手机打开、输入、确认；
 * - **不读、不打印任何令牌**：令牌只在本机加密库与官方 pi-ai 的内存里；输出前再兜一道脱敏（像令牌的长串换成 ***）；
 *   服务进程自己的日志不往屏幕上放（只放 `web-search:` 那几行，看搜索走了哪一路）；
 * - 不碰 4317、不碰你已有的数据目录与连接；不连别的公开搜索服务（自带搜索搜不成就照实说，加 `--fallback` 才退回公开搜索）；
 * - 只打 ChatGPT 订阅那一个地址（`chatgpt.com/backend-api/codex/responses`），花的是订阅额度，不花钱。
 *
 * 先 `npx tsc -b`（用 `apps/server/dist`）。跑法：
 *
 *     node scripts/live-subscription-run.mjs
 *     node scripts/live-subscription-run.mjs --model gpt-5.5 --question "…" --fallback
 *     node scripts/live-subscription-run.mjs --model gpt-5.5 --effort deep   # WP370：思考程度 fast / standard / deep
 *
 * 屏幕上依次出：订阅进没进两处清单、默认模型设成了谁、这一轮用的是哪个来源、搜了什么、
 * 搜索来自哪一路（ChatGPT 自带搜索 / 退回别的）、回答的头几行、用量（订阅那几笔花费都是 0）。
 *
 * `--dry-run`：不出网的演练——把 `globalThis.fetch` 换成 dsh-adapter 测试里那个假的 OpenAI（设备码自动通过、
 * Codex 回一次工具调用 / 一次带引用的搜索 / 一段回答），只用来先看这条路通不通；真验收不要加它。
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = (p) => pathToFileURL(join(ROOT, 'apps/server/dist', p)).href

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const flag = (name) => args.includes(name)
const MODEL = opt('--model') ?? 'gpt-5.5'
/** WP370：思考程度三档白话（fast 快 / standard 标准 / deep 深想）；不给 = 模型默认档。 */
const EFFORT_LEVEL = opt('--effort')
const QUESTION =
  opt('--question') ??
  '用联网搜索查一下 site:reddit.com smart glasses，挑三条最有用的讨论，每条一句话说它讲了什么，附上网址。'

/** 输出前兜一道：像令牌的一律换掉（脚本本身不碰令牌，这是防上游错误信息里带出来）。 */
const scrub = (text) =>
  String(text)
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/gu, '***')
    .replace(/(?:sk|rt|at)[-_][\w-]{16,}/giu, '***')
    .replace(/[A-Za-z0-9+/_-]{48,}/gu, '***')

// 服务进程的日志不上屏：只放 `web-search:` 那几行（看搜索走了哪一路），也过一道脱敏
const rawWrite = process.stdout.write.bind(process.stdout)
const say = (line = '') => rawWrite(`${scrub(line)}\n`)
const searchLog = []
process.stdout.write = (chunk, ...rest) => {
  for (const line of String(chunk).split('\n')) {
    if (line.startsWith('web-search:')) {
      searchLog.push(line)
      rawWrite(`  · ${scrub(line)}\n`)
    }
  }
  const cb = rest.find((x) => typeof x === 'function')
  if (cb !== undefined) cb()
  return true
}

// 演练：换上假的 OpenAI（同 dsh-adapter 的测试替身），一个包都不出网
if (flag('--dry-run')) {
  const fake = await import(
    pathToFileURL(join(ROOT, 'packages/dsh-adapter/test/fixtures/fake-openai.ts')).href
  )
  // Responses 的服务端搜索工具是 `{type: 'web_search'}`；随便聊给模型的那个是 `{type: 'function', name: 'web_search'}`
  const hasTool = (body, type) =>
    Array.isArray(body?.tools) && body.tools.some((t) => t?.type === type)
  const searched = (body) => JSON.stringify(body?.input ?? []).includes('function_call_output')
  fake.installFakeOpenAi({
    completeOnPoll: 1,
    outputItems: (body) => {
      if (hasTool(body, 'web_search'))
        return [
          {
            type: 'web_search_call',
            id: 'ws_1',
            status: 'completed',
            action: { type: 'search', query: 'site:reddit.com smart glasses' },
          },
          {
            type: 'message',
            id: 'msg_s',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: '- People compare smart glasses (reddit.com)',
                annotations: [
                  {
                    type: 'url_citation',
                    url: 'https://www.reddit.com/r/SmartGlasses/comments/a1/compare/',
                    title: 'Smart glasses compared',
                    start_index: 37,
                    end_index: 49,
                  },
                ],
              },
            ],
          },
        ]
      if (!searched(body))
        return [
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'web_search',
            arguments: JSON.stringify({ query: 'site:reddit.com smart glasses' }),
          },
        ]
      return [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [
            { type: 'output_text', text: '（演练）Reddit 上有人把几款智能眼镜放在一起比。' },
          ],
        },
      ]
    },
  })
  say('（演练：用的是假的 OpenAI，没出网）')
}

const { createServer } = await import(dist('server.js'))
const { SECRETS_KEY_ENV } = await import(dist('secret-store.js'))

const dir = mkdtempSync(join(tmpdir(), 'wp362-live-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let server
let failed = false

try {
  server = await createServer({
    dbDir: dir,
    quiet: true,
    // 不带你机器上的环境变量进来（别的 key 一个都不碰）：只有这一把临时密钥
    env: {
      [SECRETS_KEY_ENV]: randomBytes(32).toString('hex'),
      AGENTSWS_OWNER_EMAIL: 'owner@example.invalid',
    },
    webSearch: {
      channel: false,
      keyless: flag('--fallback'),
    },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
  const call = async (method, path, body) => {
    const headers = new Headers()
    headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
    headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
    if (body !== undefined) headers.set('content-type', 'application/json')
    return server.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }
  const data = async (res) => {
    const json = await res.json()
    if (!res.ok) throw new Error(`${res.status} ${json?.error?.message ?? JSON.stringify(json)}`)
    return json.data
  }

  // ① 设备码登录（人在手机上完成）
  say('① 用 ChatGPT 订阅登录（设备码）')
  let view = await data(
    await call('POST', '/v1/settings/models/subscription/login', {
      provider: 'openai-codex',
      method: 'device',
    }),
  )
  if (view.notice?.url !== undefined)
    say(
      `   用手机打开 ${view.notice.url} ，输入 ${view.notice.code ?? '（见页面）'}，确认授权。等你点完……`,
    )
  for (let i = 0; i < 180 && !view.signed_in; i++) {
    await sleep(2000)
    view = await data(await call('GET', '/v1/settings/models/subscription/openai-codex'))
    if (view.last_error !== undefined) throw new Error(`登录没成：${view.last_error}`)
  }
  if (!view.signed_in) throw new Error('6 分钟内没完成登录，先停了。')
  say(`   已登录（账号 ${view.account ?? '—'}，到期 ${view.expires_at ?? '—'}）`)

  // ② 订阅进没进两处清单（目录是异步读进来的，等它一下）
  say('② 订阅进没进「默认模型」下拉与输入框的 AI 钮')
  let defaults
  let chat
  for (let i = 0; i < 20; i++) {
    defaults = await data(await call('GET', '/v1/models/defaults'))
    chat = await data(await call('GET', '/v1/free-chat/models'))
    if (defaults.choices.some((c) => c.id === `openai-codex/${MODEL}`)) break
    await sleep(500)
  }
  const inDefaults = defaults.choices.filter((c) => c.id.startsWith('openai-codex/'))
  const inButton = chat.choices.filter((c) => c.id.startsWith('openai-codex/'))
  say(`   默认模型下拉：${inDefaults.map((c) => c.label).join('、') || '（没有）'}`)
  say(
    `   AI 钮：${inButton.map((c) => `${c.id}（${c.price?.kind ?? '—'}）`).join('、') || '（没有）'}`,
  )
  if (!inDefaults.some((c) => c.id === `openai-codex/${MODEL}`))
    throw new Error(`订阅目录里没有 ${MODEL}（--model 换一个上面列出来的）`)
  // WP370：这个模型能调哪几档思考程度（AI 钮里「思考：快 / 标准 / 深想」那一行的数据）
  const picked = chat.choices.find((c) => c.id === `openai-codex/${MODEL}`)
  const thinking = picked?.thinking
  say(
    `   ${picked?.name ?? MODEL} 的思考程度：${
      thinking === undefined
        ? '（这个模型没有档可调）'
        : thinking.options.map((o) => `${o.level}=${o.effort}`).join('、') +
          `；默认 ${thinking.default}`
    }`,
  )
  const effort =
    EFFORT_LEVEL === undefined
      ? undefined
      : thinking?.options.find((o) => o.level === EFFORT_LEVEL)?.effort
  if (EFFORT_LEVEL !== undefined && effort === undefined)
    throw new Error(`${MODEL} 没有「${EFFORT_LEVEL}」这一档（--effort 用 fast / standard / deep）`)

  // ③ 选订阅当默认模型
  const after = await data(
    await call('PUT', '/v1/models/defaults', { default: `openai-codex/${MODEL}` }),
  )
  say(`③ 默认模型设成了：${after.default}`)

  // ④ 随便聊：问一句 + 联网搜索
  say(`④ 随便聊问一句（开联网搜索）：${QUESTION}`)
  const session = await data(await call('POST', '/v1/free-chat/sessions', {}))
  if (effort !== undefined) say(`   这一轮的思考程度：${EFFORT_LEVEL}（${effort}）`)
  const res = await call('POST', `/v1/free-chat/sessions/${session.id}/messages`, {
    text: QUESTION,
    web_search: true,
    // WP370：连同模型一起交思考程度（AI 钮里选「深想」就是这样交上去的）
    ...(effort === undefined ? {} : { model: `openai-codex/${MODEL}`, effort }),
  })
  const frames = (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)))
  let answer = ''
  let model
  for (const f of frames) {
    if (f.type === 'searching') say(`   搜：${f.query}`)
    if (f.type === 'notice') say(`   提示：${f.text}`)
    if (f.type === 'error') {
      failed = true
      say(`   ✗ 没答成：${f.message}`)
    }
    if (f.type === 'delta') answer += f.text
    if (f.type === 'done') {
      model = f.message.model
      answer = f.message.text ?? answer
    }
  }
  const sources = frames.filter((f) => f.type === 'sources').at(-1)?.sources ?? []
  say(`   这一轮用的来源：${model === undefined ? '（没记下）' : `${model.label}（${model.id}）`}`)
  const hosts = [
    ...new Set(
      sources.map((s) => {
        try {
          return new URL(s.url).hostname.replace(/^www\./u, '')
        } catch {
          return '?'
        }
      }),
    ),
  ]
  say(`   搜到 ${sources.length} 条，站点：${hosts.join(' / ') || '—'}`)

  // ⑤ 搜索来自哪一路：自带搜索用了订阅额度就记一笔 `web_search` 用量（花费 0）；没搜成服务端会记一句 web-search 日志
  const usage = await data(await call('GET', '/v1/models/usage'))
  const row = (p) => usage.rows.find((r) => r.purpose === p)
  const native = row('web_search')
  const via =
    native !== undefined && native.calls > 0
      ? 'ChatGPT 自带搜索（用订阅搜的）'
      : searchLog.length > 0
        ? `没走成自带搜索（见上面 web-search 那几行）${flag('--fallback') ? '，退回了公开搜索服务' : ''}`
        : sources.length > 0
          ? '别的路'
          : '没有搜'
  say(`⑤ 搜索来自：${via}`)
  say('   用量（订阅不按 token 收钱，花费应当都是 0）：')
  for (const r of usage.rows)
    say(
      `     ${r.purpose}：${r.calls} 次，输入 ${r.input_tokens} / 输出 ${r.output_tokens} token，花费 ${r.cost_base}`,
    )
  say('⑥ 回答的头几行：')
  for (const line of answer.split('\n').slice(0, 12)) say(`   ${line}`)
  if (model?.id?.startsWith('openai-codex/') !== true) failed = true
} catch (e) {
  failed = true
  say(`✗ ${e instanceof Error ? e.message : String(e)}`)
} finally {
  await server?.close().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
  say(`临时目录已删（${dir.split('/').at(-1)}）`)
}
say(failed ? '\n结果：没通过（见上）' : '\n结果：通过')
process.exit(failed ? 1 : 0)
