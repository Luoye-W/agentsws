/**
 * WP343（决策 859）：「我的助理」派活时**挑哪个岗位 / 职责**——服务进程与模拟世界同一份判据。
 *
 * 只做「按名字认」，不做语义猜测：
 *
 * 1. 模型 / 用户点了岗位名（或 id）→ 认那一个；
 * 2. 没点名 → 看那句话里提到了哪个岗位名、哪条职责名；只认出**一个岗位**才派；
 * 3. 还没有 → 这个人只有一个干活的岗位（不算只有负责人 / 普通成员这类通用职责的岗位）就派给它；
 * 4. 其余一律**拿不准**：不派，回候选（岗位名），由助理问用户一句。
 *
 * 职责可选：点了就在那个岗位里按名字认，认不出就不带（岗位内路由自己分，WP287 那一套）；
 * 只给了职责名没给岗位名时，职责名在全部岗位里只认出一条才算。
 * 递进来的岗位只该是**本人在做的**那些、职责只该是本人名下的（开事项那一步端口里还会再判一次）。
 */

export interface PickPosition {
  /** 岗位模板 id（`social-media`）。 */
  id: string
  name: string
  /** 英文名等别名（可选）。 */
  aliases?: readonly string[]
  /** 本人在这个岗位里持有的职责。 */
  duties: readonly { role_id: string; name: string }[]
}

export interface PickRequest {
  text: string
  position?: string
  duty?: string
}

export type PickResult =
  | { ok: true; position_id: string; role_id?: string; by: 'named' | 'mentioned' | 'only' }
  | { ok: false; reason: string; candidates: string[] }

/** 拿不准时最多列几个候选。 */
export const PICK_MAX_CANDIDATES = 8

/** 名字比较用：小写、去空白与常见分隔符（「Reddit 运营」=「reddit运营」）。 */
export function pickKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s·・•\-_/|、,，.。:：'"「」『』()（）]+/gu, '')
    .trim()
}

const namesOf = (p: PickPosition): string[] =>
  [p.name, p.id, ...(p.aliases ?? [])].map(pickKey).filter((k) => k !== '')

/** 只有通用职责（负责人 / 普通成员）的岗位不当成「干活的岗位」。 */
const isGeneral = (p: PickPosition): boolean =>
  p.duties.length > 0 && p.duties.every((d) => d.role_id.startsWith('common.'))

function matchByName<T>(items: readonly T[], keysOf: (t: T) => string[], want: string): T[] {
  const key = pickKey(want)
  if (key === '') return []
  const exact = items.filter((t) => keysOf(t).includes(key))
  if (exact.length > 0) return exact
  return items.filter((t) => keysOf(t).some((k) => k.includes(key) || key.includes(k)))
}

const dutyKeys = (d: { role_id: string; name: string }): string[] =>
  [d.name, d.role_id].map(pickKey).filter((k) => k !== '')

function dutyIn(p: PickPosition, duty: string | undefined): string | undefined {
  if (duty === undefined || duty.trim() === '') return undefined
  const hit = matchByName(p.duties, dutyKeys, duty)
  return hit.length === 1 ? hit[0]?.role_id : undefined
}

/** 那句话里提到的职责名（只认全名，至少两个字）。 */
function dutyMentioned(p: PickPosition, text: string): string | undefined {
  const key = pickKey(text)
  const hits = p.duties.filter((d) => {
    const k = pickKey(d.name)
    return k.length >= 2 && key.includes(k)
  })
  return hits.length === 1 ? hits[0]?.role_id : undefined
}

export function pickDispatchTarget(
  positions: readonly PickPosition[],
  req: PickRequest,
): PickResult {
  const working = positions.filter((p) => p.duties.length > 0)
  const candidates = (list: readonly PickPosition[]): string[] =>
    list
      .filter((p) => !isGeneral(p))
      .map((p) => p.name)
      .slice(0, PICK_MAX_CANDIDATES)
  if (working.length === 0)
    return { ok: false, reason: '你现在还没有岗位，先建一个岗位再交给它', candidates: [] }

  const done = (
    p: PickPosition,
    by: 'named' | 'mentioned' | 'only',
    role_id?: string,
  ): PickResult => ({
    ok: true,
    position_id: p.id,
    ...(role_id === undefined ? {} : { role_id }),
    by,
  })

  // 1. 点了岗位名
  if (req.position !== undefined && req.position.trim() !== '') {
    const hit = matchByName(working, namesOf, req.position)
    const one = hit[0]
    if (hit.length === 1 && one !== undefined)
      return done(one, 'named', dutyIn(one, req.duty) ?? dutyMentioned(one, req.text))
    return {
      ok: false,
      reason:
        hit.length === 0
          ? `你的岗位里没有「${req.position.trim()}」`
          : `「${req.position.trim()}」对得上好几个岗位`,
      candidates: candidates(hit.length === 0 ? working : hit),
    }
  }

  // 1bis. 只点了职责名：全部岗位里只认出一条才算
  if (req.duty !== undefined && req.duty.trim() !== '') {
    const hits = working.flatMap((p) => {
      const role_id = dutyIn(p, req.duty)
      return role_id === undefined ? [] : [{ p, role_id }]
    })
    const one = hits[0]
    if (hits.length === 1 && one !== undefined) return done(one.p, 'named', one.role_id)
  }

  // 2. 话里提到的岗位名 / 职责名
  const key = pickKey(req.text)
  const byName = working.filter((p) => namesOf(p).some((k) => k.length >= 2 && key.includes(k)))
  const byDuty = working.filter((p) => dutyMentioned(p, req.text) !== undefined)
  const mentioned = byName.length > 0 ? byName : byDuty
  if (mentioned.length === 1) {
    const one = mentioned[0] as PickPosition
    return done(one, 'mentioned', dutyIn(one, req.duty) ?? dutyMentioned(one, req.text))
  }
  if (mentioned.length > 1)
    return {
      ok: false,
      reason: '这句话对得上好几个岗位',
      candidates: candidates(mentioned),
    }

  // 3. 只有一个干活的岗位
  const real = working.filter((p) => !isGeneral(p))
  const only = real[0]
  if (real.length === 1 && only !== undefined)
    return done(only, 'only', dutyIn(only, req.duty) ?? dutyMentioned(only, req.text))

  // 4. 拿不准
  return {
    ok: false,
    reason: real.length === 0 ? '你现在还没有干活的岗位' : '没看出该交给哪个岗位',
    candidates: candidates(working),
  }
}
