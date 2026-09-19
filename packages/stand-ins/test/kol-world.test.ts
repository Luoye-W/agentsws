/**
 * WP117 交付 3：虚拟红人世界。
 *
 * 钉三样：① **确定性**（同 seed 逐字相同）；② **六种性格各自造成的分叉**都真会发生；
 * ③ **绝不连真 SMTP**（发给一个不在合成世界里的地址当场报错）。
 */
import { classifyReply, type ReplyClass } from '@agentsws/kol-core'
import { describe, expect, it } from 'vitest'
import {
  type KolPersona,
  KolWorld,
  kindOfBody,
  offeredPrice,
  personaMix,
  type SyntheticCreator,
  syntheticCreators,
} from '../src/kol-world.js'

const T0 = '2026-09-01T09:00:00.000Z'
const hoursAfter = (h: number): string => new Date(Date.parse(T0) + h * 3_600_000).toISOString()

/** 按性格挑一个人（每种性格在默认那批里都有）。 */
function pick(persona: SyntheticCreator['persona']): SyntheticCreator {
  const found = syntheticCreators().find((c) => c.persona === persona)
  if (found === undefined) throw new Error(`默认那批人里没有 ${persona}`)
  return found
}

const world = (): KolWorld => new KolWorld({ seed: 42 })

const first = (w: KolWorld, c: SyntheticCreator, body = 'Hi, we would love to work with you.') =>
  w.send({ to: c.email, subject: 'Collab with Acme', body, at: T0 })

describe('合成红人（26 §3 确定性）', () => {
  it('同 count 同 seed → 逐字相同的一批人', () => {
    expect(syntheticCreators({ count: 12, seed: 7 })).toEqual(
      syntheticCreators({ count: 12, seed: 7 }),
    )
  })

  it('换 seed 就是另一批人', () => {
    expect(syntheticCreators({ count: 12, seed: 7 })).not.toEqual(
      syntheticCreators({ count: 12, seed: 8 }),
    )
  })

  it('默认几十个，六种性格一个都不少', () => {
    const all = syntheticCreators()
    expect(all.length).toBe(48)
    const mix = personaMix(all)
    for (const [persona, n] of Object.entries(mix)) {
      expect(n, `${persona} 一个都没有，那一条分叉就测不到了`).toBeGreaterThan(0)
    }
  })

  it('地址全在 example 那一族——合成世界里不许出现可能真存在的邮箱', () => {
    for (const c of syntheticCreators({ count: 48 })) {
      expect(c.email, c.email).toMatch(/@(example\.com|invalid\.example)$/)
    }
  })

  it('id 一眼看得出是合成的', () => {
    expect(syntheticCreators({ count: 3 }).map((c) => c.id)).toEqual([
      'syn_kol_001',
      'syn_kol_002',
      'syn_kol_003',
    ])
  })
})

describe('内存邮箱：绝不连真 SMTP', () => {
  it('发给一个不在合成世界里的地址 → 当场报错，不是静默丢掉', () => {
    expect(() =>
      world().send({ to: 'someone@gmail.com', subject: 'hi', body: 'hi', at: T0 }),
    ).toThrow(/只往合成红人发信/)
  })

  it('一键清空之后发件箱、收件箱、在途全空', async () => {
    const w = world()
    first(w, pick('eager'))
    await w.advanceTo(hoursAfter(3))
    expect(w.sent().length).toBe(1)
    expect(w.inbox().length).toBe(1)
    w.reset()
    expect(w.sent()).toEqual([])
    expect(w.inbox()).toEqual([])
    expect(w.pending()).toBe(0)
  })
})

describe('六种性格各自的分叉', () => {
  it('eager：两小时就回，而且是「有兴趣」', async () => {
    const w = world()
    const c = pick('eager')
    first(w, c)
    expect(await w.advanceTo(hoursAfter(1))).toEqual([])
    const got = await w.advanceTo(hoursAfter(3))
    expect(got.length).toBe(1)
    expect(kindOfBody(got[0]?.body ?? '')).toBe('interested')
    expect(got[0]?.thread_id).toBe(`syn_thread_${c.id}`)
  })

  it('slow：96 小时才回；3 天的跟进信先发出去，回信仍并到同一条线程', async () => {
    const w = world()
    const c = pick('slow')
    const a = first(w, c)
    // 第 3 天没回音 → 跟进一封
    const b = w.send({
      to: c.email,
      subject: 'Re: Collab with Acme',
      body: 'Just following up.',
      at: hoursAfter(72),
    })
    expect(await w.advanceTo(hoursAfter(73))).toEqual([])
    const got = await w.advanceTo(hoursAfter(97))
    // 只回一封（催了两遍不等于回两封）
    expect(got.length).toBe(1)
    expect(got[0]?.thread_id).toBe(a.thread_id)
    expect(b.thread_id).toBe(a.thread_id)
  })

  it('ghost：发多少封都不回，在途永远是 0', async () => {
    const w = world()
    const c = pick('ghost')
    for (const h of [0, 72, 168]) {
      w.send({ to: c.email, subject: 's', body: 'b', at: hoursAfter(h) })
    }
    expect(w.pending()).toBe(0)
    expect(await w.advanceTo(hoursAfter(400))).toEqual([])
  })

  it('bouncer：一分钟后退信，带投递失败的原因', async () => {
    const w = world()
    const c = pick('bouncer')
    expect(c.email).toMatch(/@invalid\.example$/)
    first(w, c)
    const got = await w.advanceTo(hoursAfter(1))
    expect(got.length).toBe(1)
    expect(got[0]?.bounce_reason).toBe('550 5.1.1 unknown recipient')
    expect(kindOfBody(got[0]?.body ?? '')).toBe('bounce')
  })

  it('sampler：先要样品；我们确认寄样之后才把地址给出来', async () => {
    const w = world()
    const c = pick('sampler')
    first(w, c)
    const ask = await w.advanceTo(hoursAfter(21))
    expect(kindOfBody(ask[0]?.body ?? '')).toBe('wants_sample')

    w.send({
      to: c.email,
      subject: 'Re',
      body: 'Happy to ship a sample — where to?',
      at: hoursAfter(22),
    })
    const addr = await w.advanceTo(hoursAfter(60))
    expect(addr.length).toBe(1)
    expect(addr[0]?.body).toContain('12 Example Street')
  })
})

describe('haggler：议价的三个回合', () => {
  const c = pick('haggler')

  it('第一封就开价，要我们报数', async () => {
    const w = world()
    first(w, c)
    const got = await w.advanceTo(hoursAfter(9))
    expect(kindOfBody(got[0]?.body ?? '')).toBe('wants_quote')
    expect(got[0]?.body).toContain(`US$${c.asking_price ?? 900}`)
  })

  it('报到要价的八成以上 → 答应', async () => {
    const w = world()
    first(w, c)
    await w.advanceTo(hoursAfter(9))
    const asking = c.asking_price ?? 900
    w.send({ to: c.email, subject: 'Re', body: `We can do US$${asking} flat.`, at: hoursAfter(10) })
    const got = await w.advanceTo(hoursAfter(20))
    expect(kindOfBody(got[0]?.body ?? '')).toBe('interested')
  })

  it('压两回合价 → 翻脸退订；退订之后一封都不再回', async () => {
    const w = world()
    first(w, c)
    await w.advanceTo(hoursAfter(9))
    w.send({ to: c.email, subject: 'Re', body: 'Our budget is US$100.', at: hoursAfter(10) })
    const round1 = await w.advanceTo(hoursAfter(20))
    expect(round1[0]?.body).toContain('below my rate card')
    expect(w.optedOut(c.id)).toBe(false)

    w.send({ to: c.email, subject: 'Re', body: 'Best we can do is US$120.', at: hoursAfter(21) })
    const round2 = await w.advanceTo(hoursAfter(40))
    expect(kindOfBody(round2[0]?.body ?? '')).toBe('declined')
    expect(w.optedOut(c.id)).toBe(true)

    // 退订之后：还在发 = 那边的 bug，这个世界不再出声
    w.send({ to: c.email, subject: 'Re', body: 'US$1200?', at: hoursAfter(41) })
    expect(w.pending()).toBe(0)
    expect(await w.advanceTo(hoursAfter(200))).toEqual([])
  })
})

describe('确定性：同一串动作跑两遍，字节一样', () => {
  it('两个世界、同 seed、同样的发信 → 收件箱逐字相同', async () => {
    const run = async (): Promise<unknown> => {
      const w = world()
      for (const persona of ['eager', 'slow', 'haggler', 'sampler', 'bouncer', 'ghost'] as const) {
        const c = pick(persona)
        w.send({ to: c.email, subject: 'Collab', body: 'Hi there, US$700?', at: T0 })
      }
      const a = await w.advanceTo(hoursAfter(12))
      const b = await w.advanceTo(hoursAfter(200))
      return [a, b]
    }
    expect(await run()).toEqual(await run())
  })

  it('同一时刻到点的几封，投递顺序稳定（按红人 id）', async () => {
    const w = world()
    for (const c of syntheticCreators({ count: 16 }).filter((x) => x.persona === 'eager')) {
      w.send({ to: c.email, subject: 'Collab', body: 'hi', at: T0 })
    }
    const got = await w.advanceTo(hoursAfter(5))
    // 线程 id 里带着红人 id：投递顺序必须是按它排好的那一份，不是 Map 的插入顺序
    const threads = got.map((m) => m.thread_id)
    expect(threads.length).toBeGreaterThan(1)
    expect(threads).toEqual([...threads].sort())
  })
})

describe('报价解析', () => {
  it.each([
    ['We can do US$450 for this', 450],
    ['budget is $1200 total', 1200],
    ['USD 900 flat', 900],
    ['no numbers here', undefined],
  ])('%s → %s', (body, want) => {
    expect(offeredPrice(body)).toBe(want)
  })
})

describe('润色（模型便宜档）是可选的一层', () => {
  it('开了只改措辞，回不回、回什么意向不变', async () => {
    const w = new KolWorld({
      seed: 42,
      polish: async ({ body, kind }) => `[${kind}] ${body}`,
    })
    const c = pick('eager')
    first(w, c)
    const got = await w.advanceTo(hoursAfter(3))
    expect(got.length).toBe(1)
    expect(got[0]?.body.startsWith('[interested] ')).toBe(true)
  })
})

/**
 * **parity**：合成世界写出来的回信，必须能被真链路上的分类器
 * （`kol-core` 的 `classifyReply`）分对。两边对不上的话，长场景里
 * 「回信 → 意向分类 → 议价」测的就不是真东西。
 */
describe('与 classifyReply 对齐', () => {
  const cases: [KolPersona, ReplyClass][] = [
    ['eager', 'interested'],
    ['slow', 'interested'],
    ['haggler', 'wants_quote'],
    ['sampler', 'interested'],
  ]

  it.each(cases)('%s 的第一封回信 → classifyReply 判成 %s', async (persona, want) => {
    const w = world()
    const c = pick(persona)
    first(w, c)
    const got = await w.advanceTo(hoursAfter(200))
    expect(got.length).toBe(1)
    expect(classifyReply({ text: got[0]?.body ?? '', known_contact: true }).klass).toBe(want)
  })

  it('haggler 被压两回合之后那一封 → declined，而且 opt_out 为真', async () => {
    const w = world()
    const c = pick('haggler')
    first(w, c)
    await w.advanceTo(hoursAfter(9))
    w.send({ to: c.email, subject: 'Re', body: 'Our budget is US$100.', at: hoursAfter(10) })
    await w.advanceTo(hoursAfter(20))
    w.send({ to: c.email, subject: 'Re', body: 'Best we can do is US$120.', at: hoursAfter(21) })
    const got = await w.advanceTo(hoursAfter(40))
    const hit = classifyReply({ text: got[0]?.body ?? '', known_contact: true })
    expect(hit.klass).toBe('declined')
    expect(hit.opt_out).toBe(true)
  })
})
