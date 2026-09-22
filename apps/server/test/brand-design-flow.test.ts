/**
 * WP122b 交付 ③（服务端那一半）：**手改过的格子重抓时整格不动**（71 §2.2）。
 *
 * 界面那条小铅笔（交付 ③ 的另一半）落在 `tokens-view.tsx`，它调的就是这里
 * 钉住的这一跳：`edit` 打 `edited` 标 → 下一次 `extract` 合并时那一格连出处
 * 都不刷新（`merge.ts` 规则 1）。一个小铅笔只要有一次吃掉过你的手工修改，
 * 它就死了——所以这条规则要在服务端钉住，而不是只信包里的单测。
 *
 * 跑的是真装配（`createBrandDesign` + WP121 抓回来的页面夹具），模型不接
 * （成文的直述版，见交付 ④），全替身不联网。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createBrandDesign, designPageKindOf } from '../src/brand-design.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): string =>
  readFileSync(join(HERE, '../../..', 'packages/brand-design/test/fixtures', name), 'utf8')

const T0 = '2026-09-21T09:00:00.000Z'

function makeClock(start = T0) {
  const t = Date.parse(start)
  return { now: () => new Date(t).toISOString() }
}

const ACTOR = {
  workspace_id: 'ws_test',
  person_id: 'p_owner',
  assignment_id: 'asg_owner',
  role_id: 'common.owner',
}

/** 页面从 WP121 那一次分析手上拿（不重抓）；样式表早就拆好在 `sheets` 里。 */
function pages() {
  return [
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
  ]
}

/** 外链样式表那一口的替身：夹具里没有真要抓的地址，真被调到就是错。 */
const neverFetch = (): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
  throw new Error('这一轮不该重抓任何页面')
}

function makeDesign() {
  return createBrandDesign({
    clock: makeClock(),
    workspace_id: 'ws_test',
    fetch: neverFetch,
    pages,
    newId: (prefix) => `${prefix}_1`,
  })
}

describe('WP122b ③：手改过的格子重抓时整格不动', () => {
  it('改一格 → 再抓一轮：值与出处都还是那个人改的那一份', async () => {
    const design = makeDesign()
    const first = await design.port.extract(ACTOR, {})
    expect(first.status).toBe('awaiting_confirm')
    const before = design.profileOf('ws_test')
    expect(before?.colors?.primary).toBeDefined()
    expect(before?.colors?.primary?.edited).toBeUndefined()

    // 小铅笔那一跳：改主色
    const edited = design.port.edit(ACTOR, {
      path: 'colors.primary',
      value: '#123456',
    })
    expect(edited.profile.colors?.primary?.value).toBe('#123456')
    expect(edited.profile.colors?.primary?.edited).toBe(true)
    // 出处记成"这个人本人"，不是官网的某条 CSS
    expect(edited.profile.colors?.primary?.source[0]?.origin).toBe('manual')

    // 再抓一轮（同一批页面，抽出来的还是官网那个值）
    const second = await design.port.extract(ACTOR, {})
    expect(second.status).toBe('awaiting_confirm')
    const after = design.profileOf('ws_test')
    expect(after?.colors?.primary?.value).toBe('#123456')
    expect(after?.colors?.primary?.edited).toBe(true)
    expect(after?.colors?.primary?.source[0]?.origin).toBe('manual')

    // 版本历史里两次都是留痕的
    const revisions = design.port.revisions(ACTOR)
    expect(revisions.length).toBeGreaterThanOrEqual(3)
    design.close()
  })

  it('改成空（null）= 这一格我不要：删掉而不是留空值', async () => {
    const design = makeDesign()
    await design.port.extract(ACTOR, {})
    design.port.edit(ACTOR, { path: 'colors.primary', value: null })
    expect(design.profileOf('ws_test')?.colors?.primary).toBeUndefined()
    design.close()
  })

  it('认不得的令牌路径（深度不对）抛错，不猜', async () => {
    const design = makeDesign()
    await design.port.extract(ACTOR, {})
    expect(() =>
      design.port.edit(ACTOR, { path: 'colors.primary.too.deep', value: '#123456' }),
    ).toThrow()
    design.close()
  })
})

/* ── WP122b 交付 ⑥：Shopify 主题设置 → theme 档 ────────────────────── */

import { shopifyThemeSettings } from '../src/brand-design.js'

const THEME_CONNECT = {
  actions: async () => [
    { id: 'shopify_admin.list_themes' },
    { id: 'shopify_admin.get_theme_asset' },
  ],
  issueToken: async () => ({ token: 'tok_theme_readonly' }),
  execute: async (_id: string, input: unknown) => {
    // list_themes：主主题一行；get_theme_asset：settings_data.json 的 value
    if (JSON.stringify(input ?? {}) === '{}') {
      return { data: { themes: [{ id: 918273, role: 'main', name: 'Dawn' }] } }
    }
    const settings = {
      current: {
        color_schemes: {
          'scheme-1': { settings: { background: '#f7f5f2', button: '#0a7d33', text: '#1a1c1e' } },
        },
        type_header_font: 'assistant_n4',
      },
    }
    return {
      data: { asset: { key: 'config/settings_data.json', value: JSON.stringify(settings) } },
    }
  },
}

describe('WP122b ⑥：主题设置与手册格式', () => {
  it('shopifyThemeSettings：读主主题的 settings_data.json；没那条 Action 就 undefined', async () => {
    const settings = await shopifyThemeSettings(THEME_CONNECT, {
      id: 'conn_1',
      service: 'shopify.store',
    })
    expect(settings).toBeDefined()
    const none = await shopifyThemeSettings(
      { ...THEME_CONNECT, actions: async () => [{ id: 'shopify_admin.get_shop' }] },
      { id: 'conn_1', service: 'shopify.store' },
    )
    expect(none).toBeUndefined()
  })

  it('extract：主题设置进令牌（origin theme），比官网量到的硬一档', async () => {
    const design = createBrandDesign({
      clock: makeClock(),
      workspace_id: 'ws_test',
      fetch: neverFetch,
      pages,
      newId: (prefix) => `${prefix}_1`,
      themeSettings: async () => ({
        current: {
          color_schemes: {
            'scheme-1': { settings: { button: '#0a7d33', background: '#f7f5f2' } },
          },
          type_header_font: 'assistant_n4',
        },
      }),
    })
    await design.port.extract(ACTOR, {})
    const profile = design.profileOf('ws_test')
    expect(profile?.colors?.primary?.value).toBe('#0a7d33')
    expect(profile?.colors?.primary?.source[0]?.origin).toBe('theme')
    expect(profile?.typography?.h1?.value.fontFamily).toBe('Assistant')
    design.close()
  })

  it('themeSettings 抛错：整档跳过，extract 照常出官网令牌', async () => {
    const design = createBrandDesign({
      clock: makeClock(),
      workspace_id: 'ws_test',
      fetch: neverFetch,
      pages,
      newId: (prefix) => `${prefix}_1`,
      themeSettings: async () => {
        throw new Error('连接断了')
      },
    })
    const run = await design.port.extract(ACTOR, {})
    expect(run.status).toBe('awaiting_confirm')
    expect(design.profileOf('ws_test')?.colors?.primary?.source[0]?.origin).toBe('site')
    design.close()
  })
})
