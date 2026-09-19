/**
 * WP117 交付 4：**演练模式**。
 *
 * 第一位内测用户要测红人营销，而红人营销的每一步都会碰到真人——发一封信出去
 * 就收不回来了。演练模式给的是一个**隔离的活动**：库里那批人是合成的
 * （`@agentsws/stand-ins` 的 `KolWorld`），信只在内存里走，时间可以快进，
 * 玩完一键清空。
 *
 * 四条纪律，按重要性排：
 *
 * 1. **硬闸在出站那一跳，不在界面上。** 服务进程只有一个
 *    `deliverOutbound`（`server.ts`），演练的信在**那里**被拦下并改投内存邮箱。
 *    界面上的开关只是开关；就算有人绕过界面直接打接口批准一封演练信，
 *    它也发不出去。测试钉的是这一条，不是开关。
 * 2. **演练数据自己带标记。** `Creator.sandbox` / `Collaboration.sandbox`。
 *    拦不拦、清不清、界面上有没有角标，全看这一格——不靠 id 前缀猜，
 *    更不靠"当前是不是演练模式"这种全局状态（用户可以一边演练一边干真活）。
 * 3. **时间是被推的，不是过的。** 「跳到 3 天后」推的是演练世界自己的时钟。
 *    真时钟一秒都不动——跟进节奏、退信、拖延回信这些只在合成世界里发生。
 * 4. **清空只清带标记的。** 真红人、真合作、真交付物一条不碰。
 */
import type {
  Clock,
  Collaboration,
  Creator,
  CreatorContact,
  Iso8601,
  KolChannel,
  PlatformAccount,
} from '@agentsws/contracts'
import { KolWorld, type SyntheticCreator, syntheticCreators } from '@agentsws/stand-ins'
import type { KolStore } from './kol.js'
import { CONTACT_SECRET_FIELD, contactSecretId } from './kol-service.js'
import type { SecretStore } from './secret-store.js'

/** 演练活动的 id。一个工作区同时只有一个——两个演练场互相看不见对方，没有意义。 */
export const SANDBOX_CAMPAIGN_ID = 'cmp_sandbox'

/** 演练红人的 id 前缀（界面上一眼认得出，日志里 grep 得到）。 */
export const SANDBOX_ID_PREFIX = 'sbx_'

/** 顶上那条状态带的字。**只有这一份**，界面照它显示，不自己拼一句。 */
export const SANDBOX_BANNER = '演练中 · 不会发出任何真邮件'

export interface KolSandboxStatus {
  on: boolean
  /** 演练世界现在几点（真时钟不动，这是被「跳到 N 天后」推出来的那个）。 */
  now: Iso8601
  /** 这条渠道上放了几个合成红人。 */
  creators: number
  collaborations: number
  /** 发出去几封（全部落在内存邮箱里）。 */
  sent: number
  /** 收到几封回信。 */
  replies: number
  /** 还有几封在路上（快进就能收到）。 */
  pending: number
  banner: string
}

/** 一次「跳到 N 天后」之后发生了什么（界面上那一段回执）。 */
export interface KolSandboxAdvanceResult extends KolSandboxStatus {
  advanced_days: number
  /** 这一跳收到的回信（已经归并到各自的合作线程上）。 */
  received: {
    creator_id: string
    display_name: string
    collaboration_id?: string
    subject: string
    body: string
    at: Iso8601
    /** 退信那一封上带着。 */
    bounce_reason?: string
  }[]
}

/**
 * 出站硬闸的判决。
 *
 * `undefined` = 这封信与演练无关，照常走真渠道。给了值就是**拦下了**，
 * 调用方不许再往下投递。
 */
export interface KolSandboxIntercept {
  /** 拦下的理由（进变更账本的执行记录，人看得见为什么"发出去了"却没真发）。 */
  message: string
  creator_id: string
}

export interface KolSandboxOptions {
  store: KolStore
  secrets: SecretStore
  /** 真时钟（只用来给演练世界定一个起点）。 */
  clock: Clock
  seed?: number
  /** 演练库里放几个人。默认 24——够铺开六种性格，又不至于把库刷满。 */
  count?: number
  /** 事件日志（演练里发生的事也要能查，只是带着 sandbox 标记）。 */
  emit?: (type: string, payload: Record<string, unknown>) => void
}

export interface KolSandboxAssembly {
  status(): KolSandboxStatus
  /** 开演练：铺一批合成红人 + 一条演练活动。已经开着就原样返回（幂等）。 */
  start(input: { channel: KolChannel }): KolSandboxStatus
  /** 跳到 N 天后：推演练世界的钟，把到点的回信收进来并推进合作阶段。 */
  advance(input: { days: number }): Promise<KolSandboxAdvanceResult>
  /** 一键清空：删掉所有带 `sandbox` 标记的记录。真数据一条不碰。 */
  clear(): KolSandboxStatus
  /**
   * **出站硬闸**（`server.ts` 的 `deliverOutbound` 在问真渠道之前先问这一句）。
   *
   * `recipients` 是加密库里的 key 名（出站 payload 里存的就是这个，不是地址）。
   * 其中任何一个属于演练红人 → 整封信拦下，改投内存邮箱。
   *
   * **一封信里混了真人与演练红人也一律拦**：宁可一封该发的没发出去，
   * 也不能有一封演练的信真投出去。
   */
  intercept(input: {
    recipients: readonly string[]
    subject: string
    body: string
  }): KolSandboxIntercept | undefined
}

/** 合成红人 → 库里那三条记录（人、账号、联系方式）。 */
function rowsOf(
  creator: SyntheticCreator,
  channel: KolChannel,
  observed_at: Iso8601,
): { creator: Creator; account: PlatformAccount; contact: Omit<CreatorContact, 'value_ref'> } {
  const id = `${SANDBOX_ID_PREFIX}${creator.id}`
  return {
    creator: { id, display_name: creator.display_name, merged_from: [], sandbox: true },
    account: {
      id: `${SANDBOX_ID_PREFIX}pa_${creator.id}`,
      creator_id: id,
      channel,
      handle: creator.handle,
      url: `https://example.com/@${creator.handle}`,
      followers: creator.followers,
      engagement_rate: creator.engagement_rate,
      category: creator.category,
      language: creator.language,
      region: creator.region,
      observed_at,
    },
    contact: {
      id: `${SANDBOX_ID_PREFIX}ctc_${creator.id}`,
      creator_id: id,
      kind: 'email',
      source: 'sandbox',
    },
  }
}

export function createKolSandbox(options: KolSandboxOptions): KolSandboxAssembly {
  const { store, secrets, clock } = options
  const count = options.count ?? 24
  const seed = options.seed ?? 42
  const emit = options.emit ?? ((): void => {})

  /** 合成世界。演练关掉再开就换一个新的——上一场的信不该串到这一场。 */
  let world: KolWorld | undefined
  /** 演练世界的当前时刻（真时钟不动）。 */
  let virtualNow: Iso8601 = clock.now()
  /** 这一场用的是哪条渠道。 */
  let channel: KolChannel | undefined

  /** 加密库 key 名 → 演练红人 id。硬闸靠它判，不解密、不碰明文。 */
  const refToCreator = new Map<string, string>()

  const sandboxCreators = (): Creator[] => store.creators().filter((c) => c.sandbox === true)
  const sandboxCollabs = (): Collaboration[] =>
    store.collaborations().filter((c) => c.sandbox === true)

  const status = (): KolSandboxStatus => ({
    on: world !== undefined,
    now: virtualNow,
    creators: sandboxCreators().length,
    collaborations: sandboxCollabs().length,
    sent: world?.sent().length ?? 0,
    replies: world?.inbox().length ?? 0,
    pending: world?.pending() ?? 0,
    banner: SANDBOX_BANNER,
  })

  /** 演练红人的邮箱（合成世界里那一个）。 */
  const emailOf = (creator_id: string): string | undefined => {
    const synthetic = creator_id.slice(SANDBOX_ID_PREFIX.length)
    return world?.creator(synthetic)?.email
  }

  return {
    status,

    start({ channel: ch }) {
      if (world !== undefined) return status()
      channel = ch
      world = new KolWorld({ seed, creators: syntheticCreators({ count, seed }) })
      virtualNow = clock.now()
      refToCreator.clear()

      for (const synthetic of world.creators()) {
        const rows = rowsOf(synthetic, ch, virtualNow)
        store.saveCreator(rows.creator)
        store.saveAccount(rows.account)
        /*
         * 联系方式照真路子走：明文进加密库，库里只留 key 名。
         *
         * 演练的地址是 `@example.com`，本来就没什么好保护的——照真路子走
         * 是为了让**开发信那一跳一个字节都不用改**：它去加密库取地址、
         * 取到了才起草，演练与真实在那一段是同一条代码。
         */
        const value_ref = contactSecretId(rows.contact.id)
        secrets.put(value_ref, { [CONTACT_SECRET_FIELD]: synthetic.email })
        store.saveContact({ ...rows.contact, value_ref })
        refToCreator.set(value_ref, rows.creator.id)

        store.saveCollaboration({
          id: `${SANDBOX_ID_PREFIX}col_${synthetic.id}`,
          creator_id: rows.creator.id,
          channel: ch,
          campaign_id: SANDBOX_CAMPAIGN_ID,
          stage: 'sourced',
          currency: 'USD',
          sandbox: true,
        })
      }
      emit('kol.sandbox_started', { channel: ch, creators: count, sandbox: true })
      return status()
    },

    async advance({ days }) {
      const live = world
      if (live === undefined) {
        return { ...status(), advanced_days: 0, received: [] }
      }
      const safeDays = Number.isFinite(days) && days > 0 ? Math.min(Math.round(days), 90) : 1
      virtualNow = new Date(Date.parse(virtualNow) + safeDays * 86_400_000).toISOString()
      const mails = await live.advanceTo(virtualNow)

      const received: KolSandboxAdvanceResult['received'] = []
      for (const mail of mails) {
        const synthetic = live.creator(mail.from)
        if (synthetic === undefined) continue
        const creator_id = `${SANDBOX_ID_PREFIX}${synthetic.id}`
        const collab = sandboxCollabs().find((c) => c.creator_id === creator_id)
        /*
         * 回信落地 = 这条合作**至少**到了「有回音」；退信是另一回事——
         * 地址投不出去，这条合作停在那儿并标成「谢绝了」（不是"有回音"，
         * 没人回过话）。阶段机的合法迁移表在 `kol-core`，这里只走它允许的那两步。
         */
        if (collab !== undefined) {
          const nextStage = mail.bounce_reason === undefined ? 'replied' : 'declined'
          if (collab.stage === 'sourced' || collab.stage === 'contacted') {
            store.saveCollaboration({ ...collab, stage: nextStage })
          }
        }
        received.push({
          creator_id,
          display_name: synthetic.display_name,
          ...(collab === undefined ? {} : { collaboration_id: collab.id }),
          subject: mail.subject,
          body: mail.body,
          at: mail.at,
          ...(mail.bounce_reason === undefined ? {} : { bounce_reason: mail.bounce_reason }),
        })
      }
      emit('kol.sandbox_advanced', {
        days: safeDays,
        now: virtualNow,
        received: received.length,
        sandbox: true,
      })
      return { ...status(), advanced_days: safeDays, received }
    },

    clear() {
      /*
       * 顺序是有讲究的：先删挂在人身上的（账号 / 联系方式 / 合作 / 交付物 / 链接），
       * 最后才删人。反过来的话中间任何一步出错，库里就留下一堆谁也指不到的孤儿行。
       */
      const ids = new Set(sandboxCreators().map((c) => c.id))
      for (const collab of sandboxCollabs()) {
        for (const d of store.deliverables({ collaboration_id: collab.id })) {
          store.removeRow('deliverable', d.id)
        }
        for (const l of store.links(collab.id)) store.removeRow('tracked_link', l.id)
        store.removeRow('collaboration', collab.id)
      }
      for (const id of ids) {
        for (const a of store.accounts({ creator_id: id })) {
          store.removeRow('platform_account', a.id)
        }
        for (const ct of store.contacts(id)) {
          secrets.remove(ct.value_ref)
          store.removeRow('creator_contact', ct.id)
        }
        store.removeRow('creator', id)
      }
      world = undefined
      channel = undefined
      refToCreator.clear()
      virtualNow = clock.now()
      emit('kol.sandbox_cleared', { creators: ids.size, sandbox: true })
      return status()
    },

    intercept({ recipients, subject, body }) {
      const live = world
      if (live === undefined) return undefined
      const hit = recipients.map((ref) => refToCreator.get(ref)).find((id) => id !== undefined)
      if (hit === undefined) return undefined
      const to = emailOf(hit)
      if (to !== undefined) {
        live.send({ to, subject, body, at: virtualNow })
      }
      emit('kol.sandbox_outbound_blocked', { creator_id: hit, channel, sandbox: true })
      return {
        creator_id: hit,
        message: `${SANDBOX_BANNER}：这封信投进了演练收件箱，没有经过任何真渠道。`,
      }
    },
  }
}

/* ── 出站那一跳的接线 ─────────────────────────────────────────────────── */

/** 出站草稿 payload 里我们认得的那几格（别的原样不管）。 */
interface OutboundPayload {
  recipients?: unknown
  subject?: unknown
  body?: unknown
}

/**
 * 一张待发的卡 → 演练判决。
 *
 * 单独抽出来是为了**可测**：`server.ts` 里那一句只是把品牌那一份递进来，
 * 判断全在这里，测试不用起一整个服务进程也能钉住「演练的信投不出去」。
 *
 * 取不到收件人（payload 形状不认识）就**不拦**——这一层只管红人的开发信，
 * 别的出站（客服回信、社媒私信）与它无关。真正的兜底是收件人名单：
 * 只有演练红人那几个 key 名才会命中。
 */
export function kolSandboxIntercept(
  brand: { kolSandbox?: KolSandboxAssembly } | undefined,
  item: { payload?: unknown },
): { status: 'ok'; execution_id: string; outcome_ref: { type: string; id: string } } | undefined {
  const sandbox = brand?.kolSandbox
  if (sandbox === undefined) return undefined
  const payload =
    item.payload !== null && typeof item.payload === 'object'
      ? (item.payload as OutboundPayload)
      : undefined
  if (payload === undefined) return undefined
  const recipients = Array.isArray(payload.recipients)
    ? payload.recipients.filter((r): r is string => typeof r === 'string')
    : []
  if (recipients.length === 0) return undefined
  const verdict = sandbox.intercept({
    recipients,
    subject: typeof payload.subject === 'string' ? payload.subject : '',
    body: typeof payload.body === 'string' ? payload.body : '',
  })
  if (verdict === undefined) return undefined
  /*
   * 回 `ok` 而不是 `failed`：从变更账本的角度这一跳**成功了**——信确实投到了
   * 该去的地方（演练收件箱）。回 failed 会让执行器一直重试一封永远不该真发的信。
   * `outcome_ref` 指向演练红人，人点开就看得见"这封去了哪儿"。
   */
  return {
    status: 'ok',
    execution_id: `ex_sandbox_${verdict.creator_id}`,
    outcome_ref: { type: 'kol_sandbox_mail', id: verdict.creator_id },
  }
}
