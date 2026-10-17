/**
 * WP373（Luoye 10-17，决策 977 / 978 / 979 复核）：
 *
 * - 思考程度是 AI 钮右边一个**独立小钮**：三档的模型钮上写当前这一档、点开三档；只支持开 / 关的是开关；
 *   不支持的不出这个钮；
 * - 选的模型后来用不了：AI 钮照旧显示默认那个，但亮一个小黄点，悬停说「原来选的 X 用不了，这次用了默认」；
 * - 换了模型才插「上面是 X 答的，接下来用 Y」：随便聊（`modelSwitches`）与事项（`modelSwitchesOf`）同一个判法。
 */
import type { MatterEvent } from '@agentsws/contracts'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ModelPicker } from '@/components/free-chat/model-picker'
import { ModelSwitchDivider, modelSwitches } from '@/components/free-chat/thread-bits'
import { buildItems, modelSwitchesOf } from '@/components/matter/matter-model'
import type { FreeChatMessage, FreeChatModelChoice, ReasoningEffort } from '@/lib/free-chat'
import { renderWithProviders } from './helpers'

const LEVELS: FreeChatModelChoice = {
  id: 'deepseek-account/deepseek-v4-pro',
  label: 'DeepSeek 账号',
  official: false,
  vision: 'no',
  group: 'own',
  vendor: 'deepseek',
  name: 'DeepSeek-V4-Pro',
  thinking: {
    options: [
      { level: 'fast', effort: 'low' },
      { level: 'standard', effort: 'high' },
      { level: 'deep', effort: 'max' },
    ],
    default: 'high',
  },
}
const TOGGLE: FreeChatModelChoice = {
  id: 'mine/gpt-5-pro',
  label: 'OpenAI（我的 key）',
  official: false,
  vision: 'ok',
  group: 'own',
  vendor: 'openai',
  thinking: { options: [{ level: 'standard', effort: 'high' }], default: 'high', toggle: true },
}
const NONE: FreeChatModelChoice = {
  id: 'agentsws/glm-5',
  label: 'Agents 工坊（积分）',
  official: true,
  vision: 'no',
  group: 'workshop',
}

function mount(
  choices: FreeChatModelChoice[],
  value: string | undefined,
  effort?: ReasoningEffort,
): string[] {
  const efforts: string[] = []
  renderWithProviders(
    <ModelPicker
      choices={choices}
      value={value}
      defaultId={choices[0]?.id}
      onChange={() => undefined}
      effort={effort}
      onEffortChange={(e, model) => efforts.push(`${model}:${e}`)}
    />,
  )
  return efforts
}

describe('WP373 思考程度小钮：三类模型', () => {
  it('三档：钮上写当前档，点开三档，选了收起并回调', () => {
    const efforts = mount([LEVELS], LEVELS.id)
    const btn = screen.getByTestId('model-pick-thinking')
    expect(btn.textContent).toContain('标准')
    expect(btn.getAttribute('data-level')).toBe('standard')
    fireEvent.click(btn)
    fireEvent.click(screen.getByTestId('model-pick-thinking-fast'))
    expect(efforts).toEqual([`${LEVELS.id}:low`])
    expect(screen.queryByTestId('model-pick-thinking-menu')).toBeNull()
  })

  it('三档：存着的档这个模型没有 → 按模型默认显示「标准」', () => {
    mount([LEVELS], LEVELS.id, 'medium')
    expect(screen.getByTestId('model-pick-thinking').getAttribute('data-effort')).toBe('high')
  })

  it('三档：Esc 收起', () => {
    mount([LEVELS], LEVELS.id)
    fireEvent.click(screen.getByTestId('model-pick-thinking'))
    fireEvent.keyDown(screen.getByTestId('model-pick-thinking-menu'), { key: 'Escape' })
    expect(screen.queryByTestId('model-pick-thinking-menu')).toBeNull()
  })

  it('开 / 关型：是一个开关，默认开；关掉回调 off，再开回调那一档', () => {
    const efforts = mount([TOGGLE], TOGGLE.id)
    const control = screen.getByTestId('model-pick-thinking')
    expect(control.hasAttribute('data-toggle')).toBe(true)
    const sw = screen.getByTestId('model-pick-thinking-switch')
    expect(sw.getAttribute('role')).toBe('switch')
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    expect(efforts).toEqual([`${TOGGLE.id}:off`])
  })

  it('开 / 关型：存着 off 就画成关着，点了回调开的那一档', () => {
    const efforts = mount([TOGGLE], TOGGLE.id, 'off')
    const sw = screen.getByTestId('model-pick-thinking-switch')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    expect(efforts).toEqual([`${TOGGLE.id}:high`])
  })

  it('不支持的（工坊积分 / 没声明的）：不出这个钮', () => {
    mount([NONE, LEVELS], NONE.id)
    expect(screen.queryByTestId('model-pick-thinking')).toBeNull()
  })

  it('调用方没接回调：也不出（不能存的地方不给调）', () => {
    renderWithProviders(
      <ModelPicker choices={[LEVELS]} value={LEVELS.id} onChange={() => undefined} />,
    )
    expect(screen.queryByTestId('model-pick-thinking')).toBeNull()
  })
})

describe('WP373（决策 977）选的模型用不了：小黄点', () => {
  it('选的不在清单里 → 显示默认那个、亮黄点，悬停说原来选的是哪个', () => {
    mount([LEVELS, NONE], 'gone/gpt-4o-mini')
    const btn = screen.getByTestId('model-pick')
    expect(btn.getAttribute('data-model')).toBe(LEVELS.id)
    expect(btn.getAttribute('data-stale')).toBe('gone/gpt-4o-mini')
    const dot = screen.getByTestId('model-pick-stale')
    expect(dot.getAttribute('title')).toBe('原来选的 gpt-4o-mini 用不了，这次用了默认')
    expect(btn.getAttribute('title')).toContain('原来选的 gpt-4o-mini 用不了')
  })

  it('选的还在 / 没选：没有黄点', () => {
    mount([LEVELS, NONE], NONE.id)
    expect(screen.queryByTestId('model-pick-stale')).toBeNull()
  })
  it('没选（跟默认走）：没有黄点', () => {
    mount([LEVELS, NONE], undefined)
    expect(screen.queryByTestId('model-pick-stale')).toBeNull()
  })
})

const fc = (id: string, role: 'user' | 'assistant', model?: string): FreeChatMessage =>
  ({
    id,
    session_id: 's1',
    role,
    text: id,
    at: '2026-10-17T10:00:00.000Z',
    ...(model === undefined ? {} : { model: { id: model, label: '来源', official: false } }),
  }) as FreeChatMessage

describe('WP373（决策 978）换了模型那一句：随便聊', () => {
  it('只在真换了的地方：插在引出新模型回答的那句话前面', () => {
    const rows = [
      fc('u1', 'user'),
      fc('a1', 'assistant', 'deepseek/flash'),
      fc('u2', 'user'),
      fc('a2', 'assistant', 'deepseek/flash'),
      fc('u3', 'user'),
      fc('a3', 'assistant', 'openai-codex/gpt-5.5'),
    ]
    const map = modelSwitches(rows)
    expect([...map.keys()]).toEqual(['u3'])
    expect(map.get('u3')?.from.id).toBe('deepseek/flash')
    expect(map.get('u3')?.to.id).toBe('openai-codex/gpt-5.5')
  })

  it('没换不插；还没回答的那句不插', () => {
    const rows = [fc('u1', 'user'), fc('a1', 'assistant', 'deepseek/flash'), fc('u2', 'user')]
    expect(modelSwitches(rows).size).toBe(0)
  })

  it('那一行写「上面是 X 答的，接下来用 Y」', () => {
    renderWithProviders(
      <ModelSwitchDivider from={{ id: 'deepseek/flash' }} to={{ id: 'openai-codex/gpt-5.5' }} />,
    )
    expect(screen.getByTestId('thread-model-switch').textContent).toBe(
      '上面是 flash 答的，接下来用 gpt-5.5',
    )
  })
})

const ev = (id: string, kind: MatterEvent['kind'], model?: string): MatterEvent =>
  ({
    id,
    matter_id: 'mat_1',
    at: '2026-10-17T10:00:00.000Z',
    kind,
    text: id,
    actor: { kind: kind === 'human_message' ? 'person' : 'agent', id: 'x' },
    ...(model === undefined ? {} : { model }),
  }) as MatterEvent

describe('WP373（决策 978）换了模型那一句：事项', () => {
  it('插在那句人话前面；「接着跑」（中间没人说话）插在 AI 那段话前面；老事件没有 model 不参与', () => {
    const timeline = [
      ev('h1', 'human_message'),
      ev('a1', 'agent_message', 'deepseek/flash'),
      ev('h2', 'human_message'),
      ev('a2', 'agent_message', 'openai-codex/gpt-5.5'),
      ev('a3', 'agent_message', 'deepseek/flash'),
      ev('old', 'agent_message'),
      ev('h3', 'human_message'),
      ev('a4', 'agent_message', 'deepseek/flash'),
    ]
    const map = modelSwitchesOf(timeline)
    expect([...map.keys()]).toEqual(['h2', 'a3'])
    const items = buildItems(timeline, { closed: false })
    const kinds = items.filter((i) => i.kind !== 'day').map((i) => i.kind)
    expect(kinds).toEqual(['me', 'ai', 'switch', 'me', 'ai', 'switch', 'ai', 'ai', 'me', 'ai'])
  })
})
