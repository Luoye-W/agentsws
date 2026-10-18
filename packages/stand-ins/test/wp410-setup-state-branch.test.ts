/**
 * WP410（真机 #9）：stub 问连接 / 设置现状——只照「当前设置快照」说；没有快照 / 不是问状态，一个字节不变。
 */
import type { ContextItem, RunRequest } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { renderSetupState, SETUP_STATE_ITEM_ID, setupStateBranch } from '../src/index.js'

const snap = {
  note: '这是此刻从库里读出的真实值',
  settings: [
    {
      name: 'Reddit 巡查',
      configured: true,
      values: { 关键词: 'IVRA, AI glasses', 重点版块: '（空）' },
      connections: { 'Chrome 插件（巡查走这条）': '已连好：Chrome 里登着 u/IVRA_Official' },
      notes: ['正在巡查（2026-10-18T11:49:00.000Z 开始）：收件箱等插件交回'],
    },
  ],
  open_cards: [],
}

const item = (content: unknown): ContextItem => ({
  id: SETUP_STATE_ITEM_ID,
  kind: 'summary',
  source_ref: SETUP_STATE_ITEM_ID,
  sensitivity: 'internal',
  content: JSON.stringify(content),
  bytes: 1,
})
const req = (context: ContextItem[]) => ({ context }) as unknown as RunRequest

describe('setupStateBranch', () => {
  it('问状态 + 有快照 → 照快照说（连接、原值、正在跑、没有开着的卡）', () => {
    const out = setupStateBranch(req([item(snap)]), 'Reddit 连上了吗？')
    expect(out).toContain('**Reddit 巡查**（设好了）')
    expect(out).toContain('- Chrome 插件（巡查走这条）：已连好：Chrome 里登着 u/IVRA_Official')
    expect(out).toContain('- 关键词：IVRA, AI glasses')
    expect(out).toContain('- 重点版块：（空）')
    expect(out).toContain('正在巡查')
    expect(out).toContain('没有开着的设置卡 / 连接卡。')
    expect(setupStateBranch(req([item(snap)]), '现在关键词是哪些')).toBe(out)
  })

  it('没有快照 / 不是问状态 / 快照坏了 → undefined', () => {
    expect(setupStateBranch(req([]), 'Reddit 连上了吗？')).toBeUndefined()
    expect(setupStateBranch(req([item(snap)]), '帮我写一条回复')).toBeUndefined()
    expect(setupStateBranch(req([{ ...item(snap), content: '{bad' }]), '连上了吗')).toBeUndefined()
  })

  it('开着的卡照实列出来', () => {
    expect(
      renderSetupState({ ...snap, open_cards: [{ kind: '连接卡', title: '先连上Reddit API' }] }),
    ).toContain('还开着的卡：「先连上Reddit API」。')
  })
})
