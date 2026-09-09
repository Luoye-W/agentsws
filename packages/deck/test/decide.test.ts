import { describe, expect, it } from 'vitest'
import type { DeckCard, ProjectContext } from '../src/index.js'
import {
  DeckError,
  errorCodeFor,
  INSTRUCTION_SCOPES,
  projectCard,
  resolveDecision,
} from '../src/index.js'
import { item, NOW, policyItem } from './fixtures.js'

const ctx: ProjectContext = { now: NOW, position_id: 'asg_1' }
const options = { now: NOW }
const draft = (): DeckCard => projectCard(item(), ctx)
const question = (): DeckCard => projectCard(policyItem(), ctx)

const fails = (fn: () => unknown, reason: string, code: string): void => {
  expect(fn).toThrow(DeckError)
  try {
    fn()
  } catch (err) {
    const e = err as DeckError
    expect(e.reason).toBe(reason)
    expect(e.code).toBe(code)
  }
}

describe('resolveDecision（36 §2.1 五动作 → 14 §4 状态机）', () => {
  it('普通 approve 就是 approve', () => {
    expect(resolveDecision(draft(), { action: 'approve' }, options)).toEqual({ action: 'approve' })
  })

  it('带 edited_payload 的 approve 变成 approve_edited（14 §9 强纠正信号）', () => {
    const out = resolveDecision(draft(), { action: 'approve', edited_payload: { x: 1 } }, options)
    expect(out).toEqual({ action: 'approve_edited', edited_payload: { x: 1 } })
  })

  it('选择题卡裸 approve → OPTION_REQUIRED（映射 invalid_input）', () => {
    fails(
      () => resolveDecision(question(), { action: 'approve' }, options),
      'OPTION_REQUIRED',
      'invalid_input',
    )
    fails(
      () => resolveDecision(question(), { action: 'approve', selected_option_id: '' }, options),
      'OPTION_REQUIRED',
      'invalid_input',
    )
  })

  it('选了卡上没有的选项 → UNKNOWN_OPTION', () => {
    fails(
      () => resolveDecision(question(), { action: 'approve', selected_option_id: 'nope' }, options),
      'UNKNOWN_OPTION',
      'invalid_input',
    )
  })

  it('选对了 → approve_edited，选项写进 payload', () => {
    const out = resolveDecision(
      question(),
      { action: 'approve', selected_option_id: 'grace_7' },
      options,
    )
    expect(out.action).toBe('approve_edited')
    expect(out.edited_payload).toMatchObject({ selected_option_id: 'grace_7' })
  })

  it('选择题卡的 payload 不是对象时也能写进选项', () => {
    const card = { ...question(), detail: { ...question().detail, payload: 'x' } }
    const out = resolveDecision(card, { action: 'approve', selected_option_id: 'refuse' }, options)
    expect(out.edited_payload).toEqual({ selected_option_id: 'refuse' })
  })

  it('reject 必须写原因（14 §4）', () => {
    fails(
      () => resolveDecision(draft(), { action: 'reject' }, options),
      'REASON_REQUIRED',
      'invalid_input',
    )
    fails(
      () => resolveDecision(draft(), { action: 'reject', reason: '   ' }, options),
      'REASON_REQUIRED',
      'invalid_input',
    )
    expect(resolveDecision(draft(), { action: 'reject', reason: '太啰嗦' }, options)).toEqual({
      action: 'reject',
      reason: '太啰嗦',
    })
  })

  it('reject 也能带指导（作用域一起记）', () => {
    const out = resolveDecision(
      draft(),
      { action: 'reject', instruction: { scope: 'similar_cases', text: '别提补偿' } },
      options,
    )
    expect(out).toEqual({
      action: 'reject',
      reason: '别提补偿',
      instruction_scope: 'similar_cases',
    })
  })

  it('instruct 必须带作用域', () => {
    fails(
      () => resolveDecision(draft(), { action: 'instruct' }, options),
      'SCOPE_REQUIRED',
      'invalid_input',
    )
  })

  it('作用域只能是三个之一，文本不能为空', () => {
    fails(
      () =>
        resolveDecision(
          draft(),
          { action: 'instruct', instruction: { scope: 'whatever' as 'global_rule', text: 'x' } },
          options,
        ),
      'SCOPE_REQUIRED',
      'invalid_input',
    )
    fails(
      () =>
        resolveDecision(
          draft(),
          { action: 'instruct', instruction: { scope: 'global_rule', text: ' ' } },
          options,
        ),
      'SCOPE_REQUIRED',
      'invalid_input',
    )
  })

  it('instruct → 14 的 reject + 指导文本 + 作用域', () => {
    for (const scope of INSTRUCTION_SCOPES) {
      expect(
        resolveDecision(
          draft(),
          { action: 'instruct', instruction: { scope, text: '短一点' } },
          options,
        ),
      ).toEqual({ action: 'reject', reason: '短一点', instruction_scope: scope })
    }
  })

  it('snooze → defer，默认推 4 小时', () => {
    expect(resolveDecision(draft(), { action: 'snooze' }, options)).toEqual({
      action: 'defer',
      defer_until: '2026-09-07T05:00:00.000Z',
    })
    expect(
      resolveDecision(
        draft(),
        { action: 'snooze', defer_until: '2026-09-08T00:00:00.000Z', reason: '等物流' },
        options,
      ),
    ).toEqual({
      action: 'defer',
      defer_until: '2026-09-08T00:00:00.000Z',
      reason: '等物流',
    })
  })

  it('open 不是一次决定', () => {
    fails(
      () => resolveDecision(draft(), { action: 'open' }, options),
      'ACTION_NOT_AVAILABLE',
      'invalid_input',
    )
  })

  it('卡片状态不允许的动作被拒', () => {
    const done = projectCard(item({ state: 'applied' }), ctx)
    fails(
      () => resolveDecision(done, { action: 'approve' }, options),
      'ACTION_NOT_AVAILABLE',
      'invalid_input',
    )
  })

  it('乐观并发：version 不一致 → conflict', () => {
    fails(
      () => resolveDecision(draft(), { action: 'approve', version: 0 }, options),
      'VERSION_MISMATCH',
      'conflict',
    )
    expect(resolveDecision(draft(), { action: 'approve', version: 1 }, options).action).toBe(
      'approve',
    )
  })

  it('DeckError 的 details 可省', () => {
    const e = new DeckError('REASON_REQUIRED', 'x')
    expect(e.details).toBeUndefined()
    expect(e.name).toBe('DeckError')
  })
})

describe('错误码表', () => {
  it('每个 reason 都有一个 28 §2 的统一码', () => {
    expect(errorCodeFor('OPTION_REQUIRED')).toBe('invalid_input')
    expect(errorCodeFor('VERSION_MISMATCH')).toBe('conflict')
    expect(errorCodeFor('UNKNOWN_QUERY')).toBe('not_found')
  })
})
