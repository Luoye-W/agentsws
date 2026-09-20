/**
 * WP120（69 §3 第 3 条）：stub 运行时**按职责选剧本**。
 *
 * WP117 已经在 stub 里开了第一个岔口（`kolBranch`）——红人岗位不再掉进客服那条路。
 * 这个文件把那个岔口变成**通用机制**，并且补上它缺的那一半：
 *
 * > 没有剧本的域回一句人话、**不产生任何卡**——绝不再拿客服剧本兜底。
 *
 * 为什么这一半比岔口本身还要紧：`kolBranch` 修好的是红人这一条，剩下的
 * 三十多条职责（店铺管理、社媒、投放、设计、建站、公关）**仍然**掉在客服那条路上。
 * 让投放岗位在演示里问一句退货窗口，与 69 §0 那条亲测记录是同一个毛病，
 * 只是还没有人去点它。
 *
 * **不是门禁**：这里判的是"演示里这条职责该走哪套桩"，不判权限、不拦任何东西。
 * 真运行时（direct / dsh）由模型自己读 persona 决定怎么做，不经这个文件。
 */

/** stub 手里有哪几套剧本。`undefined` = 这条职责在演示里还没有剧本。 */
export type PlaybookId = 'support' | 'kol'

/**
 * **域 → 剧本**（69 §3：按 `role.domain` 选）。
 *
 * 只有两个域进得来，因为 stub 手里也只有两套桩：
 * - `amz`：这个域里只有 `amz.support` 一条，就是客服；
 * - `kol`：五条渠道职责，剧本在 `kol-core`（WP117）。
 *
 * **`dtc` 故意不在这张表里**。它是唯一一个"一个域里两种活"的域：客服那三条
 * （`dtc.support` / `dtc.live-chat` / `dtc.community-support`）与运营那四条
 * （店铺、内容、邮件、履约）。整域映射到客服剧本，等于让店铺管理去问退货窗口——
 * 正是这一单要拆掉的那种串岗。所以它走下面那张按职责的表。
 */
const PLAYBOOK_BY_DOMAIN: Readonly<Record<string, PlaybookId>> = {
  amz: 'support',
  kol: 'kol',
}

/**
 * **职责 → 剧本**：域粒度不够时的那几条（现在只有 `dtc` 里的客服三条）。
 *
 * 这张表**只能加客服那种"域里分不开"的情形**，不是一个"想让谁走客服就加谁"的口子：
 * 加一条进来等于说"这条职责在演示里就是客服"，而那正是 69 §0 那个错误的形状。
 */
const PLAYBOOK_BY_ROLE: Readonly<Record<string, PlaybookId>> = {
  'dtc.support': 'support',
  'dtc.live-chat': 'support',
  'dtc.community-support': 'support',
}

/** 职责 id 的域（`kol.youtube` → `kol`）。 */
export function domainOfRole(role_id: string): string {
  const dot = role_id.indexOf('.')
  return dot < 0 ? role_id : role_id.slice(0, dot)
}

/**
 * 这条职责在 stub 里走哪套剧本。回 `undefined` = 还没有剧本。
 *
 * 判据只有 `role_id`——**不看意图词**。一件事被岗位路由落到这条职责上之后，
 * 它就是这条职责的活（与 `kolBranch` 逐字同一条纪律）。看意图词的后果是
 * 一句带"退款"两个字的话又会把投放岗位拽回客服那条路。
 */
export function playbookOf(role_id: string): PlaybookId | undefined {
  return PLAYBOOK_BY_ROLE[role_id] ?? PLAYBOOK_BY_DOMAIN[domainOfRole(role_id)]
}

/** 域的人话名字（那句"还没有剧本"里要说清是哪一摊）。 */
const DOMAIN_ZH: Readonly<Record<string, string>> = {
  dtc: '独立站运营',
  amz: 'Amazon',
  social: '社媒运营',
  kol: '红人营销',
  ads: '投放',
  design: '设计',
  dev: '建站',
  pr: '公共关系',
  common: '通用',
}

/**
 * 没有剧本时回给人的那一句（36 §3「算不出就说没有」）。
 *
 * 三条纪律：
 * 1. **说清是哪条职责**——"演示里还没有剧本"这句话只有带上职责名才有用；
 * 2. **说清这是演示的限制，不是这条职责做不了**——真模型下它照样干活；
 * 3. **不出任何卡、不 stage、不起草**。出一张"请批准"的卡去问一件桩根本没做的事，
 *    比什么都不做糟得多。
 */
export function noPlaybookAnswer(role_id: string, role_name?: string): string {
  const domain = DOMAIN_ZH[domainOfRole(role_id)] ?? domainOfRole(role_id)
  const who = role_name === undefined || role_name === '' ? role_id : role_name
  return [
    `这条职责（${who}，${domain}）在演示里还没有剧本，所以这一次我没有动手。`,
    '这是演示环境的限制，不是这条职责做不了——接上真模型之后它照常工作。',
    '我也没有出任何待你批的卡：一张问不出所以然的卡比没有更麻烦。',
  ].join('\n')
}

/** 没有剧本时那次运行的摘要（进事项时间线与下一次运行的上下文）。 */
export function noPlaybookSummary(role_id: string): string {
  return `${role_id} 在演示里还没有剧本：没有调工具、没有起草、没有出卡`
}
