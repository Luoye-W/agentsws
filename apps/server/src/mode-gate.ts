/**
 * WP275（docs/95 §5，决策 222）：**人自己发起的改动**在 ① 个人 / ② 同事互联里当场生效。
 *
 * 这些改动（工具箱合并、把记忆 / 技能提到岗位层或职责层……）的施行逻辑都挂在「卡被批了」
 * 那一下（各模块的 `wrap(bus)` / `applyDecided`）。① ② 没有「另一个人点头」，所以这里的做法是：
 * 卡照出（收件人就是他自己，留名字、留痕、可查），出完**由他本人当场点掉**——施行走的还是
 * 原来那条路，一行施行逻辑都不用复制；队列里永远看不到这张卡。
 *
 * 二次确认在界面上（点之前问一句「当场生效，确定？」），服务端不再拦第二次。
 */
import type { ApprovalBus, ApprovalItem, PersonId } from '@agentsws/contracts'

/** 卡上那一句（决定记录里留着，事后查得到是谁自己改的）。 */
export const SELF_APPLIED_REASON = '自己改的，当场生效（个人 / 同事互联没有审批流）'

/**
 * 出完的卡由收件人本人当场批掉。卡没出成（被预检拦下）、已经不在待定、或收件人里没有他，
 * 原样还回去——调用方照「没生效」处理。
 */
export async function settleOwnCard(
  bus: Pick<ApprovalBus, 'decide'>,
  item: ApprovalItem,
  by: PersonId,
): Promise<ApprovalItem> {
  if (item.state !== 'pending') return item
  const token = item.deliveries.find((d) => d.to === by && d.status === 'sent')?.decision_token
  if (token === undefined) return item
  return bus.decide(item.id, by, {
    action: 'approve',
    decision_token: token,
    via: 'workstation',
    reason: SELF_APPLIED_REASON,
  })
}
