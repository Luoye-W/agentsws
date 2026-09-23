import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrandDesignProfile } from '@agentsws/contracts'
import { DEFAULT_BRAND_DESIGN_CAP_CREDITS, DESIGN_MD_SECTIONS } from '@agentsws/contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  CREDITS_PER_COMPOSE,
  composeDesignProse,
  composePrompt,
  estimateComposeCredits,
  sectionEvidence,
} from '../src/compose.js'
import {
  NOT_FOUND_ZH,
  parseDesignMd,
  profileFromTokens,
  serializeDesignMd,
  tokensOf,
} from '../src/serialize.js'
import { extractSiteDesign } from '../src/site-design.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): string => readFileSync(join(HERE, 'fixtures', name), 'utf8')

function heritage(): BrandDesignProfile {
  return extractSiteDesign([
    {
      url: 'https://heritage.test/',
      kind: 'home',
      html: fixture('shopify-home.html'),
      sheets: [
        {
          url: 'https://cdn.shopify.com/s/files/1/0001/theme.css',
          css: fixture('shopify-theme.css'),
        },
      ],
    },
  ])
}

/** 一个只会回声的模型替身。**测试一个字节都不出这台机器。** */
const echoModel = vi.fn(async (req: { prompt: string }) => ({
  text: DESIGN_MD_SECTIONS.map(
    (s) => `## ${s}\n这一节由替身写的（提示词 ${String(req.prompt.length)} 字）。`,
  ).join('\n\n'),
  credits: CREDITS_PER_COMPOSE,
}))

describe('序列化：写出去的是**纯规范**，我们的私货留在界面（71 §3）', () => {
  it('front matter 里没有 source / confidence / conflict 这三格', () => {
    const md = serializeDesignMd(heritage(), {})
    const front = md.slice(0, md.indexOf('---', 4))
    expect(front).not.toContain('source')
    expect(front).not.toContain('confidence')
    expect(front).not.toContain('conflict')
    expect(front).toContain('colors:')
  })

  it('八节全写出来，顺序照规范；没内容的写「未找到，请补充」而不是省掉', () => {
    const md = serializeDesignMd({}, {})
    const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1])
    expect(headings).toEqual([...DESIGN_MD_SECTIONS])
    expect(md).toContain(NOT_FOUND_ZH)
  })

  it('省掉的节进 `omitted` —— 规范的 linter 认这个，用户也能一眼看见缺哪儿', () => {
    const parsed = parseDesignMd(serializeDesignMd({}, {}))
    const sections = (parsed.tokens.omitted ?? []).map((o) =>
      typeof o === 'string' ? o : o.section,
    )
    expect(sections).toContain('colors')
    expect(sections).toContain('typography')
    // 每一条都带一句原因，不是光一个节名
    for (const o of parsed.tokens.omitted ?? [])
      expect(typeof o === 'string' ? '' : o.reason).not.toBe('')
  })

  it('写出去再读回来，令牌一个不少', () => {
    const profile = heritage()
    const parsed = parseDesignMd(serializeDesignMd(profile, { Colors: '砖红是唯一的强调色。' }))
    expect(parsed.tokens.colors).toEqual(tokensOf(profile).colors)
    expect(parsed.prose.Colors).toBe('砖红是唯一的强调色。')
  })

  it('规范不认识的小节**保留，不报错**（规范自己就是这么规定的）', () => {
    const parsed = parseDesignMd('---\nname: X\n---\n\n## Iconography\n用线性图标。\n')
    expect(parsed.extraSections).toEqual([{ heading: 'Iconography', body: '用线性图标。' }])
  })

  it('front matter 写坏了不让整份文件报废：正文照读，并说一句人话', () => {
    const parsed = parseDesignMd('---\ncolors: [oops\n---\n\n## Colors\n还是能读到这一段。\n')
    expect(parsed.failure).toContain('读不动')
    expect(parsed.prose.Colors).toBe('还是能读到这一段。')
  })

  it('用户粘一份进来：每格标 `edited`，重抓时整格不动', () => {
    const profile = profileFromTokens({ colors: { primary: '#ff0000' } })
    expect(profile.colors?.primary?.edited).toBe(true)
    expect(profile.colors?.primary?.confidence).toBe('high')
    expect(profile.colors?.primary?.source[0]?.origin).toBe('manual')
  })
})

describe('成文：只根据证据写（71 §3 第 3 条）', () => {
  it('证据不够的小节**根本不进提示词** —— 模型没机会替它编', () => {
    const prompt = composePrompt(heritage(), ['Colors', 'Typography'])
    expect(prompt).toContain('## Colors')
    expect(prompt).not.toContain('## Elevation & Depth')
    expect(prompt).toContain('不许')
  })

  it('一份空档案：一个小节都没有证据，八节全留白', () => {
    for (const s of DESIGN_MD_SECTIONS) expect(sectionEvidence({}, s)).toBeUndefined()
  })

  it("Do's and Don'ts 不凭空产生 —— 它是从别的节推出来的", () => {
    expect(sectionEvidence({}, "Do's and Don'ts")).toBeUndefined()
    expect(sectionEvidence(heritage(), "Do's and Don'ts")).toContain('色板共')
  })

  it('颜色那一节的证据里带着出处，模型写的每句话都对得上一个来源', () => {
    expect(sectionEvidence(heritage(), 'Colors')).toContain('出处：')
  })
})

describe('成文：钱（71 §3 第 3 条 / 契约的封顶）', () => {
  it('一次成文**只发一次模型请求**（八节一起写，不是一节一个）', async () => {
    echoModel.mockClear()
    await composeDesignProse({ profile: heritage(), model: echoModel })
    expect(echoModel).toHaveBeenCalledTimes(1)
  })

  it('开跑前报得出预估，且不超封顶', async () => {
    const estimate = estimateComposeCredits({ profile: heritage() })
    expect(estimate).toBe(CREDITS_PER_COMPOSE)
    expect(estimate).toBeLessThanOrEqual(DEFAULT_BRAND_DESIGN_CAP_CREDITS)
  })

  it('封顶是 0 的时候不发请求，**但已经有的照样交**（退回直述文本）', async () => {
    echoModel.mockClear()
    const result = await composeDesignProse({
      profile: heritage(),
      model: echoModel,
      capCredits: 0,
    })
    expect(echoModel).not.toHaveBeenCalled()
    expect(result.stopped_for_budget).toBe(true)
    expect(result.budget.spent_credits).toBe(0)
    // 交出来的仍然是一份完整的 DESIGN.md
    expect(result.markdown).toContain('## Colors')
    expect(result.prose.Colors).toContain('#b8422e')
  })

  it('接不上模型也不空手：正文按令牌直述，每句话都对得上一个真值', async () => {
    const result = await composeDesignProse({ profile: heritage() })
    expect(result.fallback_reason).toContain('没接上模型')
    expect(result.prose.Typography).toContain('Public Sans')
  })

  it('模型抛了 / 回的东西读不出小节 —— 都退回直述，不把一段垃圾写进规范', async () => {
    const angry = vi.fn(async () => {
      throw new Error('502')
    })
    const mumble = vi.fn(async () => ({ text: '嗯……我觉得这个品牌挺好的。' }))
    const a = await composeDesignProse({ profile: heritage(), model: angry })
    expect(a.fallback_reason).toContain('502')
    expect(a.prose.Colors).toContain('#b8422e')
    const b = await composeDesignProse({ profile: heritage(), model: mumble })
    expect(b.fallback_reason).toContain('读不出小节')
  })

  it('抓不到的那几节如实列在 `missing` 里', async () => {
    const result = await composeDesignProse({ profile: {}, model: echoModel })
    expect(result.missing).toEqual([...DESIGN_MD_SECTIONS])
    expect(result.budget.spent_credits).toBe(0)
  })

  it('模型写的正文落进最终的 markdown 里', async () => {
    const result = await composeDesignProse({ profile: heritage(), model: echoModel })
    expect(result.markdown).toContain('这一节由替身写的')
    expect(result.budget.spent_credits).toBe(CREDITS_PER_COMPOSE)
  })

  it('没有视觉口子时，图片风格那一格**空着** —— 不假装看过截图', async () => {
    const result = await composeDesignProse({
      profile: heritage(),
      model: echoModel,
      images: [new Uint8Array([1])],
    })
    // 给了图但没给看图的口子：那几张图原样躺着，证据里一个字都不多
    expect(composePrompt(heritage(), ['Overview'])).not.toContain('图片风格')
    expect(result.budget.spent_credits).toBe(CREDITS_PER_COMPOSE)
  })

  it('有视觉口子时，看图的结果进证据，且计钱', async () => {
    const vision = vi.fn(async () => ({ text: '暖调产品摄影，实景，构图居中。', credits: 0.1 }))
    const result = await composeDesignProse({
      profile: heritage(),
      model: echoModel,
      vision,
      images: [new Uint8Array([1])],
    })
    expect(vision).toHaveBeenCalledTimes(1)
    expect(result.budget.spent_credits).toBeCloseTo(0.1 + CREDITS_PER_COMPOSE, 5)
    // 看到的那句话进了送给成文模型的证据
    expect(echoModel.mock.calls.at(-1)?.[0]?.prompt).toContain('暖调产品摄影')
    expect(result.vision_note).toBeUndefined()
  })

  it('WP127：模型看不了图——不再悄悄跳过，明说「当前模型看不了图」', async () => {
    const vision = vi.fn(async () => {
      throw new Error(
        '当前模型看不了图。Agents 工坊要求文字模型能看图——去设置 → 模型，换一个能看图的模型。',
      )
    })
    const result = await composeDesignProse({
      profile: heritage(),
      model: echoModel,
      vision,
      images: [new Uint8Array([1]), new Uint8Array([2])],
    })
    // 第一张就看不了，后面不再白试
    expect(vision).toHaveBeenCalledTimes(1)
    expect(result.vision_note).toContain('当前模型看不了图')
    expect(result.profile.imagery).toBeUndefined()
    // 文字那一步照常
    expect(result.markdown).toContain('这一节由替身写的')
  })

  it('WP127：上游别的错也说出来，不吞', async () => {
    const vision = vi.fn(async () => {
      throw new Error('provider http 503')
    })
    const result = await composeDesignProse({
      profile: heritage(),
      model: echoModel,
      vision,
      images: [new Uint8Array([1])],
    })
    expect(result.vision_note).toContain('看图那一步没成')
    expect(result.vision_note).toContain('503')
  })

  it('WP127：有图但没接模型——同样明说图没看', async () => {
    const result = await composeDesignProse({ profile: heritage(), images: [new Uint8Array([1])] })
    expect(result.vision_note).toContain('图没看')
  })
})
