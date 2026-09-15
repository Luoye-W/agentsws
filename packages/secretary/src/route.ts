/**
 * 任务路由（41 §1.2 第三行、06 §2.4「职责分类表就是路由词典」）。
 *
 * 秘书不问"这条给谁"，问"**这条属于哪个职责**"，然后查分配表找持有人。判据全部来自
 * 04 / 05 的职责定义本身：名字、`description` 里那串"管什么"、`grounding` 的意图词、
 * `actions` 的动作 id、`scopes` 的数据域。所以公司改了职责定义，路由跟着变，不用改代码。
 *
 * 两条纪律：
 * - **秘书不执行专业动作**：路由结果是提议，认领才成立（06 §2、31 I13）。
 * - **分不清就当成一件活**：出一张等人认领的卡，比替人回答一个专业问题安全。
 */
import type { PersonId } from '@agentsws/contracts'
import {
  ACTION_TERMS as ROLE_ACTION_TERMS,
  DOMAIN_TERMS as ROLE_DOMAIN_TERMS,
  GENERIC_ROLES as ROLE_GENERIC_ROLES,
  SHORT_TERM_PENALTY as ROLE_SHORT_TERM_PENALTY,
  ROUTE_WEIGHT,
  roleRouteTerms,
  scoreRouteRoles,
} from '@agentsws/roles'
import { looksLikeQuestion } from './text.js'
import type { RoleProfile, RoleTerm, RouteScore, RouteVerdict } from './types.js'

/**
 * WP69（54 §2）：**判据搬去了 `@agentsws/roles` 的 `route.ts`**。
 *
 * 搬家的理由在那个文件的头注里：同一套判据现在有两个用处（秘书路由、岗位内路由），
 * 两处各写一套就会出现"同一句话在秘书那里进售后、在岗位页里进店铺管理"。
 * 判据本来就该和职责定义住在一起。
 *
 * 这里保留的是**秘书这一侧的事**：问句判断、置信度算法、认领车道的那句话。
 * 下面这几个名字原样导出（外面的导入一个字没改），值就是职责包里那一份。
 */
export const WEIGHT = ROUTE_WEIGHT
export const SHORT_TERM_PENALTY = ROLE_SHORT_TERM_PENALTY
export const DOMAIN_TERMS = ROLE_DOMAIN_TERMS
export const ACTION_TERMS = ROLE_ACTION_TERMS
export const GENERIC_ROLES = ROLE_GENERIC_ROLES

/** 置信度低于它就不下判断，进"没有主人"的车道（06 §2.4 最后一行）。 */
export const MIN_CONFIDENCE = 0.25

/**
 * 结构类型：调用方把职责定义按这个形状递过来即可。
 * （实体定义在 `@agentsws/roles` 的 `RouteRoleLike`，这里按同形重声明，免得外面改导入。）
 */
export interface RoleLike {
  id: string
  name?: { zh?: string; en?: string } | undefined
  description?: string | undefined
  grounding?: readonly { intent_terms?: readonly string[]; cue_terms?: readonly string[] }[]
  actions?: readonly { id: string }[]
  scopes?: readonly { domain: string }[]
}

/** 从一份职责定义里抽出全部判据词（去重，保留来源与权重）。 */
export function roleTermsOf(role: RoleLike): RoleTerm[] {
  return roleRouteTerms(role) as RoleTerm[]
}

export interface RouteInput {
  text: string
  roles: readonly RoleProfile[]
  /** 秘书是谁的（他自己持有的岗位优先命中时不算"路由给别人"，只用于解释） */
  me?: PersonId
}

/**
 * 给每个职责打分：命中的判据词权重之和。
 * WP69：算法在 `@agentsws/roles` 的 `scoreRouteRoles`（同一份判据，行为一个字没变）。
 */
export function scoreRoles(text: string, roles: readonly RoleProfile[]): RouteScore[] {
  return scoreRouteRoles(text, roles)
}

/**
 * 判断这件事该谁做。
 *
 * `confidence` = 第一名的分数占前两名之和的比例（一骑绝尘 → 接近 1；两个职责难分 → 接近 0.5），
 * 再乘一个"命中够不够多"的系数。低于 {@link MIN_CONFIDENCE} 就不指名——06 §2.4 说得清楚：
 * 置信度不够时进"未认领"车道，而不是猜。
 */
export function routeTask(input: RouteInput): RouteVerdict {
  const kind = looksLikeQuestion(input.text) ? 'question' : 'task'
  const scores = scoreRoles(input.text, input.roles)
  const first = scores[0]
  if (first === undefined)
    return {
      kind,
      confidence: 0,
      reason: '代理判断：看不出这属于哪个岗位，先进"没人认领"的车道',
      scores,
    }
  const second = scores[1]?.score ?? 0
  const separation = first.score / (first.score + second)
  // 命中一个硬判据词（动作 id 那一档，权重 2）就够"有把握"了；再多只是更有把握
  const strength = Math.min(1, first.score / 3)
  const confidence = Math.round(separation * strength * 100) / 100
  const role = input.roles.find((r) => r.role_id === first.role_id)
  const holder = role?.positions[0]
  const why = first.matched
    .slice(0, 3)
    .map((m) => `「${m}」`)
    .join('、')
  if (confidence < MIN_CONFIDENCE)
    return {
      kind,
      confidence,
      reason: `代理判断：像是${first.role_name}的活（${why}），但不够有把握，先进"没人认领"的车道`,
      scores,
    }
  return {
    kind,
    role_id: first.role_id,
    role_name: first.role_name,
    confidence,
    reason:
      kind === 'question'
        ? `代理判断：这是${first.role_name}的专业问题（${why}），代理不答，转给岗位`
        : `代理判断：${first.role_name}，因为你说了${why}`,
    scores,
    ...(holder === undefined ? {} : { position_id: holder.position_id, owner: holder.person_id }),
  }
}
