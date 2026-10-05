/**
 * WP232（10-05 真模型 deepseek-chat 实测）：两个**出卡给人批**的工具（`draft_reply` / `stage_refund`）
 * 给模型的那几句话。三个运行时读同一份。
 *
 * 1. 没建成卡时的原因。以前 dsh 写「未获批准（fail-closed）」、direct 写 `draft_rejected`——
 *    真模型据此编出了「这次提案走了审批闸，答案位没人应答」，叫用户「在界面上批一下我再重出」。
 *    实际上这两个工具**从不等人**：卡是同步建的（人批不批是之后的事），建不成只因为宿主拒收。
 *    所以照实说「没建成、没有卡在等人批」。
 * 2. 草稿正文用什么语言：工具描述里单独说一句——模型挑工具、填参数的那一刻读的就是它，
 *    比只放在系统提示里稳；而过程中对用户说的话不受这一句影响（见 `@agentsws/roles` 的
 *    `REPLY_LANGUAGE_RULE`）。
 */

/** `stage_refund` 没挂上：宿主没接这笔变更。 */
export const STAGE_NOT_CREATED =
  'stage_refund 没挂上：宿主没接这笔变更（没有可挂的订单或被预检拦下），没有任何卡在等人批。'

/** `draft_reply` 没出成卡：宿主拒收（预检拦下）。收件人找不到**不会**走到这里（宿主出收件人待定的卡）。 */
export const DRAFT_NOT_CREATED =
  'draft_reply 没出成卡：草稿被宿主拒收（没过出站预检），没有任何卡在等人批；把稿子贴给用户并说明没出卡。'

/** 起草工具的描述（dsh / direct 同一句）：出一张待批卡、当场就建好、不等人。 */
export const DRAFT_TOOL_DESCRIPTION =
  'Propose an outbound reply. Nothing is sent: it creates an approval card right away (nobody ' +
  'needs to be online). A reply you write outside this tool reaches nobody. If no recipient ' +
  'address is known, the card says so and the user sends it by hand.'

/** 起草工具 `body` 参数的描述：对外稿件跟来信语言（只管这封稿子，不管你对用户说的话）。 */
export const DRAFT_BODY_DESCRIPTION =
  'Reply body, written in the language of the message being answered (English letter → English ' +
  'reply). Only this outgoing text follows their language; what you say to the user stays in the ' +
  'user interface language.'

/** 起草工具 `subject` 参数的描述（同上）。 */
export const DRAFT_SUBJECT_DESCRIPTION = 'Reply subject, in the same language as the body.'
