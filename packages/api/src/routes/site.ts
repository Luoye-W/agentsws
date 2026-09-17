/**
 * WP77（59 §1 / §2）：**建站那一侧的 `/v1` 面**（最小一组）。
 *
 * 照 `social.ts` 的写法，但故意只开五条——59 §5 派的是骨架，不是整套后台：
 * 跑一次上线检查单、列 / 改邮件模板、列 App / 提一条装 App。其余（改设置批、
 * 改主题、改 App 配置）走既有的审批与执行器那条路，不必在这一层各开一个口子。
 *
 * 三条纪律，每条都在类型上看得见：
 *
 * 1. **一个对象域一把闸**。检查单与 App 落在 `store_config`，邮件模板落在
 *    `content`。这不是形式主义：`site.shopify-email` 的 yml 里 `store_config`
 *    是**只读**的，所以 `POST /v1/site/apps` 对它天然是 403，不用在路由里写 if。
 * 2. **写动作永远先出卡**。改模板 → `email_template_edit`（草稿 L2 / 启用 L1）、
 *    装 App → `app_install`（永远 L1）。这里一条都不直接改库。
 *    跑检查单也出卡（`launch_check`，L3）——14 的老规矩：所有 Agent 主动做的事
 *    都进同一条队列，只是它不进人的待办。
 * 3. **结账 / 支付 / 税一个口子都没有**（51 §1 N0 / §3 N2）。检查单**说得出**
 *    那两项缺什么，这一层**改不了**它们——两件事在返回值上分得开（`fixable_by` 为空）。
 */
import type {
  LaunchCheckRun,
  MaybePromise,
  ShopAppRecord,
  ShopEmailTemplate,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'
import type { SiteActor } from './site-types.js'

/* ── 鉴权元组：两个对象域各一把闸（31 §3.1 完整元组） ─────────────────── */

const READ_STORE = {
  domain: 'store_config',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE_STORE = { ...READ_STORE, op: 'stage' } as const
const READ_CONTENT = {
  domain: 'content',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE_CONTENT = { ...READ_CONTENT, op: 'stage' } as const

/* ── 视图 ─────────────────────────────────────────────────────────────── */

/**
 * 提了一条变更之后回来的那一份（照 `SocialStagedView`）。
 *
 * `staged` 为假 = guardrail 拦了，`message` 是那句人话。**不抛异常**：
 * 被拦下来是正常结果之一（缺变量的模板就是这种），界面要照实显示。
 */
export interface SiteStagedView {
  staged: boolean
  change_id?: string
  approval_item_id?: string
  message?: string
  /** 这次提上去时的等级（硬顶按回来的话这里就是 L1）。 */
  level?: string
}

/** 跑完一次检查单回来的那一份。 */
export interface SiteChecklistView {
  run: LaunchCheckRun
  /** 那张检查单卡（L3——它什么都不改）。 */
  staged: SiteStagedView
}

/** 改一份模板之后回来的那一份。 */
export interface SiteEmailTemplateView {
  template: ShopEmailTemplate
  /**
   * 起草时的自查（`@agentsws/site-core` 的 `checkEmailTemplate`）。
   *
   * 不为空 = **没提上去**：缺变量的稿提上去也会被 guardrail 当场 block，
   * 早点说比让模型反复试便宜（同 `SocialBroadcastView.problems`）。
   */
  problems: string[]
  /** 变量填进去之后读起来是什么样（卡面上那份材料）。 */
  preview: string
  staged: SiteStagedView
}

/** App 清单上的一行。比 {@link ShopAppRecord} 多一格"装了却还没连"。 */
export interface SiteAppRow extends ShopAppRecord {
  /** `true` = 装上了，但连接目录里那张卡还没连（59 §2 那条接缝）。 */
  connectable: boolean
}

/* ── 端口 ─────────────────────────────────────────────────────────────── */

export interface SiteEmailTemplateInput {
  notification_type: string
  subject: string
  /** Liquid 正文。 */
  body: string
  /** `true` = 提的是"以后就发这一份"（L1）；`false` = 草稿（L2）。 */
  enabled: boolean
}

export interface SiteAppInstallInput {
  app_id: string
  operation: 'install' | 'uninstall'
  reason?: string | undefined
}

export interface SitePort {
  /**
   * 跑一次上线检查单。
   *
   * 只读巡检——它**什么都不改**，但照样出一张卡（L3）：14 的老规矩，
   * 所有 Agent 主动做的事都进同一条队列。
   */
  runChecklist(actor: SiteActor): MaybePromise<SiteChecklistView>
  /** 上一次巡检的结论（没跑过就没有）。 */
  lastChecklist(actor: SiteActor): MaybePromise<{ run?: LaunchCheckRun }>

  emailTemplates(actor: SiteActor): MaybePromise<{ rows: ShopEmailTemplate[] }>
  /**
   * 改一份模板并提上去（`email_template_edit`）。
   *
   * **草稿 L2，启用 L1**：`enabled` 原样进 `after`，分档在 guardrail 上。
   */
  draftEmailTemplate(
    actor: SiteActor,
    input: SiteEmailTemplateInput,
  ): MaybePromise<SiteEmailTemplateView>

  apps(actor: SiteActor): MaybePromise<{ rows: SiteAppRow[] }>
  /** 提一条装 / 卸 App（`app_install`，**永远 L1**）。 */
  proposeApp(actor: SiteActor, input: SiteAppInstallInput): MaybePromise<SiteStagedView>
}

/* ── 装配 ─────────────────────────────────────────────────────────────── */

function portOf(deps: GatewayDeps): SitePort {
  const p = deps.site
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配建站数据面（GatewayDeps.site）。建站那四条职责要它才动得了。',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): SiteActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

const EmailTemplateBody = z.object({
  notification_type: z.string().min(1).max(100),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(200_000),
  enabled: z.boolean(),
})

const AppInstallBody = z.object({
  app_id: z.string().min(1).max(200),
  operation: z.enum(['install', 'uninstall']),
  reason: z.string().max(500).optional(),
})

export function siteRoutes(): Route[] {
  return [
    route(
      {
        method: 'post',
        path: '/v1/site/checklist/run',
        operationId: 'runLaunchChecklist',
        summary:
          '跑一次上线检查单（59 §2）。只读巡检，什么都不改；支付与税那两项只说得出缺什么，改不了（51 §3 N2）',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_STORE,
        returns: 'SiteChecklistView',
      },
      async (c, deps) => ok(c, await portOf(deps).runChecklist(actorOf(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/site/checklist',
        operationId: 'getLaunchChecklist',
        summary: '上一次巡检的结论。没跑过就没有——**不现算一份**（那会让"上次什么时候查的"说不清）',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: READ_STORE,
        returns: '{ run?: LaunchCheckRun }',
      },
      async (c, deps) => ok(c, await portOf(deps).lastChecklist(actorOf(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/site/email-templates',
        operationId: 'listSiteEmailTemplates',
        summary: '通知邮件模板的现状（订单确认 / 发货 / 退款 …），带"缺哪几个必需变量"',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: READ_CONTENT,
        returns: '{ rows: ShopEmailTemplate[] }',
      },
      async (c, deps) => ok(c, await portOf(deps).emailTemplates(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/site/email-templates',
        operationId: 'draftSiteEmailTemplate',
        summary:
          '改一份通知邮件模板并提上去。草稿 L2、启用 L1；Liquid 缺必需变量一律拦下（不给"人点一下就发"的路）',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        body: EmailTemplateBody,
        returns: 'SiteEmailTemplateView',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).draftEmailTemplate(actorOf(c), await body(c, EmailTemplateBody)),
          201,
        ),
    ),
    route(
      {
        method: 'get',
        path: '/v1/site/apps',
        operationId: 'listSiteApps',
        summary:
          '店里装了哪些 App（目录里没有的那些也列出来）+ 哪几个装了却还没连上 API（59 §2 那条接缝）',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: READ_STORE,
        returns: '{ rows: SiteAppRow[] }',
      },
      async (c, deps) => ok(c, await portOf(deps).apps(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/site/apps',
        operationId: 'proposeSiteApp',
        summary: '提一条装 / 卸 App。**永远 L1**——装一个 App 是把店里的数据交给另一家公司',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_STORE,
        body: AppInstallBody,
        returns: 'SiteStagedView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).proposeApp(actorOf(c), await body(c, AppInstallBody)), 201),
    ),
  ]
}
