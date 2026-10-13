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
    : { assignment_id: chosen.assignment_id, workspace_id: chosen.workspace_id }
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
