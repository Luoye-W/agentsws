/**
 * WP77（59 §2）：主题那一条**只是薄封装**。
 *
 * 钉的是三件事：分档认得出线上那一份；没有预览链接的副本不许进发布卡
 * （12 §2「预览链接就是审批材料」反过来那一句）；提案的 `before` 取自真读到的列表。
 */
import { describe, expect, it } from 'vitest'
import {
  previewCopy,
  publishReadiness,
  type ThemeCliPort,
  type ThemeSummaryLike,
  themeInstallAfter,
  themeLanes,
  themePublishProposal,
} from '../src/index.js'

const themes: ThemeSummaryLike[] = [
  { id: 't_live', name: 'Dawn 定制版', role: 'main' },
  {
    id: 't_copy',
    name: '双十一版',
    role: 'unpublished',
    preview_url: 'https://shop.example/?preview_theme_id=t_copy',
  },
  { id: 't_bare', name: '没看过的副本', role: 'unpublished' },
  { id: 't_dev', name: 'development/xxx', role: 'development' },
]

describe('主题分档与发布门（59 §2）', () => {
  it('三档分得开；认不出的 role 当副本，不把线上那份漏了', () => {
    const lanes = themeLanes(themes)
    expect(lanes.published?.id).toBe('t_live')
    expect(lanes.copies.map((t) => t.id)).toEqual(['t_copy', 't_bare'])
    expect(lanes.development.map((t) => t.id)).toEqual(['t_dev'])

    const odd = themeLanes([{ id: 'x', name: 'x', role: 'weird' }])
    expect(odd.published).toBeUndefined()
    expect(odd.copies.map((t) => t.id)).toEqual(['x'])
  })

  it('有预览链接的副本可以提发布', () => {
    expect(publishReadiness(themes, 't_copy')).toEqual({ ok: true })
  })

  it('四种提不了：没这份、已经是线上、没预览、临时主题', () => {
    expect(publishReadiness(themes, 'nope').reason).toBe('not_found')
    expect(publishReadiness(themes, 't_live').reason).toBe('already_live')
    expect(publishReadiness(themes, 't_bare').reason).toBe('no_preview')
    expect(publishReadiness(themes, 't_dev').reason).toBe('is_development')
    expect(publishReadiness(themes, 't_bare').message).toContain('预览')
  })

  it('提案的 before 取自真读到的线上主题，risk_class 恒为 high', () => {
    const p = themePublishProposal({
      themes,
      theme_id: 't_copy',
      at: '2026-09-17T03:00:00Z',
      notes: ['活动页改了三处'],
    })
    expect(p.kind).toBe('publish_theme')
    expect(p.risk_class).toBe('high')
    expect(p.before).toEqual({ theme_id: 't_live', theme_name: 'Dawn 定制版' })
    expect(p.after.preview_url).toBe('https://shop.example/?preview_theme_id=t_copy')
    expect(p.target).toEqual({ type: 'theme', id: 't_copy' })
    expect(p.notes).toEqual(['活动页改了三处'])
  })

  it('新店线上一份主题都没有也提得出来（before 写一句人话）', () => {
    const p = themePublishProposal({
      themes: [{ id: 't1', name: '第一版', role: 'unpublished', preview_url: 'https://x' }],
      theme_id: 't1',
      at: '2026-09-17T03:00:00Z',
    })
    expect(p.before.theme_id).toBe('')
    expect(p.before.theme_name).toContain('还没有主题')
  })

  it('previewCopy 只是一次转调——不重试、不改参数', async () => {
    const calls: unknown[] = []
    const cli: ThemeCliPort = {
      status: async () => ({ installed: true, install_command: 'npm i -g @shopify/cli' }),
      list: async () => themes,
      pushUnpublished: async (input) => {
        calls.push(input)
        return { theme_id: 't_new', theme_name: input.name, path: '/tmp/x' }
      },
      publish: async ({ theme_id }) => ({ theme_id }),
    }
    const pushed = await previewCopy(cli, { shop: 'glass-bowl', name: '双十一版' })
    expect(calls).toEqual([{ shop: 'glass-bowl', name: '双十一版' }])
    expect(pushed.theme_id).toBe('t_new')
  })

  it('themeInstallAfter：至少说得出名字（guardrail 判的就是它）', () => {
    expect(themeInstallAfter({ theme_name: 'Dawn 15.0' })).toEqual({ theme_name: 'Dawn 15.0' })
    expect(themeInstallAfter({ theme_name: 'Impulse', price_note: '$320 一次性' })).toEqual({
      theme_name: 'Impulse',
      price_note: '$320 一次性',
    })
  })
})
