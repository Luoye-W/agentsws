/**
 * WP122b 交付 ④：成文接模型（71 §9 第 4 条）。
 *
 * 三件事各有一个 it：
 * 1. **配了模型**：`composeDesignProse` 真被调到（替身收到了只有**有证据**的小节），
 *    正文是替身写的，积分按预估记账、不超封顶；
 * 2. **没配模型**：`modelFor` 回 `undefined`，正文退回按令牌直述的那一版，
 *    版本历史里**如实标注**（"没接上模型"），不报错、不编；
 * 3. **模型炸了 / 回了读不出的东西**：也退回直述版并标注——
 *    抓取那一轮不该因为成文那一步失败就整个失败。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createBrandDesign, designPageKindOf } from '../src/brand-design.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): string =>
  readFileSync(join(HERE, '../../..', 'packages/brand-design/test/fixtures', name), 'utf8')

const ACTOR = {
  workspace_id: 'ws_test',
  person_id: 'p_owner',
  assignment_id: 'asg_owner',
  role_id: 'common.owner',
}

function makeDesign(modelFor?: Parameters<typeof createBrandDesign>[0]['modelFor']) {
  return createBrandDesign({
    clock: { now: () => '2026-09-21T09:00:00.000Z' },
    workspace_id: 'ws_test',
    fetch: () => {
      throw new Error('这一轮不该重抓任何页面')
    },
    pages: () => [
      {
        url: 'https://heritage.test/',
        kind: designPageKindOf('https://heritage.test/'),
        html: fixture('shopify-home.html'),
        sheets: [
          {
            url: 'https://cdn.shopify.com/s/files/1/0001/theme.css',
            css: fixture('shopify-theme.css'),
          },
        ],
      },
    ],
    newId: (prefix) => `${prefix}_1`,
    ...(modelFor === undefined ? {} : { modelFor }),
  })
}

/** 捕捉替身收到了什么，并回一段分好节的正文。 */
function stubModel(markdown: string) {
  const calls: { prompt: string; tier: string; purpose: string }[] = []
  const model = async (req: { prompt: string; tier: 'cheap'; purpose: string }) => {
    calls.push(req)
    return { text: markdown }
  }
  return { calls, model }
}

/** 一份手写的最小 PDF：一页文字（PANTONE 色值）+ 一页嵌着 JPEG 的图。 */
function pdfWithImage(): Uint8Array {
  const jpeg = new Uint8Array(2048)
  jpeg[0] = 0xff
  jpeg[1] = 0xd8
  jpeg[2] = 0xff
  let text = '%PDF-1.4\n'
  text += '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n'
  text += '2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj\n'
  text += '3 0 obj << /Type /Page /Parent 2 0 R /Contents 6 0 R >> endobj\n'
  text +=
    '4 0 obj << /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 5 0 R >> >> >> endobj\n'
  text += `5 0 obj << /Type /XObject /Subtype /Image /Filter /DCTDecode /Width 8 /Height 8 /Length ${jpeg.length} >> stream\n`
  const head = new TextEncoder().encode(text)
  const tail = new TextEncoder().encode(
    '\nendstream endobj\n' +
      '6 0 obj << /Length 52 >> stream\nBT /F1 12 Tf (PANTONE 186 C) Tj ET\nendstream endobj\n%%EOF\n',
  )
  const out = new Uint8Array(head.length + jpeg.length + tail.length)
  out.set(head, 0)
  out.set(jpeg, head.length)
  out.set(tail, head.length + jpeg.length)
  return out
}

describe('WP122b ④：成文接模型', () => {
  it('配了模型：只有有证据的小节进提示词，正文是模型写的，积分记账不超封顶', async () => {
    const stub = stubModel('## Colors\n\n绿是主色，用来按钮。\n\n## Typography\n\n标题用 Inter。\n')
    const design = makeDesign(({ actor, run_id }) => {
      expect(actor.role_id).toBe('common.owner')
      expect(run_id).toContain('bdr')
      return stub.model
    })
    const run = await design.port.extract(ACTOR, {})
    expect(stub.calls.length).toBe(1)
    expect(stub.calls[0]?.tier).toBe('cheap')
    // 只根据证据写：抓到了色与字体，提示词里就有；间距没抓到，就进不去
    expect(stub.calls[0]?.prompt).toContain('## Colors')
    expect(stub.calls[0]?.prompt).toContain('## Typography')
    expect(stub.calls[0]?.prompt).not.toContain('## Layout')
    // 正文是模型写的
    const doc = design.port.get(ACTOR)
    expect(doc?.markdown).toContain('绿是主色，用来按钮')
    // 积分：预估 0.3（一次便宜档调用，没有视觉调用），封顶 1，实花 0.3
    expect(run.budget.estimated_credits).toBe(0.3)
    expect(run.budget.cap_credits).toBe(1)
    expect(run.budget.spent_credits).toBe(0.3)
    expect(run.status).toBe('awaiting_confirm')
    design.close()
  })

  it('没配模型：退回直述版，版本历史如实标注，不报错', async () => {
    const design = makeDesign(() => undefined)
    const run = await design.port.extract(ACTOR, {})
    expect(run.status).toBe('awaiting_confirm')
    const doc = design.port.get(ACTOR)
    expect(doc?.markdown).toContain('#b8422e') // 直述：原值都在
    const revisions = design.port.revisions(ACTOR)
    expect(revisions.at(-1)?.note).toContain('没接上模型')
    expect(run.budget.spent_credits).toBe(0)
    design.close()
  })

  it('模型炸了：退回直述版并标注，整轮抓取不失败', async () => {
    const design = makeDesign(() => async () => {
      throw new Error('上游 500')
    })
    const run = await design.port.extract(ACTOR, {})
    expect(run.status).toBe('awaiting_confirm')
    const doc = design.port.get(ACTOR)
    expect(doc?.markdown).toContain('#b8422e')
    expect(design.port.revisions(ACTOR).at(-1)?.note).toContain('模型没回')
    design.close()
  })
})

/* ── WP122b 交付 ⑤：视觉档 ─────────────────────────────────────────── */

/** 带 og:image 与一张内容图的一页；图片字节由 imageFetch 替身给。 */
const PAGE_WITH_IMAGES = `<html><head>
<meta property="og:image" content="https://heritage.test/hero.jpg">
</head><body>
<a class="logo-link"><img class="logo" src="/logo.png" alt="logo"></a>
<img src="/cdn/photos/scene.jpg" alt="生活场景">
</body></html>`

function makeDesignWithVision(input: {
  visionFor?: Parameters<typeof createBrandDesign>[0]['visionFor']
  imageFetch?: Parameters<typeof createBrandDesign>[0]['imageFetch']
}) {
  return createBrandDesign({
    clock: { now: () => '2026-09-21T09:00:00.000Z' },
    workspace_id: 'ws_test',
    fetch: () => {
      throw new Error('样式表那一口不该被调到')
    },
    imageFetch: input.imageFetch,
    pages: () => [
      {
        url: 'https://heritage.test/',
        kind: designPageKindOf('https://heritage.test/'),
        html: PAGE_WITH_IMAGES,
        sheets: [],
      },
    ],
    newId: (prefix) => `${prefix}_1`,
    ...(input.visionFor === undefined ? {} : { visionFor: input.visionFor }),
  })
}

/** 字节替身：hero.jpg 给一张"JPEG"（魔数开头），robots.txt 给 404。 */
const IMAGE_BYTES = new Uint8Array(2048)
IMAGE_BYTES[0] = 0xff
IMAGE_BYTES[1] = 0xd8
IMAGE_BYTES[2] = 0xff
const imageFetchStub = (): Parameters<typeof createBrandDesign>[0]['imageFetch'] => {
  return async (url: string) => {
    if (url.includes('robots.txt'))
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    if (url.includes('hero.jpg') || url.includes('scene.jpg'))
      return { ok: true, status: 200, arrayBuffer: async () => IMAGE_BYTES.slice().buffer }
    throw new Error(`不认得这个地址：${url}`)
  }
}

describe('WP122b ⑤：视觉档接通', () => {
  it('配了视觉模型：站上的内容图真被递给视觉口，imagery 按它写，积分按张计', async () => {
    const seen: { size: number }[] = []
    const design = makeDesignWithVision({
      imageFetch: imageFetchStub(),
      visionFor:
        () =>
        async ({ image }) => {
          seen.push({ size: image.length })
          return { text: '实景产品摄影，暖调自然光。' }
        },
    })
    const run = await design.port.extract(ACTOR, {})
    // hero.jpg（og:image）+ scene.jpg（内容图）；logo 被排除
    expect(seen.length).toBe(2)
    // imagery 写的是视觉口回的那句话
    const doc = design.port.get(ACTOR)
    expect(doc?.profile.imagery?.value).toContain('实景产品摄影')
    // 积分：2 张 × 0.1 + 成文 0.3（没配文字模型时直述不收钱——这里只看张数计价）
    expect(run.budget.spent_credits).toBeGreaterThanOrEqual(0.2)
    expect(run.budget.spent_credits).toBeLessThanOrEqual(1)
    design.close()
  })

  it('没配视觉模型：不抓图、不假装分析过——imagery 留「未找到」', async () => {
    let imageFetchCalled = false
    const design = makeDesignWithVision({
      imageFetch: async () => {
        imageFetchCalled = true
        throw new Error('不该被抓')
      },
    })
    const run = await design.port.extract(ACTOR, {})
    expect(imageFetchCalled).toBe(false)
    const doc = design.port.get(ACTOR)
    expect(doc?.profile.imagery).toBeUndefined()
    expect(doc?.markdown).toContain('未找到，请补充')
    expect(run.status).toBe('awaiting_confirm')
    design.close()
  })

  it('PDF 手册：嵌着的图抽出来给视觉口（走 ingestFile）', async () => {
    const seen: number[] = []
    const design = createBrandDesign({
      clock: { now: () => '2026-09-21T09:00:00.000Z' },
      workspace_id: 'ws_test',
      fetch: () => {
        throw new Error('不该被调')
      },
      pages: () => [],
      newId: (prefix) => `${prefix}_1`,
      readUpload: async () => ({ filename: 'brand-book.pdf', bytes: pdfWithImage() }),
      visionFor:
        () =>
        async ({ image }) => {
          seen.push(image.length)
          return { text: '版面以产品摄影为主，留白大。' }
        },
    })
    await design.port.ingestFile(ACTOR, { upload_id: 'up_1' })
    expect(seen.length).toBe(1)
    const doc = design.port.get(ACTOR)
    expect(doc?.profile.imagery?.value).toContain('产品摄影')
    design.close()
  })
})
