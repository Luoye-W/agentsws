/**
 * WP360（决策 947，Luoye 10-16）：**需要插件的岗位，一开始就引导装好插件**——不等用户说「装插件」。
 *
 * 「要不要」只从职责定义的 `browser_extension` 推（契约 `extensionNeedOf`）：一处定义，三处用——
 *
 * 1. 首次设置第 ④ 步（`onboarding.ts` 的计划里多一格 `extension`，界面把「装插件 + 配对」放在最前）；
 * 2. 岗位页顶上那张卡（`GET /v1/extension/needs`：要不要、配上没有、配上之后还差哪一步、接哪张方案卡、
 *    今天点过「稍后」没有）；
 * 3. 第一次在这个岗位说话（{@link ExtensionOnboarding.nudge}）：插件还没配上 → 事项里先说一句、把装插件那张
 *    连接卡带进来（WP324 同一张卡；同一品牌只一张，别的事项再碰到就复用）。同一条分配只主动带一次。
 *
 * 「稍后」记一条事件（`extension.onboarding_snoozed`），当天（品牌本地日）有就算收起——不落新表，
 * 同一品牌所有岗位一起收（只一张卡）。
 */

import type {
  ExtensionFollowStep,
  ExtensionNeedsActor,
  ExtensionNeedsView,
  ExtensionOnboardingPort,
} from '@agentsws/api'
import {
  type BrowserExtensionUse,
  extensionFollowOf,
  extensionNeedOf,
  type RoleDefinition,
} from '@agentsws/contracts'

type RoleLike = Pick<RoleDefinition, 'id' | 'name' | 'browser_extension'>

export interface ExtensionOnboardingOptions {
  role(id: string): RoleLike | undefined
  /** 这个人在这个品牌担着的职责（没撤的分配）。 */
  heldRoleIds(workspace_id: string, person_id: string): string[]
  /** 这个品牌有没有一个没撤掉的插件配上了。 */
  paired(workspace_id: string): boolean
  /** WP409：配上的是哪一个（最近配的那把；没配上回 undefined）。不给 = 不说。 */
  pairedWith?(workspace_id: string): ExtensionNeedsView['paired_with']
  /** 配对之后那一步做完没有（查不了回 `undefined`）。 */
  stepDone(workspace_id: string, step: ExtensionFollowStep): Promise<boolean | undefined>
  /** 一张方案卡的设置目标（没登记回 `undefined`）。 */
  planTarget(
    workspace_id: string,
    target: string,
  ): Promise<{ name: string; satisfied: boolean } | undefined>
  /** 出那张方案卡（已设好 / 没登记回没有卡）。 */
  askPlan(actor: ExtensionNeedsActor, target: string): Promise<{ card_id?: string }>
  /** 今天（品牌本地日）点过「稍后」没有。 */
  snoozedToday(workspace_id: string): boolean
  /** 记一笔「稍后」。 */
  recordSnooze(actor: ExtensionNeedsActor, role_ids: string[]): void
  /** 这条分配被主动带过装插件卡没有。 */
  prompted(workspace_id: string, assignment_id: string): boolean
  /** 出装插件那张连接卡（挂进这件事的时间线，不挂「连好接着做」）；回卡 id 与是不是复用的那张。 */
  askConnect(input: {
    actor: ExtensionNeedsActor
    matter_id: string
    why: string
  }): Promise<{ card_id: string; reused: boolean } | undefined>
  /** WP416：「要你处理」里还开着的那张装插件连接卡（没有回 `undefined`）。不给 = 不查。 */
  openConnectCard?(workspace_id: string): Promise<string | undefined>
  /**
   * WP493（决策 1718）：ego 这会儿能做的那几样（ego 能用时 `['reddit', 'social']`；不能用 / 不给 = 空）。
   * 这几样不再催装插件，插件对它们只是备用。
   */
  egoCovers?(workspace_id: string): readonly BrowserExtensionUse[]
  /** 事项时间线上说一句（不在乎成没成）。 */
  note(workspace_id: string, matter_id: string, text: string): void | Promise<void>
  /** 记一笔「主动带过」（只有 id）。 */
  recordPrompt(actor: ExtensionNeedsActor, payload: { matter_id: string; card_id: string }): void
}

/** 每一样拿插件做什么（时间线与卡上那一句用；界面另有 i18n）。 */
const USE_ZH: Record<BrowserExtensionUse, string> = {
  reddit: '读 Reddit、把批过的回复填进页面',
  kol: '在 YouTube / Instagram / TikTok 页面上收红人',
  google_ads: '在你的 Google 广告后台执行批过的改动',
  meta_ads: '在你的 Meta 广告后台执行批过的改动',
  social: '到点打开你登录着的社媒发帖页、你点发布',
}

/** 卡上与时间线上那一句为什么。 */
export function extensionWhy(uses: readonly BrowserExtensionUse[]): string {
  const what = uses.map((u) => USE_ZH[u]).join('、')
  return `这个岗位要靠浏览器插件${what}。装一次、配个对，以后跟着工坊自己更新。`
}

export interface ExtensionOnboarding extends ExtensionOnboardingPort {
  /**
   * 第一次在这个岗位说话：要插件、还没配上、这条分配没带过 → 说一句 + 带卡。回带没带。
   * `role_ids` = 这个岗位里本人那几条职责（不给就只看这次做事的那一条）。
   */
  nudge(input: {
    actor: ExtensionNeedsActor
    matter_id: string
    role_ids?: readonly string[]
  }): Promise<boolean>
}

export function createExtensionOnboarding(
  options: ExtensionOnboardingOptions,
): ExtensionOnboarding {
  const defsOf = (ids: readonly string[]): RoleLike[] =>
    [...new Set(ids)].flatMap((id) => {
      const r = options.role(id)
      return r === undefined ? [] : [r]
    })

  const view = async (
    actor: ExtensionNeedsActor,
    role_ids?: readonly string[],
  ): Promise<ExtensionNeedsView> => {
    const ws = actor.workspace_id
    const defs = defsOf(role_ids ?? options.heldRoleIds(ws, actor.person_id))
    const pairedWith = options.paired(ws) ? options.pairedWith?.(ws) : undefined
    const withWhom = pairedWith === undefined ? {} : { paired_with: pairedWith }
    const full = extensionNeedOf(defs)
    // WP493：ego 能做的那几样拿掉（插件对它们只是备用）
    const egoCan = full === undefined ? [] : coveredByEgo(ws, full.uses)
    const need =
      full === undefined
        ? undefined
        : { ...full, uses: full.uses.filter((u) => !egoCan.includes(u)) }
    const ego = egoCan.length === 0 ? {} : { ego_covers: egoCan }
    if (need === undefined)
      return {
        needed: false,
        uses: [],
        roles: [],
        paired: options.paired(ws),
        ...withWhom,
        steps: [],
        plans: [],
        snoozed: false,
      }
    const follow = extensionFollowOf(need.uses)
    // 方案卡（Reddit 巡查设置这类）不随插件走：ego 做的那几样照样要
    const plans0 = full === undefined ? [] : extensionFollowOf(full.uses).plans
    const steps: ExtensionNeedsView['steps'] = []
    for (const step of follow.steps) {
      const done = await options.stepDone(ws, step).catch(() => undefined)
      steps.push(done === undefined ? { step } : { step, done })
    }
    const plans: ExtensionNeedsView['plans'] = []
    for (const target of plans0) {
      const t = await options.planTarget(ws, target).catch(() => undefined)
      if (t !== undefined) plans.push({ target, name: t.name, satisfied: t.satisfied })
    }
    const backup = need.uses.length === 0
    const open =
      options.paired(ws) || backup
        ? undefined
        : await options.openConnectCard?.(ws).catch(() => undefined)
    return {
      ...(open === undefined ? {} : { connect_card_id: open }),
      needed: true,
      uses: need.uses,
      roles: defs
        .filter((d) => need.role_ids.includes(d.id))
        .map((d) => ({ role_id: d.id, name: { zh: d.name.zh, en: d.name.en ?? d.name.zh } })),
      paired: options.paired(ws),
      ...withWhom,
      steps,
      plans,
      snoozed: options.snoozedToday(ws),
      ...ego,
      ...(backup ? { plugin_backup: true } : {}),
    }
  }
  const coveredByEgo = (
    ws: string,
    uses: readonly BrowserExtensionUse[],
  ): BrowserExtensionUse[] => {
    let can: readonly BrowserExtensionUse[] = []
    try {
      can = options.egoCovers?.(ws) ?? []
    } catch {
      can = []
    }
    return uses.filter((u) => can.includes(u))
  }

  return {
    needs: (actor, role_ids) => view(actor, role_ids),
    snooze: async (actor, role_ids) => {
      const before = await view(actor, role_ids)
      if (before.needed && !before.snoozed)
        options.recordSnooze(
          actor,
          before.roles.map((r) => r.role_id),
        )
      return { ...before, snoozed: before.needed }
    },
    plan: async (actor, target) => {
      const ws = actor.workspace_id
      const held = extensionNeedOf(defsOf(options.heldRoleIds(ws, actor.person_id)))
      // 只接本人担着的岗位要的那几张（不让这条路变成「随便出一张配置卡」）
      if (held === undefined || !extensionFollowOf(held.uses).plans.includes(target)) return {}
      return options.askPlan(actor, target)
    },
    nudge: async ({ actor, matter_id, role_ids }) => {
      const ws = actor.workspace_id
      /*
       * WP421（自查 general 界面 #3）/ WP419（自查 P7）：这一次做事的那条职责自己用不上插件（例如公关岗位里写新闻稿）就不在对话里带——
       * 以前按整个岗位判，写新闻稿时第一屏先是「先装好 Chrome 插件、读 Reddit」的大卡，跟这件事毫无关系。
       */
      if (extensionNeedOf(defsOf([actor.role_id])) === undefined) return false
      const full = extensionNeedOf(defsOf(role_ids ?? [actor.role_id]))
      // WP493：ego 能做的那几样不催（全都能做 = 不带卡）
      const need =
        full === undefined
          ? undefined
          : { ...full, uses: full.uses.filter((u) => !coveredByEgo(ws, full.uses).includes(u)) }
      if (need === undefined || need.uses.length === 0 || options.paired(ws)) return false
      // 今天点过「稍后」就不在对话里再提（下一次说话、过了今天再带）；同一条分配只主动带一次
      if (options.snoozedToday(ws) || options.prompted(ws, actor.assignment_id)) return false
      const why = extensionWhy(need.uses)
      // 先说一句、再出卡（时间线上卡在这句话下面）。界面少字：用途一句、动作一句
      await options.note(
        ws,
        matter_id,
        `这个岗位要用浏览器插件${need.uses.map((u) => USE_ZH[u]).join('、')}，还没装。在下面这张卡上装好、配个对就行。`,
      )
      const card = await options.askConnect({ actor, matter_id, why }).catch(() => undefined)
      if (card === undefined) return false
      if (card.reused)
        await options.note(ws, matter_id, '这张卡之前已经出过，在「要你处理」里，装好它就行。')
      options.recordPrompt(actor, { matter_id, card_id: card.card_id })
      return true
    },
  }
}
