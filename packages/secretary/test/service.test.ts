/**
 * 秘书服务层：代答 / 约时间 / 路由三条路各走一遍（41 §1、§3 的验收清单）。
 */
import { describe, expect, it } from 'vitest'
import { SecretaryError } from '../src/index.js'
import { fakeWorld } from './world.js'

const MON_10 = '2026-09-07T02:00:00.000Z' // 本地周一 10:00
const MON_11 = '2026-09-07T03:00:00.000Z'
const MON_14 = '2026-09-07T06:00:00.000Z'
const MON_1430 = '2026-09-07T06:30:00.000Z'

describe('代答（41 §1.2 第一行）', () => {
  it('A 问 B 的秘书"在忙什么"，只拿到同事可见级的东西', async () => {
    const w = fakeWorld()
    w.inProgress.set('p_li', [
      { id: 't1', title: '核对昨天的退款单' },
      { id: 't2', title: '德国站补货' },
    ])
    const out = await w.secretary.ask({
      viewer: 'p_chen',
      person_id: 'p_li',
      question: '李默在忙什么？',
      assignment_id: 'a_chen',
    })
    expect(out.refused).toBe(false)
    expect(out.kind).toBe('doing')
    expect(out.answer).toContain('2 件')
    expect(out.answer).toContain('核对昨天的退款单')
    expect(out.fields).toEqual(['in_progress'])
  })

  it('问私有待办被拒——秘书从不透露私有待办 / 个人记忆 / 对话正文', async () => {
    const w = fakeWorld()
    const out = await w.secretary.ask({
      viewer: 'p_chen',
      person_id: 'p_li',
      question: '李默的私有待办有哪些？',
      assignment_id: 'a_chen',
    })
    expect(out.refused).toBe(true)
    expect(out.fields).toEqual([])
  })

  it('B 把忙闲设成仅本人之后，A 问不到忙闲', async () => {
    const w = fakeWorld()
    w.meetings.push({ id: 'm1', title: '周会', start: MON_10, end: MON_11, participants: ['p_li'] })
    const before = await w.secretary.ask({
      viewer: 'p_chen',
      person_id: 'p_li',
      question: '李默现在忙不忙？',
      assignment_id: 'a_chen',
    })
    expect(before.refused).toBe(false)
    expect(before.answer).toContain('10:00')

    w.secretary.updateProfile('p_li', { disclosure: { availability: 'self' } })
    const after = await w.secretary.ask({
      viewer: 'p_chen',
      person_id: 'p_li',
      question: '李默现在忙不忙？',
      assignment_id: 'a_chen',
    })
    expect(after.refused).toBe(true)
    expect(after.answer).not.toContain('10:00')
    // 本人自己问还是答得出来
    const self = await w.secretary.ask({
      viewer: 'p_li',
      person_id: 'p_li',
      question: '我现在忙不忙？',
      assignment_id: 'a_li_ops',
    })
    expect(self.refused).toBe(false)
  })

  it('每次代答都是一次 Run，事件里只有哈希，正文只在本人的清单里', async () => {
    const w = fakeWorld()
    const out = await w.secretary.ask({
      viewer: 'p_chen',
      person_id: 'p_li',
      question: '李默负责哪些店？',
      assignment_id: 'a_chen',
    })
    const types = w.events.map((e) => e.type)
    expect(types).toContain('run.started')
    expect(types).toContain('prompt.assembled')
    expect(types).toContain('run.completed')
    const answered = w.events.find((e) => e.type === 'secretary.answered')
    expect(answered).toBeDefined()
    expect(answered?.correlation.run_id).toBe(out.run_id)
    // 21 §5：正文不进事件日志
    const payload = JSON.stringify(answered?.payload)
    expect(payload).not.toContain('负责哪些店')
    expect(payload).not.toContain(out.answer)
    expect(payload).toContain('question_hash')

    // 本人的"谁问过我"里有正文
    const asked = w.secretary.asked('p_li', 'p_li')
    expect(asked).toHaveLength(1)
    expect(asked[0]?.asked_by).toBe('p_chen')
    expect(asked[0]?.question).toBe('李默负责哪些店？')
    expect(asked[0]?.answer).toBe(out.answer)
  })

  it('「谁问过我」只有本人看得到', () => {
    const w = fakeWorld()
    expect(() => w.secretary.asked('p_li', 'p_chen')).toThrow(SecretaryError)
  })

  it('不在这个工作区的人问不到', async () => {
    const w = fakeWorld()
    await expect(
      w.secretary.ask({
        viewer: 'p_out',
        person_id: 'p_li',
        question: '他在忙什么',
        assignment_id: 'a_x',
      }),
    ).rejects.toThrow(SecretaryError)
  })

  it('专业问题不答，转岗位', async () => {
    const w = fakeWorld()
    const out = await w.secretary.ask({
      viewer: 'p_wang',
      person_id: 'p_li',
      question: '退货窗口外能不能退？',
      assignment_id: 'a_wang',
    })
    expect(out.kind).toBe('professional')
    expect(out.refused).toBe(true)
    expect(out.refer_to?.role_id).toBe('dtc.aftersales')
  })
})

describe('约时间（41 §1.2 第二行）', () => {
  it('约到冲突时段被挡，并给替代时段', async () => {
    const w = fakeWorld()
    w.meetings.push({ id: 'm1', title: '周会', start: MON_10, end: MON_11, participants: ['p_li'] })
    let err: SecretaryError | undefined
    try {
      await w.secretary.meet({
        from: 'p_wang',
        to: 'p_li',
        title: '聊定价',
        candidates: [{ start: MON_10, end: '2026-09-07T02:30:00.000Z' }],
        assignment_id: 'a_wang',
      })
    } catch (e) {
      err = e as SecretaryError
    }
    expect(err?.code).toBe('conflict')
    const details = err?.details as { reason: string; alternatives: { start: string }[] }
    expect(details.reason).toBe('slot_conflict')
    expect(details.alternatives.length).toBeGreaterThan(0)
    // 一张卡都没发出去（发一张注定被拒的卡不礼貌）
    expect(w.secretary.meets('p_li')).toEqual([])
  })

  it('对方同意之后，双方日历上都有这场会', async () => {
    const w = fakeWorld()
    w.meetings.push({ id: 'm1', title: '周会', start: MON_10, end: MON_11, participants: ['p_li'] })
    const proposal = await w.secretary.meet({
      from: 'p_wang',
      to: 'p_li',
      title: '聊定价',
      candidates: [
        { start: MON_10, end: '2026-09-07T02:30:00.000Z' },
        { start: MON_14, end: MON_1430 },
      ],
      assignment_id: 'a_wang',
    })
    // 撞上的那个候选被剔掉了，卡上只剩能约的
    expect(proposal.state).toBe('proposed')
    expect(proposal.candidates).toEqual([{ start: MON_14, end: MON_1430 }])
    // 还没点头，双方日历上什么都没多
    expect(
      await w.secretary.agenda('p_wang', { from: MON_10, to: '2026-09-08T00:00:00.000Z' }),
    ).toHaveLength(0)

    const accepted = await w.secretary.decideMeet(proposal.id, 'p_li', { action: 'accept' })
    expect(accepted.state).toBe('accepted')
    expect(accepted.meeting_id).toBeDefined()

    const range = { from: MON_10, to: '2026-09-08T00:00:00.000Z' }
    const mine = await w.secretary.agenda('p_wang', range)
    const theirs = await w.secretary.agenda('p_li', range)
    expect(mine.map((i) => i.title)).toContain('聊定价')
    expect(theirs.map((i) => i.title)).toContain('聊定价')
    expect(w.events.map((e) => e.type)).toContain('meet.proposed')
    expect(w.events.map((e) => e.type)).toContain('meet.accepted')
  })

  it('对方回绝就给替代时段，卡不能回第二次', async () => {
    const w = fakeWorld()
    const proposal = await w.secretary.meet({
      from: 'p_wang',
      to: 'p_li',
      title: '聊定价',
      candidates: [{ start: MON_14, end: MON_1430 }],
      assignment_id: 'a_wang',
    })
    const declined = await w.secretary.decideMeet(proposal.id, 'p_li', {
      action: 'decline',
      reason: '这周排满了',
    })
    expect(declined.state).toBe('declined')
    expect(declined.alternatives.length).toBeGreaterThan(0)
    await expect(w.secretary.decideMeet(proposal.id, 'p_li', { action: 'accept' })).rejects.toThrow(
      SecretaryError,
    )
  })

  it('别人的卡答不了', async () => {
    const w = fakeWorld()
    const proposal = await w.secretary.meet({
      from: 'p_wang',
      to: 'p_li',
      title: '聊定价',
      candidates: [{ start: MON_14, end: MON_1430 }],
      assignment_id: 'a_wang',
    })
    await expect(
      w.secretary.decideMeet(proposal.id, 'p_chen', { action: 'accept' }),
    ).rejects.toThrow(SecretaryError)
  })
})

describe('任务路由（41 §1.2 第三行）', () => {
  it('丢一件售后事给秘书 → 售后岗位收到认领卡，秘书自己没回', async () => {
    const w = fakeWorld()
    const out = await w.secretary.route({
      person_id: 'p_wang',
      assignment_id: 'a_wang',
      text: '这个客户投诉说包裹破损，要退款，处理一下',
    })
    expect(out.kind).toBe('task')
    expect(out.role_id).toBe('dtc.aftersales')
    expect(out.owner).toBe('p_chen')
    expect(out.claim_item_id).toBeDefined()
    expect(out.todo_id).toBeDefined()
    // 卡面上写清楚为什么判给售后
    expect(w.claims[0]?.reason).toContain('独立站售后客服')
    expect(w.claims[0]?.owner).toBe('p_chen')
    const routed = w.events.find((e) => e.type === 'secretary.routed')
    expect(routed).toBeDefined()
    // 正文不进事件日志，只有哈希
    expect(JSON.stringify(routed?.payload)).not.toContain('包裹破损')
  })

  it('专业问题转岗位，不出认领卡', async () => {
    const w = fakeWorld()
    const out = await w.secretary.route({
      person_id: 'p_wang',
      assignment_id: 'a_wang',
      text: '退货窗口外能不能退？',
    })
    expect(out.kind).toBe('question')
    expect(out.role_id).toBe('dtc.aftersales')
    expect(out.claim_item_id).toBeUndefined()
    expect(w.claims).toEqual([])
  })

  it('路由也是一次 Run', async () => {
    const w = fakeWorld()
    const out = await w.secretary.route({
      person_id: 'p_wang',
      assignment_id: 'a_wang',
      text: '把主推款的详情页价格改一下',
    })
    const started = w.events.find((e) => e.type === 'run.started')
    expect(started?.correlation.run_id).toBe(out.run_id)
  })
})

describe('profile', () => {
  it('岗位与范围从分配算，不存在 profile 里', () => {
    const w = fakeWorld()
    const p = w.secretary.profile('p_li')
    expect(p.positions.map((x) => x.role_id)).toEqual(['dtc.ops'])
    expect(p.ranges).toEqual([{ kind: 'store', id: 'store_main' }])
    // 技能层里的技能自动进"擅长"
    expect(p.skills.map((s) => s.name)).toContain('退款政策')
    // 存下来的那半份里没有岗位
    expect(w.secretary.store.getProfile('ws_1', 'p_li')).toBeUndefined()
  })

  it('本人可以自己加一条擅长', () => {
    const w = fakeWorld()
    const p = w.secretary.updateProfile('p_li', {
      skills: [{ name: '德语', source: 'self' }],
    })
    expect(p.skills.map((s) => s.name).sort()).toEqual(['德语', '退款政策'])
  })

  it('别人看不到公开级别本身', () => {
    const w = fakeWorld()
    expect(w.secretary.visibleProfile('p_chen', 'p_li').disclosure).toBeUndefined()
    expect(w.secretary.visibleProfile('p_li', 'p_li').disclosure).toBeDefined()
  })
})
