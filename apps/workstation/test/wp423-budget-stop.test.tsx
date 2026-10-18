/**
 * WP423：预算停下后的界面照实说——
 *
 * - 摘要那一行写人话原因（「查的东西太多，这一轮先停在这里」），不是笼统的「这次被停下了」；
 * - 「接着做」挂在收尾那段话下面（同一次运行的 AI 消息）；后面有人接着说了就不再出；
 * - 等着的卡全是连接卡时页头写「等你连上」、全是配置卡写「等你填设置」，有真要批的才写「等你批」。
 */
import type { MatterEvent } from '@agentsws/contracts'
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { buildItems, matterState, resumableOf, waitingOnOf } from '@/components/matter/matter-model'
import { SysLine } from '@/components/matter/matter-timeline'
import { renderWithProviders } from './helpers'

const AT = '2026-10-19T06:00:00.000Z'
const LATER = '2026-10-19T06:05:00.000Z'

const base = (over: Partial<MatterEvent> & Pick<MatterEvent, 'id' | 'kind'>): MatterEvent => ({
  matter_id: 'mat_1',
  at: AT,
  text: '',
  actor: { kind: 'agent', id: 'asg_1' },
  ...over,
})

const budgetRun = (): MatterEvent[] => [
  base({
    id: 'e1',
    kind: 'human_message',
    text: '找 5 个 subreddit',
    actor: { kind: 'person', id: 'p1' },
  }),
  base({ id: 'e2', kind: 'run', run_id: 'run_1', text: 'AI 接着这个事项跑了一次' }),
  base({
    id: 'e3',
    kind: 'status',
    run_id: 'run_1',
    text: '查的东西太多，这一轮先停在这里',
    run_digest: { seconds: 81, outcome: 'stopped', steps: [], budget: 'max_tokens' },
  }),
  base({
    id: 'e4',
    kind: 'agent_message',
    run_id: 'run_1',
    text: '查到的 5 个版面……还差 3 个帖子。',
  }),
]

describe('WP423：预算停下的那一次', () => {
  it('「接着做」挂在收尾那段话下面；后面人又说了一句就不出', () => {
    expect(resumableOf(budgetRun())).toEqual({ id: 'e4', budget: true })
    const later = [
      ...budgetRun(),
      base({
        id: 'e5',
        kind: 'human_message',
        at: LATER,
        text: '接着',
        actor: { kind: 'person', id: 'p1' },
      }),
    ]
    expect(resumableOf(later)).toBeUndefined()
  })

  it('没有收尾那段话：挂在摘要那一行；被人点停的（WP236）照旧', () => {
    expect(resumableOf(budgetRun().slice(0, 3))).toEqual({ id: 'e3', budget: true })
    const stopped = [
      base({ id: 's1', kind: 'status', text: '这次被停下了', stopped: { reason: 'user' } }),
    ]
    expect(resumableOf(stopped)).toEqual({ id: 's1', budget: false })
  })

  it('摘要那一行写人话原因', () => {
    const items = buildItems(budgetRun(), { live: undefined, roleId: undefined, closed: false })
    const digest = items.find((i) => i.kind === 'sys' && i.event.id === 'e3')
    if (digest?.kind !== 'sys') throw new Error('没有摘要那一行')
    renderWithProviders(<SysLine item={digest} roleName={() => undefined} />)
    expect(screen.getByText(/查的东西太多，这一轮先停在这里/)).toBeTruthy()
    expect(screen.queryByText(/这次被停下了/)).toBeNull()
  })
})

describe('WP423：只差连插件时页头不写「等你批」', () => {
  const card = (connect: boolean, setup = connect) => ({ connect, setup })
  it('全是连接卡 → connect；全是配置卡 → setup；有真要批的 / 没拉全 → 照旧', () => {
    expect(waitingOnOf([card(true)], 1)).toBe('connect')
    expect(waitingOnOf([card(false, true)], 1)).toBe('setup')
    expect(waitingOnOf([card(true), card(false, false)], 2)).toBeUndefined()
    expect(waitingOnOf([card(true)], 2)).toBeUndefined()
    expect(waitingOnOf([], 0)).toBeUndefined()
  })
  it('页头状态按它细分', () => {
    const input = { closed: false, running: false, awaiting: true, timeline: [] }
    expect(matterState({ ...input, waitingOn: 'connect' })).toBe('connect')
    expect(matterState({ ...input, waitingOn: 'setup' })).toBe('setup')
    expect(matterState(input)).toBe('awaiting')
    expect(matterState({ ...input, running: true, waitingOn: 'connect' })).toBe('running')
  })
})
