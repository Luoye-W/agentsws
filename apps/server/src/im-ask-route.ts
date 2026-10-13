/**
 * WP306：IM 里问一句话，**问谁**（这个人的哪一条分配、哪个品牌）。
 *
 * 以前一律取「这个品牌里第一条没撤的分配」——负责人的第一条多半是 `common.owner`，
 * 问「Reddit 运营今天有没有要我处理的」也落到负责人那条上。现在：
 *
 * 1. 问题里**点了名**（岗位名 / 职责名 / 渠道名，如「Reddit 运营」「Reddit」）→ 找这个人
 *    在**任一品牌**里对得上的那条分配；点名越长越具体越优先；
 * 2. 同名的在好几个品牌里都有 → 问题里带了品牌名就按品牌名；否则优先机器人所在的品牌，
 *    再不然按品牌顺序取第一个，并在答案后面补一句「这次按哪个品牌答的」；
 * 3. 一个都点不出 → 机器人所在品牌里他的**主要岗位**（第一条干活的分配，负责人 / 成员这两条
 *    底座职责排后面）；那个品牌里一条都没有就用别的品牌的；
 * 4. 哪儿都没有 → `undefined`（调用方回一句「你还没有岗位」）。
 *
 * 纯函数：候选由服务端装配（`server.ts`）给，这里不碰存储，测试直接喂数组。
 */

import { channelOfRole, channelPositionName } from '@agentsws/contracts'
import { classifyEntryIntent, looksLikeSmallTalk } from '@agentsws/roles'

/** 一条候选分配（服务端装配好的，带上能被点名的那几个名字）。 */
export interface ImAskCandidate {
  assignment_id: string
  workspace_id: string
  role_id: string
  /** 品牌名（问题里带了它就按它挑）。 */
  brand_name?: string
  /** 能被点名的名字：岗位名、职责中文名 / 英文名、渠道岗位默认名（「Reddit 运营」）、渠道名。 */
  labels: readonly string[]
}

export interface ImAskPick {
  assignment_id: string
  workspace_id: string
  /** WP308：这条分配的职责（底座职责 `common.*` 不是岗位，问不了岗位 Agent）。 */
  role_id?: string
  /** 点名命中的那个名字（没点名就没有）。 */
  matched?: string
  /** 同名岗位在好几个品牌都有、这次替他挑了一个：给人看的那一句补充。 */
  note?: string
}

/** 底座职责（负责人 / 成员）：没点名时排在干活的职责后面。 */
const BASE_ROLES = new Set(['common.owner', 'common.member'])

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, '')

/** 名字太短（一个字母、一个汉字）容易误命中，不算点名。 */
const usable = (label: string): boolean => norm(label).length >= 2

export function pickImAssignment(input: {
  candidates: readonly ImAskCandidate[]
  question: string
  /** 机器人所在的品牌。 */
  home_workspace_id: string
}): ImAskPick | undefined {
  const { candidates, home_workspace_id } = input
  if (candidates.length === 0) return undefined
  const q = norm(input.question)

  // ① 点名：每条候选取它命中的最长名字
  const hits: { c: ImAskCandidate; label: string; len: number }[] = []
  for (const c of candidates) {
    let best: string | undefined
    for (const label of c.labels) {
      if (!usable(label) || !q.includes(norm(label))) continue
      if (best === undefined || norm(label).length > norm(best).length) best = label
    }
    if (best !== undefined) hits.push({ c, label: best, len: norm(best).length })
  }
  if (hits.length > 0) {
    const top = Math.max(...hits.map((h) => h.len))
    let pool = hits.filter((h) => h.len === top)
    // ② 品牌：问题里带了品牌名就按它
    const named = pool.filter(
      (h) =>
        h.c.brand_name !== undefined && usable(h.c.brand_name) && q.includes(norm(h.c.brand_name)),
    )
    if (named.length > 0) pool = named
    const brands = [...new Set(pool.map((h) => h.c.workspace_id))]
    const home = pool.filter((h) => h.c.workspace_id === home_workspace_id)
    const chosen = (home.length > 0 ? home : pool)[0]
    if (chosen === undefined) return undefined
    const note =
      brands.length > 1 && named.length === 0
        ? `（你在${brands
            .map((ws) => `「${pool.find((h) => h.c.workspace_id === ws)?.c.brand_name ?? ws}」`)
            .join(
              '、',
            )}都有「${chosen.label}」，这次按「${chosen.c.brand_name ?? chosen.c.workspace_id}」答的；想问别的品牌，在问题里带上品牌名。）`
        : undefined
    return {
      assignment_id: chosen.c.assignment_id,
      workspace_id: chosen.c.workspace_id,
      role_id: chosen.c.role_id,
      matched: chosen.label,
      ...(note === undefined ? {} : { note }),
    }
  }

  // ③ 没点名：机器人所在品牌的主要岗位，没有再看别的品牌
  const primary = (list: readonly ImAskCandidate[]): ImAskCandidate | undefined =>
    list.find((c) => !BASE_ROLES.has(c.role_id)) ?? list[0]
  const chosen =
    primary(candidates.filter((c) => c.workspace_id === home_workspace_id)) ?? primary(candidates)
  return chosen === undefined
    ? undefined
    : {
        assignment_id: chosen.assignment_id,
        workspace_id: chosen.workspace_id,
        role_id: chosen.role_id,
      }
}

/**
 * 一条分配能被点名的那几个名字：岗位名（公司页上起的）、职责的中英文名、
 * 渠道职责的默认岗位名（`pr.reddit` → 「Reddit 运营」/ "Reddit Ops"）与渠道名（「Reddit」）。
 */
export function imAskLabels(input: {
  role_id: string
  role_zh?: string
  role_en?: string
  position?: string
}): string[] {
  const out = new Set<string>()
  for (const v of [input.position, input.role_zh, input.role_en])
    if (v !== undefined && v.trim() !== '') out.add(v.trim())
  const channel = channelOfRole(input.role_id)
  if (channel !== undefined) {
    out.add(channelPositionName(channel, 'zh'))
    const en = channelPositionName(channel, 'en')
    out.add(en)
    out.add(en.replace(/ Ops$/, ''))
  }
  return [...out]
}

/* ------------------------------------------------------------------ */
/* WP308（决策 447）：问秘书，还是直接问岗位 Agent                       */
/* ------------------------------------------------------------------ */

/**
 * 一句话落到哪：
 * - `secretary`：闲聊 / 个人的事（日程、约人、请假…）/ 没有岗位可问——走秘书（WP306 的老路）；
 * - `position_ask`：工作问题——直接问那个岗位的 Agent（只读，当场答一句 + 去工作台的链接）；
 * - `position_task`：要动手的交代（「帮我回一下这封邮件」）——在那个岗位建任务，聊天里只回「已记成任务」。
 */
export type ImAskTarget = 'secretary' | 'position_ask' | 'position_task'

/** 个人的事：秘书管（41 §1：替人答「他在忙什么、什么时候有空」、约时间）。 */
const PERSONAL =
  /(日程|日历|会议|开会|约(个|一下|下)?时间|约一下|有空|空闲|请假|休假|出差|生日|提醒我|我的(安排|时间)|谁有空|几点)/u

/** 没点名时，像是在问工作的词（问的是活、卡、单子、进度，而不是人）。 */
const WORK =
  /(要我|需要我|等我|待办|待处理|处理|审批|卡|进展|进度|在办|在做|在忙|任务|工作|订单|客户|询盘|帖子|评论|邮件|库存|商品|产品|店铺|广告|红人|达人|发货|退款|退货|数据|销量|流量|排期|报表|日报)/u

/**
 * 「今天有没有要我处理的 / 在忙什么 / 进展怎么样」——问的就是这个岗位今天的状况。
 * 这一类直接用岗位今天的摘要答（卡 / 待办 / 进行中 / 最近记录），不用再起一次模型。
 */
const STATUS =
  /(要我|需要我|等我|待办|待处理|要处理|在忙|忙什么|忙啥|进展|进度|怎么样了|做到哪|有什么事|有啥事|有没有事|有什么要|今天.{0,6}(安排|情况|工作|怎么样))/u

export function isPositionStatusQuestion(question: string): boolean {
  return STATUS.test(question.normalize('NFKC'))
}

export function imAskTarget(input: {
  question: string
  /** 挑中的那条分配的职责；没有 = 退回了老的 `assignmentOf`（不知道职责）。 */
  role_id?: string
  /** 问题里点了岗位 / 职责 / 渠道名。 */
  named: boolean
}): ImAskTarget {
  const q = input.question.normalize('NFKC').trim()
  // 底座职责（负责人 / 成员）不是岗位：只有秘书可问
  if (input.role_id === undefined || BASE_ROLES.has(input.role_id)) return 'secretary'
  if (q === '' || looksLikeSmallTalk(q)) return 'secretary'
  if (!input.named && PERSONAL.test(q)) return 'secretary'
  const intent = classifyEntryIntent(q)
  if (intent.intent === 'task') return input.named || WORK.test(q) ? 'position_task' : 'secretary'
  if (input.named || WORK.test(q)) return 'position_ask'
  return 'secretary'
}
