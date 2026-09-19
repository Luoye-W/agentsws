/**
 * background 里那个「经纪人」：页面要什么、本机服务答什么、答不上来时怎么办。
 *
 * 单独抽出来是为了**能测**——它一个 `chrome.*` 都不碰（存储口与 fetch 都是注入的），
 * 于是「应用没开就排队、应用起来就补传」这条最容易出错的逻辑可以在测试里
 * 反复演一遍，而不用真的去开关一个桌面应用。
 *
 * 一条贯穿始终的纪律：**如实说**。
 * - 写进去了就说写进去了；
 * - 排着就说排着（而不是画一个绿勾）；
 * - 登录态转发去了公共库，卡片上也如实说共享了几条。
 *   Chrome 应用商店对数据收集要求显著披露，而这里是用户真正会看的那一处。
 */

import { hello, ingest, LOCAL_TIMEOUT_MS, redeemPairing } from './local-client.js'
import type { ExtensionStatus, ObserveOutcome } from './messages.js'
import { statusFromHello } from './messages.js'
import type { KeyValueStore } from './storage.js'
import {
  dropFromQueue,
  enqueue,
  forgetToken,
  readQueue,
  readSettings,
  writeSettings,
} from './storage.js'
import type { ExtensionObservationInput, LocalCallResult } from './wire.js'
import { UNAUTHORIZED_MESSAGE } from './wire.js'

export interface BrokerDeps {
  store: KeyValueStore
  fetch?: typeof globalThis.fetch | undefined
  now: () => string
  /** 打本机最多等多久。不给走 {@link LOCAL_TIMEOUT_MS}；测试里调短。 */
  timeoutMs?: number | undefined
}

/** 把注入项（假 fetch、短超时）摊进 local-client 的入参。 */
const wiring = (deps: BrokerDeps): { fetch?: typeof globalThis.fetch; timeoutMs?: number } => ({
  ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
})

/** 补传时一次最多发多少条（与本机服务那一侧的 100 条上限对齐）。 */
export const FLUSH_BATCH = 100

async function optionsOf(deps: BrokerDeps): Promise<{ port: number; token?: string | undefined }> {
  const settings = await readSettings(deps.store)
  return { port: settings.port, ...(settings.token === undefined ? {} : { token: settings.token }) }
}

/**
 * 现在是个什么状况。
 *
 * 没配对时**不去打本机服务**：没令牌打过去只会拿一个 401，
 * 而「还没配对」与「配对失效了」是两句不同的话。
 */
export async function status(deps: BrokerDeps): Promise<ExtensionStatus> {
  const settings = await readSettings(deps.store)
  const queued = (await readQueue(deps.store)).length
  if (settings.token === undefined) {
    return {
      paired: false,
      online: false,
      port: settings.port,
      cloud_linked: false,
      shares_to_public_library: false,
      queued,
    }
  }
  const said = await hello({ port: settings.port, token: settings.token, ...wiring(deps) })
  if (!said.ok) {
    return {
      paired: true,
      online: false,
      port: settings.port,
      ...(settings.workspace_name === undefined ? {} : { workspace_name: settings.workspace_name }),
      cloud_linked: settings.cloud_linked ?? false,
      shares_to_public_library: settings.cloud_linked ?? false,
      queued,
      note: said.message,
    }
  }
  const facts = statusFromHello(said.data)
  await writeSettings(deps.store, {
    workspace_name: facts.workspace_name,
    cloud_linked: facts.cloud_linked,
  })
  return { paired: true, online: true, port: settings.port, queued, ...facts }
}

/**
 * 报一批观测。
 *
 * 顺序有意义：**先把积压的补上去，再发这一批**。
 * 反过来的话，用户会看到今天这条已经进去了、上周那条还排着，
 * 而他并不知道队列的存在——那看上去就是"插件丢数据"。
 */
export async function observe(
  deps: BrokerDeps,
  rows: readonly ExtensionObservationInput[],
): Promise<ObserveOutcome> {
  const opts = await optionsOf(deps)
  if (opts.token === undefined) {
    const queue = await enqueue(deps.store, rows, deps.now())
    return {
      kind: 'queued',
      queued: queue.length,
      message: '还没和这台电脑上的 Agents 工坊配对，先收在插件里。配对之后会一起补上去。',
    }
  }

  await flush(deps)

  const sent = await ingest({ ...opts, ...wiring(deps) }, rows)
  if (sent.ok) {
    const saved = sent.data.rows.filter((r) => r.status === 'ok').length
    const deduped = sent.data.rows.filter((r) => r.status === 'deduped').length
    return {
      kind: 'saved',
      saved,
      deduped,
      forwarded_to_public_library: sent.data.forwarded_to_public_library,
    }
  }
  if (sent.kind === 'offline') {
    const queue = await enqueue(deps.store, rows, deps.now())
    return { kind: 'queued', queued: queue.length, message: sent.message }
  }
  // 401 / 别的错一律**不排队**：排一堆发不出去的东西只会让队列越来越长，
  // 而用户要做的是去工作台重新配一次对。
  return { kind: 'failed', message: sent.message }
}

/**
 * 把积压的补上去。
 *
 * 成功一批就当场摘掉一批（而不是全部发完再摘）——中途断了也不会重发已经进去的。
 * 服务端那一侧本来就按 handle 去重，重发最多产生 `deduped`，但少发一次总是更好。
 */
export async function flush(deps: BrokerDeps): Promise<{ sent: number; left: number }> {
  const opts = await optionsOf(deps)
  if (opts.token === undefined) return { sent: 0, left: (await readQueue(deps.store)).length }

  let sent = 0
  for (;;) {
    const queue = await readQueue(deps.store)
    if (queue.length === 0) return { sent, left: 0 }
    const batch = queue.slice(0, FLUSH_BATCH)
    const out = await ingest(
      { ...opts, ...wiring(deps) },
      batch.map((q) => q.observation),
    )
    if (!out.ok) return { sent, left: queue.length }
    await dropFromQueue(deps.store, batch.length)
    sent += batch.length
  }
}

/** 输入 6 位码。成功就把令牌存下来，并立刻把积压的补上去。 */
export async function pair(
  deps: BrokerDeps,
  code: string,
): Promise<{ ok: boolean; message: string }> {
  const settings = await readSettings(deps.store)
  const out: LocalCallResult<{ token: string }> = await redeemPairing(
    { port: settings.port, ...wiring(deps) },
    code.trim(),
  )
  if (!out.ok) {
    if (out.kind === 'offline')
      return {
        ok: false,
        message: `连不上这台电脑上的 Agents 工坊（127.0.0.1:${settings.port}）。先把应用打开，端口对不上的话在下面改。`,
      }
    if (out.kind === 'unauthorized')
      return { ok: false, message: '这个码不对、已经用过，或者过了 5 分钟。回工作台再生成一个。' }
    return { ok: false, message: out.message }
  }
  await writeSettings(deps.store, { token: out.data.token, paired_at: deps.now() })
  const flushed = await flush(deps)
  return {
    ok: true,
    message:
      flushed.sent > 0
        ? `配上了。顺手把排着的 ${flushed.sent} 条补进去了。`
        : '配上了。以后在 YouTube / Instagram / TikTok 页面上按一下就能收进红人库。',
  }
}

/** 解除配对。队列**留着**——用户可能只是想换一个工作区。 */
export async function unpair(deps: BrokerDeps): Promise<void> {
  await forgetToken(deps.store)
}

/** 令牌被工作台撤了之后，本机服务会一路回 401；这里给一句固定的人话。 */
export const REPAIR_HINT = UNAUTHORIZED_MESSAGE
