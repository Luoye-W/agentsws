/**
 * WP117 交付 3：**虚拟红人世界**。
 *
 * 一批合成红人，各有性格；给他们发开发信，他们按性格回信。用途有两处：
 *
 * 1. **模拟回路**：红人那条长场景需要对面真的会回信，不然「回信归并 → 意向分类 →
 *    议价」这几步在接口级永远测不到（66 断点 #11 就是这么来的）；
 * 2. **演练模式**（交付 4）：内测用户在界面上点「演练」，跟的就是这批人。
 *
 * 三条纪律：
 *
 * - **邮件全在内存里**。这个文件里没有 `net`、没有 `fetch`、没有 SMTP / IMAP 客户端。
 *   演练模式那一侧另有一道硬闸（真发送路径在演练活动里被拦），这里是第一道：
 *   连不上真邮箱的代码，拦都不用拦。
 * - **回信由规则 + 种子决定**。同 seed 同一封信 → 逐字相同的回复，回放才是恒等变换。
 *   润色（走模型便宜档）是可选的一层，默认关；开了也只改措辞，不改「回不回、回什么意向」。
 * - **地址一律 `@example.com` 那一族**。合成世界里不许出现一个可能真存在的邮箱。
 */
import type { Iso8601, KolChannel } from '@agentsws/contracts'
import { StandInError } from './errors.js'

/**
 * 六种性格。选这六种不是凑数——它们对应建联漏斗上真正会分叉的六个地方：
 *
 * | 性格 | 在链上造成什么 |
 * |---|---|
 * | `eager` | 秒回、直接答应 → 最短的一条成功路径 |
 * | `slow` | 拖几天才回 → 跟进节奏（3 / 7 天）会先发出去，回信要能并到同一条线程 |
 * | `haggler` | 只谈钱 → 议价卡（money 排版），超预算要人批；被压价压到第二回合就翻脸退订 |
 * | `sampler` | 先要样品 → 要地址、建寄样任务 |
 * | `bouncer` | 退信 → 地址无效，合作该停在那儿并把人标出来 |
 * | `ghost` | 已读不回 → 跟进上限用满之后不再发（不许无限骚扰） |
 */
export type KolPersona = 'eager' | 'slow' | 'haggler' | 'sampler' | 'bouncer' | 'ghost'

export interface SyntheticCreator {
  id: string
  display_name: string
  channel: KolChannel
  handle: string
  email: string
  followers: number
  engagement_rate: number
  category: string
  language: string
  region: string
  persona: KolPersona
  /** 这个人收到第一封信之后**几小时**回（`ghost` / `bouncer` 没有这一格）。 */
  reply_after_hours?: number
  /** `haggler` 要的价（美元）。 */
  asking_price?: number
}

/** 性格 → 回信延迟（小时）与要价。`undefined` = 不回。 */
const BEHAVIOR: Readonly<
  Record<KolPersona, { hours?: number; price?: number; opt_out?: boolean }>
> = {
  eager: { hours: 2 },
  slow: { hours: 96 },
  haggler: { hours: 8, price: 900 },
  sampler: { hours: 20 },
  bouncer: {},
  ghost: {},
}

const CHANNELS: readonly KolChannel[] = ['youtube', 'instagram', 'tiktok', 'facebook', 'x']

const CATEGORIES = ['数码', '桌面好物', '户外', '家居', '健身', '摄影'] as const
const REGIONS = ['US', 'GB', 'DE', 'CA', 'AU', 'SG'] as const

/** 六种性格按这个比例铺开：多数人是不回的，这才像真的建联漏斗。 */
const MIX: readonly KolPersona[] = [
  'ghost',
  'ghost',
  'slow',
  'eager',
  'haggler',
  'sampler',
  'ghost',
  'bouncer',
]

/** 名字池（合成的，不对应任何真人）。 */
const FIRST = [
  'Gadget',
  'Desk',
  'Trail',
  'Studio',
  'Urban',
  'Quiet',
  'Bright',
  'Copper',
  'Nomad',
  'Orbit',
] as const
const LAST = [
  'Jonas',
  'Rosa',
  'Miko',
  'Alva',
  'Pike',
  'Noor',
  'Reed',
  'Vale',
  'Suri',
  'Kaya',
] as const

/**
 * 造一批合成红人。
 *
 * 同 `count` 同 `seed` → 逐字相同的一批人（26 §3）。id 形如 `syn_kol_001`，
 * 一眼看得出是合成的——真库里的人不会长这样。
 */
export function syntheticCreators(
  input: { count?: number; seed?: number } = {},
): SyntheticCreator[] {
  const count = input.count ?? 48
  const seed = input.seed ?? 42
  const out: SyntheticCreator[] = []
  for (let i = 0; i < count; i += 1) {
    const n = i + seed
    const first = FIRST[i % FIRST.length] ?? 'Gadget'
    const last = LAST[(i * 3 + seed) % LAST.length] ?? 'Jonas'
    const persona = MIX[i % MIX.length] ?? 'ghost'
    const behavior = BEHAVIOR[persona]
    /*
     * 序号是 handle 的一部分，**不是装饰**：名字池只有 10 × 10，第 11 个人的
     * 「名 + 姓」必然与第 1 个人撞上，而邮箱是这个世界里认人的主键——
     * 撞了就会出现「发给 A 的信被 B 收走」。序号让它永不重复。
     */
    const ord = String(i + 1).padStart(3, '0')
    const handle = `${first}${last}${ord}`.toLowerCase()
    out.push({
      id: `syn_kol_${ord}`,
      display_name: `${first} ${last} ${ord}`,
      channel: CHANNELS[(i + seed) % CHANNELS.length] ?? 'youtube',
      handle,
      // 合成世界里的地址只有这一族；`bouncer` 用一个明摆着投不出去的域
      email: persona === 'bouncer' ? `${handle}@invalid.example` : `${handle}@example.com`,
      followers: 8_000 + ((n * 7_919) % 420_000),
      engagement_rate: Math.round((0.01 + ((n * 37) % 90) / 1000) * 1000) / 1000,
      category: CATEGORIES[(i + seed) % CATEGORIES.length] ?? '数码',
      language: 'en',
      region: REGIONS[(i * 5 + seed) % REGIONS.length] ?? 'US',
      persona,
      ...(behavior.hours === undefined ? {} : { reply_after_hours: behavior.hours }),
      ...(behavior.price === undefined ? {} : { asking_price: behavior.price }),
    })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 内存邮箱
 * ------------------------------------------------------------------ */

/** 一封信（进出都是这个形状）。 */
export interface SyntheticMail {
  id: string
  thread_id: string
  direction: 'out' | 'in'
  from: string
  to: string
  subject: string
  body: string
  at: Iso8601
  /** 退信那一封上带着（投递失败的原因）。 */
  bounce_reason?: string
}

/**
 * 回信落在哪一类——**与 `kol-core` 的 `classifyReply` 用同一套词**。
 *
 * 这里不 import 那个分类器（合成世界不该知道我们怎么分类），而是让正文里**必带
 * 它认得的词**。两边对不上的话，模拟回路测的就不是真链路了——所以这一条由
 * `test/kol-world.test.ts` 末尾那一组 parity 测试逐个性格钉住。
 */
export type SyntheticReplyKind =
  | 'interested'
  | 'wants_quote'
  | 'wants_sample'
  | 'declined'
  | 'bounce'

/** 一条线程现在走到哪（决定下一封回什么）。 */
interface ThreadState {
  creator_id: string
  /** 我们发出去几封了。 */
  sent: number
  /** 他回了几封。 */
  replied: number
  /** 明说过「别再发了」。 */
  opt_out: boolean
  /** `haggler` 已经被压过几次价。 */
  haggles: number
  /** 排队等着投的回信（到点才能取）。 */
  queue: { due_ms: number; mail: SyntheticMail }[]
}

export interface KolWorldOptions {
  /** 这批人；不给就按 `syntheticCreators()` 造一批。 */
  creators?: readonly SyntheticCreator[]
  seed?: number
  /** 我们这一侧的发件地址（合成世界里也必须是 example 域）。 */
  from?: string
  /**
   * 可选的润色（走模型便宜档）。**只改措辞**：回不回、回什么意向由规则定死，
   * 润色拿到的是已经定好类的正文。默认不开——开了就不是字节稳定的了，
   * 模拟回路里永远别开。
   */
  polish?: (input: { body: string; kind: SyntheticReplyKind }) => Promise<string>
}

/** 我们发出去的一封信里有没有报一个价（议价回合用）。 */
export function offeredPrice(body: string): number | undefined {
  const m = body.match(/(?:US\$|\$|USD\s?)\s?(\d{2,6})/i)
  const n = m?.[1] === undefined ? Number.NaN : Number.parseInt(m[1], 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * 合成红人世界：**一个内存邮箱 + 一台按性格回信的状态机**。
 *
 * 用法就三个动作：`send` 发一封 → `advanceTo(now)` 把到点的回信取出来 → 重复。
 * 时间由调用方给（演练模式的「跳到 3 天后」与模拟回路的合成时钟都是这么推的），
 * 这个类里**没有 `Date.now()`**。
 */
export class KolWorld {
  private readonly byEmail = new Map<string, SyntheticCreator>()
  private readonly byId = new Map<string, SyntheticCreator>()
  private readonly threads = new Map<string, ThreadState>()
  private readonly outbox: SyntheticMail[] = []
  private readonly delivered: SyntheticMail[] = []
  private readonly from: string
  private readonly polish: KolWorldOptions['polish']
  private counter = 0

  constructor(options: KolWorldOptions = {}) {
    const creators = options.creators ?? syntheticCreators({ seed: options.seed ?? 42 })
    for (const c of creators) {
      this.byEmail.set(c.email.toLowerCase(), c)
      this.byId.set(c.id, c)
    }
    this.from = options.from ?? 'brand@sandbox.example.com'
    this.polish = options.polish
  }

  creators(): SyntheticCreator[] {
    return [...this.byId.values()]
  }

  creator(idOrEmail: string): SyntheticCreator | undefined {
    return this.byId.get(idOrEmail) ?? this.byEmail.get(idOrEmail.toLowerCase())
  }

  /** 发出去的全部（演练界面上「我们发了什么」那一栏）。 */
  sent(): SyntheticMail[] {
    return [...this.outbox]
  }

  /** 已经投进来的全部回信。 */
  inbox(): SyntheticMail[] {
    return [...this.delivered]
  }

  /**
   * 给一个合成红人发一封信。
   *
   * 回的是这封信本身（带 `thread_id`——归并靠它）。**地址不在这批人里就报错**：
   * 合成世界不许把信发给一个它不认识的地址，那是通往真 SMTP 的口子。
   */
  send(input: { to: string; subject: string; body: string; at: Iso8601 }): SyntheticMail {
    const creator = this.byEmail.get(input.to.toLowerCase())
    if (creator === undefined) {
      throw new StandInError(
        'invalid_input',
        `演练世界里没有 ${input.to} 这个地址——合成世界只往合成红人发信。`,
        { to: input.to },
      )
    }
    const thread_id = `syn_thread_${creator.id}`
    const state = this.threadOf(thread_id, creator.id)
    const mail: SyntheticMail = {
      id: this.nextId('out'),
      thread_id,
      direction: 'out',
      from: this.from,
      to: creator.email,
      subject: input.subject,
      body: input.body,
      at: input.at,
    }
    this.outbox.push(mail)
    state.sent += 1
    this.scheduleReply(creator, state, mail)
    return mail
  }

  /**
   * 推进到 `now`：把到点的回信投进来并返回。
   *
   * 没到点的留在队列里。同一批信按 `due_ms` 排序投，时刻相同时按入队顺序——
   * 两次跑出来的顺序必须一样，不然基线会抖。
   */
  async advanceTo(now: Iso8601): Promise<SyntheticMail[]> {
    const nowMs = Date.parse(now)
    if (!Number.isFinite(nowMs)) {
      throw new StandInError('invalid_input', `不是 ISO-8601 时刻：${now}`)
    }
    const out: SyntheticMail[] = []
    for (const state of [...this.threads.values()].sort((a, b) =>
      a.creator_id.localeCompare(b.creator_id),
    )) {
      const due = state.queue.filter((q) => q.due_ms <= nowMs)
      if (due.length === 0) continue
      state.queue = state.queue.filter((q) => q.due_ms > nowMs)
      for (const q of due.sort((a, b) => a.due_ms - b.due_ms)) {
        state.replied += 1
        out.push(q.mail)
      }
    }
    if (this.polish !== undefined) {
      for (const mail of out) {
        mail.body = await this.polish({ body: mail.body, kind: kindOfBody(mail.body) })
      }
    }
    this.delivered.push(...out)
    return out
  }

  /** 还有几封在路上（演练界面上的「等回信」）。 */
  pending(): number {
    let n = 0
    for (const s of this.threads.values()) n += s.queue.length
    return n
  }

  /** 这个人明说过别再发了吗（跟进节奏要看这一格）。 */
  optedOut(creator_id: string): boolean {
    return this.threads.get(`syn_thread_${creator_id}`)?.opt_out === true
  }

  /** 一键清空（演练数据清空那条路）。 */
  reset(): void {
    this.threads.clear()
    this.outbox.length = 0
    this.delivered.length = 0
    this.counter = 0
  }

  private threadOf(thread_id: string, creator_id: string): ThreadState {
    const found = this.threads.get(thread_id)
    if (found !== undefined) return found
    const fresh: ThreadState = {
      creator_id,
      sent: 0,
      replied: 0,
      opt_out: false,
      haggles: 0,
      queue: [],
    }
    this.threads.set(thread_id, fresh)
    return fresh
  }

  private nextId(prefix: string): string {
    this.counter += 1
    return `syn_${prefix}_${String(this.counter).padStart(4, '0')}`
  }

  /**
   * 按性格排一封回信。
   *
   * 四条规则，顺序就是优先级：
   *
   * 1. **退订之后一封都不回**——他说过别再发了，世界就不再出声（跟进节奏那边
   *    要是还在发，是那边的 bug，这里不替它兜）。
   * 2. **退信立刻回**（一分钟后），不等 `reply_after_hours`：投递失败是传输层的事。
   * 3. **`ghost` 什么都不排**。
   * 4. 其余按 `reply_after_hours` 排；议价回合看我们这封信里报没报价。
   */
  private scheduleReply(
    creator: SyntheticCreator,
    state: ThreadState,
    outbound: SyntheticMail,
  ): void {
    if (state.opt_out) return
    const atMs = Date.parse(outbound.at)
    if (creator.persona === 'bouncer') {
      state.queue.push({
        due_ms: atMs + 60_000,
        mail: this.mailFrom(creator, outbound, {
          subject: `Undelivered: ${outbound.subject}`,
          body: `Delivery to the following recipient failed permanently: ${creator.email}. The domain does not accept mail (550 5.1.1 unknown recipient).`,
          bounce_reason: '550 5.1.1 unknown recipient',
        }),
      })
      return
    }
    if (creator.persona === 'ghost') return

    const hours = creator.reply_after_hours ?? 24
    const draft = this.bodyFor(creator, state, outbound)
    if (draft === undefined) return
    if (draft.opt_out) state.opt_out = true
    state.queue.push({
      due_ms: atMs + hours * 3_600_000,
      mail: this.mailFrom(creator, outbound, {
        subject: `Re: ${outbound.subject}`,
        body: draft.body,
      }),
    })
  }

  private mailFrom(
    creator: SyntheticCreator,
    outbound: SyntheticMail,
    parts: { subject: string; body: string; bounce_reason?: string },
  ): SyntheticMail {
    return {
      id: this.nextId('in'),
      thread_id: outbound.thread_id,
      direction: 'in',
      from: creator.email,
      to: this.from,
      subject: parts.subject,
      body: parts.body,
      at: outbound.at,
      ...(parts.bounce_reason === undefined ? {} : { bounce_reason: parts.bounce_reason }),
    }
  }

  /**
   * 这一封该回什么（状态机，正文里必带 `classifyReply` 认得的词）。
   *
   * `undefined` = 这一封不回。三种情况会不回：
   *
   * 1. **队列里已经有一封在路上**——他不会因为我们催了两遍就回两遍；
   * 2. **除 `haggler` 外的人只主动回一次**。这一条是「跟进节奏」那一步的关键：
   *    `slow`（96 小时）的回信是**第一封**排下来的，3 天的跟进信先一步发出去，
   *    于是回信到的时候线程里已经有两封出站——归并要是错了，这里当场露馅。
   * 3. 回过之后，只有我们说了**新东西**（报了个价、确认寄样）才会再开口。
   */
  private bodyFor(
    creator: SyntheticCreator,
    state: ThreadState,
    outbound: SyntheticMail,
  ): { body: string; opt_out?: boolean } | undefined {
    const name = creator.display_name.split(' ')[0] ?? 'there'
    const offer = offeredPrice(outbound.body)
    // 已经有一封在路上：不管我们又发了什么，他不会同时回两封
    if (state.queue.length > 0) return undefined

    if (creator.persona === 'haggler') {
      const asking = creator.asking_price ?? 900
      // 第一封：只谈钱，直接开价
      if (state.sent === 1) {
        return {
          body: `Hi, thanks for reaching out. Before anything else — how much is the budget? My rates start at US$${asking} for a dedicated video. Send over your pricing and I will take a look.`,
        }
      }
      // 之后每一封都看我们报了多少
      if (offer === undefined) {
        return {
          body: `Still waiting on a number. I cannot plan anything without pricing — what is your budget for this?`,
        }
      }
      if (offer >= Math.round(asking * 0.8)) {
        return {
          body: `US$${offer} works for me. I am interested — send the brief and the product details and we can lock a date.`,
        }
      }
      state.haggles += 1
      if (state.haggles >= 2) {
        return {
          body: `US$${offer} is still far below my rate card. This is not a fit — please do not contact me again about this campaign.`,
          opt_out: true,
        }
      }
      return {
        body: `US$${offer} is below my rate card. My rates are US$${asking}; I can do US$${Math.round(asking * 0.9)} if you cover shipping. How much can you move?`,
      }
    }

    /*
     * 回过之后的第二轮：只有我们说了新东西他才再开口。
     *
     * - 报了个价 → 答应（`interested`，议价那一步在界面上才走得完）；
     * - 确认寄样 → `sampler` 把收件地址给出来（寄样任务要地址，见交付 4 的长场景）。
     */
    if (state.replied > 0 || state.sent > 1) {
      if (offer !== undefined) {
        return {
          body: `US$${offer} sounds good — I am interested. Send the brief and I will book it in.`,
        }
      }
      if (creator.persona === 'sampler' && /sample|ship|寄样/i.test(outbound.body)) {
        return {
          body: `Great — ship it to ${creator.display_name}, 12 Example Street, ${creator.region}. Once it lands I will tell you more about what I can put together.`,
        }
      }
      return undefined
    }

    switch (creator.persona) {
      case 'eager':
        return {
          body: 'Hi — yes, I am interested! Tell me more about the product and when you would want this to go live. Happy to chat this week.',
        }
      case 'slow':
        return {
          body: 'Hey, sorry for the slow reply — inbox got away from me. I am interested in principle. What is the timeline you had in mind?',
        }
      case 'sampler':
        return {
          body: `Hi, ${name} here. Sounds good — but I would love to try the product before I commit to anything. Can you ship a sample? I will send my shipping address once you confirm.`,
        }
      default:
        return undefined
    }
  }
}

/** 一封合成回信的类（`advanceTo` 里给润色钩子用，也是测试的锚点）。 */
export function kindOfBody(body: string): SyntheticReplyKind {
  const lower = body.toLowerCase()
  if (lower.includes('undelivered') || lower.includes('failed permanently')) return 'bounce'
  if (lower.includes('do not contact') || lower.includes('not a fit')) return 'declined'
  if (lower.includes('ship a sample') || lower.includes('shipping address')) return 'wants_sample'
  if (lower.includes('my rates') || lower.includes('how much')) return 'wants_quote'
  return 'interested'
}

/**
 * 这批人按性格分了几个（演练页顶上那一行统计，也是场景里的不变量）。
 */
export function personaMix(creators: readonly SyntheticCreator[]): Record<KolPersona, number> {
  const out: Record<KolPersona, number> = {
    eager: 0,
    slow: 0,
    haggler: 0,
    sampler: 0,
    bouncer: 0,
    ghost: 0,
  }
  for (const c of creators) out[c.persona] += 1
  return out
}
