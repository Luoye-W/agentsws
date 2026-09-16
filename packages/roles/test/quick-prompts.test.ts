/**
 * WP84（53 §3「217 张角色卡」/ 54 §1 第 6 行）：职责模板的 `quick_prompts` / `task_examples`。
 *
 * 四件事各钉一条：
 * - 两个字段都是**可选**的——老 yml 一个字不改也照样读得进来；
 * - 条数上限（8 / 6）与 id 唯一在**加载时**就拒，不是等界面渲染出两个一样的 key 才发现；
 * - 内置的每一条职责都真写了内容，而且写的是**这条职责的动作**，不是"帮我分析一下"；
 * - 快捷提示不是权限：它不改 scopes / actions / automation 一个字（36 §3 的"不加聊天框"
 *   是界面纪律，这一条是数据纪律）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_QUICK_PROMPTS, MAX_TASK_EXAMPLES } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_ROLES_DIR,
  loadBundledRole,
  loadRole,
  parseRole,
  RoleSchemaError,
} from '../src/index.js'

const SUPPORT_YML = `${BUNDLED_ROLES_DIR}dtc/support.yml`
const source = () => readFileSync(SUPPORT_YML, 'utf8')

/** 本包自带的全部职责 yml（加一条职责不用改这个测试）。 */
function bundledRoleFiles(): string[] {
  const out: string[] = []
  for (const domain of readdirSync(BUNDLED_ROLES_DIR)) {
    const dir = join(BUNDLED_ROLES_DIR, domain)
    if (!statSync(dir).isDirectory()) continue
    for (const file of readdirSync(dir)) if (file.endsWith('.yml')) out.push(join(dir, file))
  }
  return out.sort()
}

describe('quick_prompts / task_examples 的 schema（05 §1，WP84）', () => {
  it('两个字段都可选：没写的 yml 照样读得进来（与 grounding 一样，缺省是空数组）', () => {
    const bare = source()
      .replace(/\nquick_prompts:[\s\S]*$/, '\n')
      .trim()
    const role = parseRole(`${bare}\n`, 'bare.yml')
    expect(role.quick_prompts).toEqual([])
    expect(role.task_examples).toEqual([])
  })

  it('读得回来的就是 yml 里写的那几条，字段一个不少', () => {
    const role = loadBundledRole('dtc.support')
    const first = role.quick_prompts?.[0]
    expect(first?.id).toBe('draft_return_reply')
    expect(first?.label).toEqual({ zh: '起草退货回复', en: 'Draft a return reply' })
    expect(first?.kind).toBe('start_task')
    expect(first?.prompt).toContain('退货政策')

    const example = role.task_examples?.[0]
    expect(example?.id).toBe('return_request')
    expect(example?.title.zh).toBe('一封退货来信')
    expect(example?.expected_output).not.toBe('')
  })

  it(`quick_prompts 超过 ${MAX_QUICK_PROMPTS} 条就拒`, () => {
    const many = Array.from(
      { length: MAX_QUICK_PROMPTS + 1 },
      (_, i) =>
        `  - { id: p${i}, label: { zh: 第${i}条, en: number ${i} }, prompt: 做点什么, kind: ask }`,
    ).join('\n')
    const broken = source().replace(/\nquick_prompts:[\s\S]*?\n\ntask_examples:/, () => {
      return `\nquick_prompts:\n${many}\n\ntask_examples:`
    })
    expect(() => parseRole(broken, 'many.yml')).toThrow(/quick_prompts/)
  })

  it(`task_examples 超过 ${MAX_TASK_EXAMPLES} 条就拒`, () => {
    const many = Array.from(
      { length: MAX_TASK_EXAMPLES + 1 },
      (_, i) =>
        `  - { id: e${i}, title: { zh: 例${i}, en: case ${i} }, description: 一件事, expected_output: 一个结果 }`,
    ).join('\n')
    const broken = source().replace(/\ntask_examples:[\s\S]*$/, `\ntask_examples:\n${many}\n`)
    expect(() => parseRole(broken, 'many.yml')).toThrow(/task_examples/)
  })

  it('id 重名就拒，并指到重的那一条（重名不会报错，只会静默吃掉一条）', () => {
    const broken = source().replace('  - id: where_is_order', '  - id: draft_return_reply')
    const error = (() => {
      try {
        parseRole(broken, 'dup.yml')
        return undefined
      } catch (e) {
        return e as RoleSchemaError
      }
    })()
    expect(error).toBeInstanceOf(RoleSchemaError)
    expect(error?.field).toBe('quick_prompts[1].id')
    expect(error?.message).toContain('draft_return_reply')
  })

  it('示例任务的 id 重名同样拒', () => {
    const broken = source().replace('  - id: damaged_parcel', '  - id: return_request')
    expect(() => parseRole(broken, 'dup.yml')).toThrow(/task_examples\[1\]\.id/)
  })

  it('kind 只有三种；写别的拒', () => {
    const broken = source().replace('    kind: start_task\n', '    kind: chat\n')
    expect(() => parseRole(broken, 'bad-kind.yml')).toThrow(/quick_prompts\[0\]\.kind/)
  })

  it('未声明字段照旧拒（别人的角色卡有 MBTI / SOUL.md，我们不借）', () => {
    const broken = source().replace(
      '  - id: draft_return_reply\n',
      '  - id: draft_return_reply\n    persona_mbti: ENFJ\n',
    )
    expect(() => parseRole(broken, 'extra.yml')).toThrow(/quick_prompts\[0\]\.persona_mbti/)
  })
})

describe('内置职责都写了内容（WP84 §2）', () => {
  const files = bundledRoleFiles()

  it('一条都不落下，条数在 3–5 / 2–3 之间', () => {
    expect(files.length).toBeGreaterThanOrEqual(14)
    for (const file of files) {
      const role = loadRole(file)
      const prompts = role.quick_prompts ?? []
      const examples = role.task_examples ?? []
      expect(prompts.length, `${role.id} quick_prompts`).toBeGreaterThanOrEqual(3)
      expect(prompts.length, `${role.id} quick_prompts`).toBeLessThanOrEqual(5)
      expect(examples.length, `${role.id} task_examples`).toBeGreaterThanOrEqual(2)
      expect(examples.length, `${role.id} task_examples`).toBeLessThanOrEqual(3)
    }
  })

  it('中英各一份，句子不空，id 在本职责内唯一', () => {
    for (const file of files) {
      const role = loadRole(file)
      const ids = new Set<string>()
      for (const p of role.quick_prompts ?? []) {
        expect(ids.has(p.id), `${role.id}.${p.id}`).toBe(false)
        ids.add(p.id)
        expect(p.label.zh.trim(), `${role.id}.${p.id}`).not.toBe('')
        expect(p.label.en.trim(), `${role.id}.${p.id}`).not.toBe('')
        // 一句话要具体：太短的多半是"帮我分析"那种放哪儿都成立的话
        expect(p.prompt.length, `${role.id}.${p.id}`).toBeGreaterThan(10)
      }
      const exampleIds = new Set<string>()
      for (const e of role.task_examples ?? []) {
        expect(exampleIds.has(e.id), `${role.id}.${e.id}`).toBe(false)
        exampleIds.add(e.id)
        expect(e.title.zh.trim(), `${role.id}.${e.id}`).not.toBe('')
        expect(e.title.en.trim(), `${role.id}.${e.id}`).not.toBe('')
        expect(e.description.length, `${role.id}.${e.id}`).toBeGreaterThan(5)
        // 「你会拿到什么」是这两个字段里唯一不能省的那一半
        expect(e.expected_output.length, `${role.id}.${e.id}`).toBeGreaterThan(10)
      }
    }
  })

  it('不是"帮我分析一下"那种放哪儿都成立的话', () => {
    const vague = ['帮我分析', '帮我看看', '有什么建议', '总结一下', '优化一下']
    for (const file of files) {
      const role = loadRole(file)
      for (const p of role.quick_prompts ?? [])
        for (const word of vague)
          expect(p.prompt.startsWith(word), `${role.id}.${p.id}`).toBe(false)
    }
  })

  it('快捷提示不是权限：加了它，scopes / actions / automation 一个字没动', () => {
    // dtc.support 的三项约束照 05 §5 的原样（load.test.ts 已逐条断言；这里只钉"没被改过"）
    const role = loadBundledRole('dtc.support')
    expect(role.scopes).toHaveLength(9)
    expect(role.actions).toHaveLength(6)
    expect(Object.keys(role.automation)).toHaveLength(6)
  })
})
