/**
 * WP343：「我的助理」派活挑岗位——点名照点、提到一个就派、只有一个干活岗位就派、其余拿不准不乱派。
 */
import { describe, expect, it } from 'vitest'
import { type PickPosition, pickDispatchTarget } from '../src/index.js'

const owner: PickPosition = {
  id: 'owner',
  name: '负责人',
  duties: [{ role_id: 'common.owner', name: '工作区所有者' }],
}
const reddit: PickPosition = {
  id: 'reddit-ops',
  name: 'Reddit 运营',
  aliases: ['Reddit Ops'],
  duties: [
    { role_id: 'social.reddit', name: '官方版块' },
    { role_id: 'pr.reddit', name: 'Reddit 外部露出' },
  ],
}
const care: PickPosition = {
  id: 'customer-care',
  name: '客服',
  duties: [{ role_id: 'dtc.support', name: '售后客服' }],
}

describe('pickDispatchTarget', () => {
  it('点了岗位名就照点的；职责名认得出就带上', () => {
    expect(
      pickDispatchTarget([owner, reddit, care], {
        text: '查一下今天的新帖',
        position: 'reddit运营',
        duty: '官方版块',
      }),
    ).toEqual({ ok: true, position_id: 'reddit-ops', role_id: 'social.reddit', by: 'named' })
  })

  it('话里提到一个岗位就派给它（职责名也提到了就带上）', () => {
    const out = pickDispatchTarget([owner, reddit, care], {
      text: '让 Reddit 运营的官方版块查一下今天的新帖',
    })
    expect(out).toEqual({
      ok: true,
      position_id: 'reddit-ops',
      role_id: 'social.reddit',
      by: 'mentioned',
    })
  })

  it('只提到职责名也认（全部岗位里只有一条）', () => {
    const out = pickDispatchTarget([owner, reddit, care], { text: '让售后客服把退货政策再看一遍' })
    expect(out).toMatchObject({ ok: true, position_id: 'customer-care', role_id: 'dtc.support' })
  })

  it('只有一个干活的岗位：不点名也派（负责人那种通用岗位不算）', () => {
    expect(pickDispatchTarget([owner, care], { text: '把昨天的工单过一遍' })).toMatchObject({
      ok: true,
      position_id: 'customer-care',
      by: 'only',
    })
  })

  it('拿不准就不派：回候选（不含通用岗位）', () => {
    const out = pickDispatchTarget([owner, reddit, care], { text: '帮我把这件事办了' })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.candidates).toEqual(['Reddit 运营', '客服'])
  })

  it('点的岗位名对不上：不派，列出全部候选', () => {
    const out = pickDispatchTarget([owner, reddit, care], { text: '发个帖', position: '投放' })
    expect(out).toMatchObject({ ok: false, candidates: ['Reddit 运营', '客服'] })
  })

  it('一个岗位都没有：说先建岗位', () => {
    const out = pickDispatchTarget([], { text: '发个帖' })
    expect(out).toMatchObject({ ok: false, candidates: [] })
    if (!out.ok) expect(out.reason).toContain('建一个岗位')
  })

  it('认不出的职责名不带（岗位里自己分），不因此拒绝', () => {
    expect(
      pickDispatchTarget([reddit, care], { text: '回一下', position: '客服', duty: '不存在的' }),
    ).toEqual({ ok: true, position_id: 'customer-care', by: 'named' })
  })
})
