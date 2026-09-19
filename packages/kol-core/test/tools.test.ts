/**
 * WP117（66 断点 #1）：工具目录本身的约束。
 *
 * 这个文件测的不是「工具能不能干活」（那在服务端那一侧），而是**目录是不是自洽**：
 * 名字唯一、schema 形状对、必填项写了、渠道判定与 `role_id` 对得上。
 * 目录一错位，三个运行时的工具面就都错位。
 */
import { describe, expect, it } from 'vitest'
import {
  isKolRole,
  KOL_TOOL_NAMES,
  KOL_TOOL_SPECS,
  kolChannelOfRole,
  kolToolSpec,
} from '../src/tools.js'

describe('红人工具目录', () => {
  it('名字唯一，且 KOL_TOOL_NAMES 是排好序的同一份', () => {
    const names = KOL_TOOL_SPECS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
    expect([...KOL_TOOL_NAMES]).toEqual([...names].sort())
  })

  it('每个工具都有一句中文说明与 object 形状的 schema', () => {
    for (const spec of KOL_TOOL_SPECS) {
      expect(spec.description.length).toBeGreaterThan(10)
      const schema = spec.input_schema as { type: string; properties: Record<string, unknown> }
      expect(schema.type).toBe('object')
      expect(Object.keys(schema.properties).length).toBeGreaterThan(0)
    }
  })

  it('写工具的必填项里一定有它要改的那个对象的 id', () => {
    const required = (name: string): string[] => {
      const schema = kolToolSpec(name)?.input_schema as { required?: string[] } | undefined
      return schema?.required ?? []
    }
    expect(required('draft_outreach')).toContain('creator_id')
    expect(required('advance_collaboration')).toEqual(['collaboration_id', 'stage'])
    expect(required('review_deliverable')).toEqual(['deliverable_id', 'review'])
    expect(required('create_tracked_link')).toContain('collaboration_id')
    expect(required('register_deliverable')).toContain('collaboration_id')
    expect(required('add_to_campaign')).toContain('creator_ids')
  })

  it('读工具一个必填项都不要（不给过滤条件就是全都要）', () => {
    for (const name of ['list_collaborations', 'list_deliverables']) {
      const schema = kolToolSpec(name)?.input_schema as { required?: string[] }
      expect(schema.required).toBeUndefined()
    }
  })

  it('kolToolSpec 认全名（带服务前缀的那种）', () => {
    expect(kolToolSpec('kol.draft_outreach')?.name).toBe('draft_outreach')
    expect(kolToolSpec('draft_outreach')?.name).toBe('draft_outreach')
    expect(kolToolSpec('get_order')).toBeUndefined()
  })

  it('五条渠道职责各自认得出自己的渠道；别的职责一律不是红人', () => {
    expect(kolChannelOfRole('kol.youtube')).toBe('youtube')
    expect(kolChannelOfRole('kol.instagram')).toBe('instagram')
    expect(kolChannelOfRole('kol.tiktok')).toBe('tiktok')
    expect(kolChannelOfRole('kol.facebook')).toBe('facebook')
    expect(kolChannelOfRole('kol.x')).toBe('x')
    expect(kolChannelOfRole('dtc.support')).toBeUndefined()
    // 前缀对了但尾巴不是五条里的一条：也不算（免得 `kol.whatever` 混进来）
    expect(kolChannelOfRole('kol.weibo')).toBeUndefined()
    expect(isKolRole('kol.youtube')).toBe(true)
    expect(isKolRole('social.youtube')).toBe(false)
  })
})
