/**
 * WP306：IM 里问一句话，问谁（纯函数，喂数组）。
 */
import { describe, expect, it } from 'vitest'
import { type ImAskCandidate, imAskLabels, pickImAssignment } from '../src/im-ask-route.js'

const INMO = 'ws_inmo'
const ROLLOUT = 'ws_rollout'

const c = (
  assignment_id: string,
  workspace_id: string,
  role_id: string,
  extra: { position?: string; role_zh?: string } = {},
): ImAskCandidate => ({
  assignment_id,
  workspace_id,
  role_id,
  brand_name: workspace_id === INMO ? 'INMO' : 'Rollout',
  labels: imAskLabels({ role_id, ...extra }),
})

/** Luoye 10-13 的样子：启动品牌三条（负责人在第一条），Rollout 也有 Reddit。 */
const LUOYE = [
  c('asg_owner', INMO, 'common.owner', { role_zh: '负责人' }),
  c('asg_pr_reddit', INMO, 'pr.reddit', { role_zh: 'Reddit 公关' }),
  c('asg_social_reddit', INMO, 'social.reddit', { role_zh: 'Reddit 社群' }),
  c('asg_ro_owner', ROLLOUT, 'common.owner', { role_zh: '负责人' }),
  c('asg_ro_reddit', ROLLOUT, 'social.reddit', { role_zh: 'Reddit 社群' }),
]

describe('pickImAssignment', () => {
  it('点名「Reddit 运营」→ 机器人所在品牌里他的 Reddit 那条，不落到负责人', () => {
    const out = pickImAssignment({
      candidates: LUOYE,
      question: 'Reddit 运营今天有没有什么需要我处理的',
      home_workspace_id: INMO,
    })
    expect(out?.workspace_id).toBe(INMO)
    expect(['asg_pr_reddit', 'asg_social_reddit']).toContain(out?.assignment_id)
    expect(out?.matched).toBe('Reddit 运营')
  })

  it('同名岗位好几个品牌都有：机器人所在品牌优先，补一句「这次按哪个品牌答的」', () => {
    const out = pickImAssignment({
      candidates: LUOYE,
      question: 'reddit运营今天怎么样',
      home_workspace_id: INMO,
    })
    expect(out?.workspace_id).toBe(INMO)
    expect(out?.note).toContain('INMO')
    expect(out?.note).toContain('Rollout')
  })

  it('问题里带了品牌名 → 按品牌名挑，不补那一句', () => {
    const out = pickImAssignment({
      candidates: LUOYE,
      question: 'Rollout 的 Reddit 运营今天有事吗',
      home_workspace_id: INMO,
    })
    expect(out).toMatchObject({ assignment_id: 'asg_ro_reddit', workspace_id: ROLLOUT })
    expect(out?.note).toBeUndefined()
  })

  it('点名的岗位只在别的品牌有 → 去那个品牌', () => {
    const out = pickImAssignment({
      candidates: [c('asg_owner', INMO, 'common.owner'), c('asg_ro_yt', ROLLOUT, 'social.youtube')],
      question: 'YouTube 运营这周发了几条',
      home_workspace_id: INMO,
    })
    expect(out).toMatchObject({ assignment_id: 'asg_ro_yt', workspace_id: ROLLOUT })
  })

  it('岗位名（公司页上起的）也能点名；越长越具体越优先', () => {
    const out = pickImAssignment({
      candidates: [
        c('asg_a', INMO, 'dtc.support', { position: '客服' }),
        c('asg_b', INMO, 'amz.support', { position: '亚马逊客服' }),
      ],
      question: '亚马逊客服今天积压多少',
      home_workspace_id: INMO,
    })
    expect(out?.assignment_id).toBe('asg_b')
  })

  it('没点名 → 机器人所在品牌的主要岗位（负责人 / 成员排后面）；那里没有就用别的品牌的', () => {
    expect(
      pickImAssignment({ candidates: LUOYE, question: '你好', home_workspace_id: INMO })
        ?.assignment_id,
    ).toBe('asg_pr_reddit')
    expect(
      pickImAssignment({
        candidates: [c('asg_owner', INMO, 'common.owner')],
        question: '你好',
        home_workspace_id: INMO,
      })?.assignment_id,
    ).toBe('asg_owner')
    expect(
      pickImAssignment({
        candidates: [c('asg_ro', ROLLOUT, 'social.reddit')],
        question: '你好',
        home_workspace_id: INMO,
      }),
    ).toMatchObject({ assignment_id: 'asg_ro', workspace_id: ROLLOUT })
  })

  it('哪儿都没有岗位 → undefined', () => {
    expect(
      pickImAssignment({ candidates: [], question: '你好', home_workspace_id: INMO }),
    ).toBeUndefined()
  })
})

describe('imAskLabels', () => {
  it('渠道职责带上默认岗位名与渠道名；太短的名字不当点名', () => {
    expect(imAskLabels({ role_id: 'pr.reddit', role_zh: 'Reddit 公关' })).toEqual(
      expect.arrayContaining(['Reddit 公关', 'Reddit 运营', 'Reddit Ops', 'Reddit']),
    )
    // 「X」这种单字母渠道名不会误命中所有带 x 的问题
    const out = pickImAssignment({
      candidates: [c('asg_x', INMO, 'social.x'), c('asg_s', INMO, 'dtc.support')],
      question: 'next week 有什么安排',
      home_workspace_id: INMO,
    })
    expect(out?.matched).toBeUndefined()
  })
})
