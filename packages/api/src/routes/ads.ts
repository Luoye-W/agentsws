/**
 * WP75（57 §5 数据面）：**广告库的 `/v1` 面**（最小一套）。
 *
 * 读两条（账户、campaign），写五条——57 §1 那五个动作各一条。照 `social.ts`
 * 的写法，四条纪律在类型上看得见：
 *
 * 1. **写动作永远先出卡**。这个文件里**没有一处直接改库、也没有一处打平台**：
 *    五个写口子全部经 `ledger.stage` 走 guardrail，回来的是一张卡的 id。
 *    真正动到账户是执行器在卡被批准之后做的事（04 §5：开花钱口子永远 L1）。
 * 2. **一个对象域一把闸**。账户 / campaign / 广告组 / 广告都走 `ad_account`
 *    （广告树上从账户到一条广告是同一把闸）；像素**另一把**（`pixel_event`，
 *    只读）——那是"投放看得见、改不动"这句话在 19 §3 过滤下推里真的切得出来的一刀。
 * 3. **被 guardrail 拦下来不是异常**。{@link AdsStagedView} 的 `staged: false`
 *    带着那句人话（总闸满了、文案里有承诺、止损判据不成立），界面照实显示
 *    而不是弹一个红框。
 * 4. **钱的单位是元**。适配器那一层各家的「分」「微」在 `@agentsws/ads-core`
 *    里进出各转一次；这条边界上一律是元。
 */
import type { AdAccount, AdCampaign, AdsPlatform, MaybePromise } from '@agentsws/contracts'
import { AD_PAUSE_REASONS, ADS_PLATFORM_IDS } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'
import type { AdsActor } from './ads-types.js'

/* ── 鉴权元组（纪律 2）─────────────────────────────────────────────── */

const READ_ADS = {
  domain: 'ad_account',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE_ADS = { ...READ_ADS, op: 'stage' } as const

/* ── 视图 ─────────────────────────────────────────────────────────── */

/** 清单上的一行账户（就是契约里那个对象——这一层不加工）。 */
export type AdsAccountRow = AdAccount
/** 清单上的一行 campaign。多一格账户名——表格上要认得出是哪个账户。 */
export interface AdsCampaignRow extends AdCampaign {
  account_name: string
}

/**
 * 提了一条改动之后回来的那一份（照 `SocialStagedView`）。
 *
 * `staged` 为假 = guardrail 拦了，`message` 是那句人话。**不抛异常**（纪律 3）。
 */
export interface AdsStagedView {
  staged: boolean
  change_id?: string
  approval_item_id?: string
  /** 被拦下来 / 提上去的那句话。 */
  message?: string
  /** 这次提上去时的等级（硬顶按回来的话这里就是 L1）。 */
  level?: string
  /**
   * 岗位级日花费总闸当时的样子（04 §5）。
   *
   * **每一条写动作都带回来**，不只是提预算那一条：人点头之前要看得见
   * "今天还剩多少"，而那个数与他正在批的这一条是同一时刻的。
   */
  spend_gate?: { spent: number; cap: number; remaining: number; note: string }
}

export interface AdsPort {
  accounts(
    actor: AdsActor,
    filter: { platform?: AdsPlatform | undefined },
  ): MaybePromise<{ rows: AdsAccountRow[] }>
  campaigns(
    actor: AdsActor,
    filter: { platform?: AdsPlatform | undefined; account_id?: string | undefined },
  ): MaybePromise<{ rows: AdsCampaignRow[] }>

  /**
   * 新建 / 复制一条 campaign（`create_campaign`，**永远 L1**）。
   *
   * 总闸已经满了的时候 guardrail 直接 block，不是让人点一下——那等于把今天的
   * 预算上限就地作废（04 §5「超过即熔断」）。
   */
  createCampaign(
    actor: AdsActor,
    input: {
      account_id: string
      name: string
      daily_budget: number
      objective?: string | undefined
      audience_summary?: string | undefined
    },
  ): MaybePromise<AdsStagedView>
  /** 改预算（`budget_change`）：超 `max_budget_delta_pct` 或会破总闸 → 升 L1。 */
  changeBudget(
    actor: AdsActor,
    campaign_id: string,
    input: { value: number; reason?: string | undefined },
  ): MaybePromise<AdsStagedView>
  /** 改出价（`bid_change`）：超 `max_bid_delta_pct` → 升 L1。 */
  changeBid(
    actor: AdsActor,
    campaign_id: string,
    input: { value: number; ad_set_id?: string | undefined; reason?: string | undefined },
  ): MaybePromise<AdsStagedView>
  /**
   * 暂停（`pause_ad`）。
   *
   * 只有 `reason: 'stop_loss'` **且判据真的成立**才走 L3 那一档；写着止损
   * 但 ROAS 与花费两格不成立的，guardrail 转人审。
   */
  pauseCampaign(
    actor: AdsActor,
    campaign_id: string,
    input: { reason: string; note?: string | undefined },
  ): MaybePromise<AdsStagedView>
  /** 换素材 / 换文案（`creative_swap`）：新文案过承诺扫描，受众与账户是受保护字段。 */
  swapCreative(
    actor: AdsActor,
    ad_id: string,
    input: {
      creative_ref?: string | undefined
      headline?: string | undefined
      primary_text?: string | undefined
    },
  ): MaybePromise<AdsStagedView>
}

/* ── 装配 ─────────────────────────────────────────────────────────── */

function portOf(deps: GatewayDeps): AdsPort {
  const p = deps.ads
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配广告库（GatewayDeps.ads）。投放那四条职责要它才动得了。',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): AdsActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

/** `?platform=` 只认契约里那四个；写别的当场 400（**不悄悄退成"全部"**）。 */
function platformQuery(c: Parameters<typeof principalOf>[0]): AdsPlatform | undefined {
  const raw = c.req.query('platform')
  if (raw === undefined || raw === '') return undefined
  const found = ADS_PLATFORM_IDS.find((p) => p === raw)
  if (found === undefined) throw new ApiError('invalid_input', `不认识这个平台：${raw}`)
  return found
}

const CampaignBody = z.object({
  account_id: z.string().min(1),
  name: z.string().min(1).max(200),
  /** 日预算（**元**，纪律 4）。 */
  daily_budget: z.number().positive(),
  objective: z.string().min(1).max(100).optional(),
  /** 投给谁，一句话。卡面上人要看得见（36 §2）。 */
  audience_summary: z.string().max(2000).optional(),
})

const AmountBody = z.object({
  /** 改成多少（**元**）。 */
  value: z.number().nonnegative(),
  ad_set_id: z.string().min(1).max(200).optional(),
  reason: z.string().max(500).optional(),
})

const PauseBody = z.object({
  /** 封闭的一组（契约 `AD_PAUSE_REASONS`）：写不出理由的暂停 guardrail 直接拦。 */
  reason: z.enum(AD_PAUSE_REASONS),
  note: z.string().max(500).optional(),
})

const CreativeBody = z.object({
  creative_ref: z.string().min(1).max(200).optional(),
  headline: z.string().max(200).optional(),
  primary_text: z.string().max(5000).optional(),
})

export function adsRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/ads/accounts',
        operationId: 'listAdAccounts',
        summary: '广告账户（57 §1）。一个账户是一个独立的计费主体——按 platform 筛出自己那条职责的',
        tag: 'ads',
        auth: 'bearer',
        assignment: true,
        authz: READ_ADS,
        params: [{ name: 'platform', in: 'query', description: '只看这个平台' }],
        returns: '{ rows: AdsAccountRow[] }',
      },
      async (c, deps) => {
        const platform = platformQuery(c)
        return ok(
          c,
          await portOf(deps).accounts(actorOf(c), {
            ...(platform === undefined ? {} : { platform }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/ads/campaigns',
        operationId: 'listAdCampaigns',
        summary: 'campaign 清单（带上次拉到的花费与 ROAS；数字原样端出去，不在这里现算）',
        tag: 'ads',
        auth: 'bearer',
        assignment: true,
        authz: READ_ADS,
        params: [
          { name: 'platform', in: 'query', description: '只看这个平台' },
          { name: 'account_id', in: 'query', description: '只看这个账户' },
        ],
        returns: '{ rows: AdsCampaignRow[] }',
      },
      async (c, deps) => {
        const platform = platformQuery(c)
        const account_id = c.req.query('account_id')
        return ok(
          c,
          await portOf(deps).campaigns(actorOf(c), {
            ...(platform === undefined ? {} : { platform }),
            ...(account_id === undefined || account_id === '' ? {} : { account_id }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/ads/campaigns',
        operationId: 'stageAdCampaign',
        summary:
          '提一条新建 campaign（04 §5：开花钱口子**永远 L1**；总闸满了直接拦，不给"点一下就过"的路）',
        tag: 'ads',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_ADS,
        body: CampaignBody,
        returns: 'AdsStagedView',
      },
      async (c, deps) => {
        const input = await body(c, CampaignBody)
        return ok(
          c,
          await portOf(deps).createCampaign(actorOf(c), {
            account_id: input.account_id,
            name: input.name,
            daily_budget: input.daily_budget,
            ...(input.objective === undefined ? {} : { objective: input.objective }),
            ...(input.audience_summary === undefined
              ? {}
              : { audience_summary: input.audience_summary }),
          }),
          201,
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/ads/campaigns/:id/budget',
        operationId: 'stageAdBudgetChange',
        summary: '提一条改预算（超额度或会破日花费总闸 → 升 L1；调低预算不受这两条卡）',
        tag: 'ads',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_ADS,
        params: [{ name: 'id', in: 'path', description: 'campaign id', required: true }],
        body: AmountBody,
        returns: 'AdsStagedView',
      },
      async (c, deps) => {
        const input = await body(c, AmountBody)
        return ok(
          c,
          await portOf(deps).changeBudget(actorOf(c), param(c, 'id'), {
            value: input.value,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          }),
          201,
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/ads/campaigns/:id/bid',
        operationId: 'stageAdBidChange',
        summary: '提一条改出价（超额度 → 升 L1）',
        tag: 'ads',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_ADS,
        params: [{ name: 'id', in: 'path', description: 'campaign id', required: true }],
        body: AmountBody,
        returns: 'AdsStagedView',
      },
      async (c, deps) => {
        const input = await body(c, AmountBody)
        return ok(
          c,
          await portOf(deps).changeBid(actorOf(c), param(c, 'id'), {
            value: input.value,
            ...(input.ad_set_id === undefined ? {} : { ad_set_id: input.ad_set_id }),
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          }),
          201,
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/ads/campaigns/:id/pause',
        operationId: 'stageAdPause',
        summary: '提一条暂停（04 §5：止损是保护性动作，L3；写着止损但 ROAS 与花费不成立的转人审）',
        tag: 'ads',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_ADS,
        params: [{ name: 'id', in: 'path', description: 'campaign id', required: true }],
        body: PauseBody,
        returns: 'AdsStagedView',
      },
      async (c, deps) => {
        const input = await body(c, PauseBody)
        return ok(
          c,
          await portOf(deps).pauseCampaign(actorOf(c), param(c, 'id'), {
            reason: input.reason,
            ...(input.note === undefined ? {} : { note: input.note }),
          }),
          201,
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/ads/ads/:id/creative',
        operationId: 'stageAdCreativeSwap',
        summary: '提一条换素材 / 换文案（新文案过承诺扫描；受众与账户是受保护字段，动了当场拦）',
        tag: 'ads',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_ADS,
        params: [{ name: 'id', in: 'path', description: '广告 id', required: true }],
        body: CreativeBody,
        returns: 'AdsStagedView',
      },
      async (c, deps) => {
        const input = await body(c, CreativeBody)
        return ok(
          c,
          await portOf(deps).swapCreative(actorOf(c), param(c, 'id'), {
            ...(input.creative_ref === undefined ? {} : { creative_ref: input.creative_ref }),
            ...(input.headline === undefined ? {} : { headline: input.headline }),
            ...(input.primary_text === undefined ? {} : { primary_text: input.primary_text }),
          }),
          201,
        )
      },
    ),
  ]
}
