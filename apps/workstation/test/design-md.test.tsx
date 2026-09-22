/**
 * 设计规范页与右栏面板（WP122，71 §4）。
 *
 * 前三组盯的都是"这一页**不做什么**"：
 *
 * 1. 还没抓过时画的是一句人话 + 两个入口，**不是一张空色板**；
 * 2. 抽不到的那一节写「未找到，请补充」，**不写「无」**——用户看不出
 *    "这个品牌没有这一项"和"我们没抓到"的区别，而那两件事他要做的动作不同；
 * 3. 冲突的那一格**两个色块都画出来**，界面不替用户判哪个对；
 * 4. 右栏是**只读速查表**：没有编辑、没有抓取按钮。
 *
 * 最后一组是原文那一半的右预览，见它自己那段注释。
 */
import type { BrandDesignProfile } from '@agentsws/contracts'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownPreview } from '@/components/design-md/markdown-preview'
import { countConflicts, designSummary, TokensView } from '@/components/design-md/tokens-view'
import { renderWithProviders } from './helpers'

const COLORS: NonNullable<BrandDesignProfile['colors']> = {
  primary: {
    value: '#b8422e',
    confidence: 'high',
    source: [{ origin: 'site', url: 'https://heritage.test/', locator: 'css-var:--color-brand' }],
    conflict: { value: '#a8321f', source: [{ origin: 'file', page: 3, quote: '#A8321F' }] },
  },
  surface: {
    value: '#f7f5f2',
    confidence: 'medium',
    source: [
      { origin: 'site', url: 'https://heritage.test/', locator: 'css:body{background-color}' },
    ],
  },
}

const PROFILE: BrandDesignProfile = {
  colors: COLORS,
  typography: {
    h1: {
      value: { fontFamily: 'Public Sans', fontSize: '48px', fontWeight: 600 },
      confidence: 'high',
      source: [{ origin: 'site', url: 'https://heritage.test/', locator: 'css:h1{font-size}' }],
    },
  },
  logos: {
    value: [{ url: 'https://heritage.test/logo.png', variant: 'light', min_width_px: 24 }],
    confidence: 'medium',
    source: [{ origin: 'file', page: 2 }],
  },
}

describe('可视化那一半', () => {
  it('色板画出每个令牌的名字与色值 —— 一排没有名字的色块等于没有规范', () => {
    renderWithProviders(<TokensView profile={PROFILE} />)
    const swatch = screen.getByTestId('design-md-color-primary')
    expect(swatch.textContent).toContain('primary')
    expect(swatch.textContent).toContain('#b8422e')
    cleanup()
  })

  it('冲突的那一格把**另一个值也画出来**，不替用户判哪个对', () => {
    renderWithProviders(<TokensView profile={PROFILE} />)
    const conflict = screen.getByTestId('design-md-conflict-primary')
    expect(conflict.textContent).toContain('#a8321f')
    cleanup()
  })

  it('抽不到的那一节写「未找到，请补充」，不写「无」', () => {
    renderWithProviders(<TokensView profile={{ colors: COLORS }} />)
    // 间距与圆角这一轮都没抓到
    expect(screen.getByTestId('design-md-spacing').textContent).toContain('未找到')
    cleanup()
  })

  it('样例按钮用这些令牌**实时渲染**（改一个值它当场跟着变）', () => {
    renderWithProviders(<TokensView profile={PROFILE} />)
    const sample = screen.getByTestId('design-md-components')
    const button = sample.querySelector('button')
    expect(button?.style.backgroundColor).toBe('rgb(184, 66, 46)')
    cleanup()
  })

  it('一份空档案：每一节都留白，不抛', () => {
    renderWithProviders(<TokensView profile={{}} />)
    expect(screen.getAllByText('未找到，请补充').length).toBeGreaterThanOrEqual(4)
    cleanup()
  })
})

/*
 * WP122b 交付 ③：改一格的小铅笔。铅笔只在**给了 onEdit** 的那半页画
 * （设计规范页；右栏只读面板不给），一次只开一格，出错就地一行字不弹框。
 * "重抓后手改格不动"那条规则在服务端钉（apps/server/test/brand-design-flow.test.ts），
 * 这里钉的是界面那一半。
 */
describe('改一格的小铅笔（WP122b ③）', () => {
  it('点开铅笔是当前值；保存把路径与新值原样递给 onEdit', async () => {
    const saved: { path: string; value: string }[] = []
    renderWithProviders(
      <TokensView
        profile={PROFILE}
        onEdit={async (path, value) => {
          saved.push({ path, value })
        }}
      />,
    )
    fireEvent.click(screen.getByTestId('design-md-edit-colors.primary'))
    const input = screen.getByTestId('design-md-edit-input-colors.primary') as HTMLInputElement
    expect(input.value).toBe('#b8422e')
    fireEvent.change(input, { target: { value: '#123456' } })
    fireEvent.click(screen.getByTestId('design-md-edit-save-colors.primary'))
    await waitFor(() => expect(saved).toEqual([{ path: 'colors.primary', value: '#123456' }]))
    cleanup()
  })

  it('onEdit 拒了：就地一行字，不弹框', async () => {
    renderWithProviders(
      <TokensView
        profile={PROFILE}
        onEdit={async () => {
          throw new Error('值看不懂')
        }}
      />,
    )
    fireEvent.click(screen.getByTestId('design-md-edit-colors.primary'))
    fireEvent.click(screen.getByTestId('design-md-edit-save-colors.primary'))
    await waitFor(() =>
      expect(screen.getByTestId('design-md-edit-error').textContent).toContain('值看不懂'),
    )
    cleanup()
  })

  it('不给 onEdit（右栏只读面板）：一支铅笔都不画', () => {
    renderWithProviders(<TokensView profile={PROFILE} />)
    expect(screen.queryByTestId('design-md-edit-colors.primary')).toBeNull()
    cleanup()
  })
})

describe('摘要那一行（档案卡与右栏共用）', () => {
  it('数的是色、字体与 logo 三个数', () => {
    expect(designSummary(PROFILE)).toEqual({ colors: 2, fonts: 1, logos: 1 })
  })

  it('没有 url 的 logo（只从手册读到用法规则的那种）不算进"有几个 logo"', () => {
    const onlyRules: BrandDesignProfile = {
      logos: {
        value: [{ url: '', variant: 'light', min_width_px: 24 }],
        confidence: 'high',
        source: [{ origin: 'file', page: 2 }],
      },
    }
    expect(designSummary(onlyRules).logos).toBe(0)
  })

  it('冲突数就是界面上那个角标', () => {
    expect(countConflicts(PROFILE)).toBe(1)
    expect(countConflicts({})).toBe(0)
  })
})

/*
 * 原文那一半的右预览（71 §4「左改右预览」）。
 *
 * 这一组里最要紧的是第三条：这份文件的内容有三个来路，其中两个不是我们写的
 * （用户粘进来的整份替换、模型写成的正文）。预览把它当**文本**排，不当 HTML 插。
 */
describe('原文预览', () => {
  const MD = [
    '---',
    'colors:',
    '  primary: "#b8422e"',
    '---',
    '',
    '# 用法',
    '主色只用在最重要的那一处。',
    '',
    '- 不要大面积铺',
    '- 不要和红色放在一起',
  ].join('\n')

  it('文件头那一段单独画出来（机器读的，不混进正文里）', () => {
    renderWithProviders(<MarkdownPreview markdown={MD} />)
    expect(screen.getByTestId('design-md-preview-front').textContent).toContain('primary')
    cleanup()
  })

  it('标题、段落与列表都排出来，一个字都不吞', () => {
    renderWithProviders(<MarkdownPreview markdown={MD} />)
    const text = screen.getByTestId('design-md-preview').textContent ?? ''
    expect(text).toContain('用法')
    expect(text).toContain('主色只用在最重要的那一处。')
    expect(text).toContain('不要大面积铺')
    cleanup()
  })

  it('正文里混进来的标签**当文字排**，不当 HTML 插进 DOM', () => {
    renderWithProviders(
      <MarkdownPreview markdown={'# 标题\n<img src=x onerror="alert(1)"> 这一行'} />,
    )
    const el = screen.getByTestId('design-md-preview')
    expect(el.textContent).toContain('<img src=x onerror=')
    expect(el.querySelector('img')).toBeNull()
    cleanup()
  })

  it('没有文件头也不抛（用户粘进来的可能只有正文）', () => {
    renderWithProviders(<MarkdownPreview markdown="# 只有正文" />)
    expect(screen.queryByTestId('design-md-preview-front')).toBeNull()
    expect(screen.getByTestId('design-md-preview').textContent).toContain('只有正文')
    cleanup()
  })
})

/* ── WP122b 交付 ⑦：向导品牌档案卡上的那一行 ─────────────────────────── */

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getBrandDesign: vi.fn(),
  }
})

describe('品牌档案卡上的那一行（向导第 ② 步）', () => {
  it('有规范：一行摘要 + 上传手册入口；空档案/没抓过：整行不出现', async () => {
    const { DesignSpecRow } = await import('@/components/design-md/design-spec-row')
    const { getBrandDesign } = await import('@/lib/api')
    const mocked = vi.mocked(getBrandDesign)

    // 没抓过：整行不出现（不显示「0 色」）
    mocked.mockResolvedValue(null as never)
    renderWithProviders(<DesignSpecRow />)
    await waitFor(() => expect(mocked).toHaveBeenCalled())
    expect(screen.queryByTestId('intake-design-md')).toBeNull()
    cleanup()

    // 抓到了：摘要与入口都在
    mocked.mockResolvedValue({ profile: PROFILE } as never)
    renderWithProviders(<DesignSpecRow />)
    const row = await waitFor(() => screen.getByTestId('intake-design-md'))
    expect(row.textContent).toContain('2 色')
    expect(row.textContent).toContain('上传品牌手册')
    cleanup()
  })
})
