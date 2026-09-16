/**
 * Facebook 群组适配器：**浏览器模式**（56 §1 / §3；36 §9 第三栏、55 §3 浏览器执行器）。
 *
 * 这条渠道没有接口。Meta 2024 年停掉了 Groups API 的读写口子，剩下的只有
 * "一个人坐在浏览器前面点"。所以它与另外八条**形状不同**：每个动作对应的不是
 * 一条 HTTP 请求，而是一段**受控浏览器脚本描述**（{@link BrowserAction}）——
 * 该开哪个页面、点哪个东西、填什么、以及**做完之后凭什么确认真做成了**。
 *
 * WP72 把脚本描述写好了但没有执行器；WP73 把执行器接上（55 §3 / WP82：官方
 * `dsh-browser-use` + Playwright MCP）。接上之后这个文件的四条纪律：
 *
 * 1. **读走白名单。** 只读动作（读帖子、读待审成员）经 {@link BrowserExecutor}
 *    真去开页面，但**开之前先查一遍域名**（{@link FACEBOOK_GROUP_HOSTS}）。
 *    真正的闸在 `dsh-adapter` 的 `checkBrowserNavigation`（职责 yml 的
 *    `browser_scope` → `RunRequest.allowed_hosts`）；这里这一道是**第二道**——
 *    执行器有可能被别的路径调到，而一条越界的 URL 一旦开出去就收不回来。
 * 2. **写先出卡。** `publish` / `reply` / `decideMember` / `broadcast` /
 *    `moderate` **永远**回 `browser_required`，一个字都不执行。浏览器只是手，
 *    不是授权：`community_broadcast` 在 `HARD_L1` 里，走浏览器不改变这一条。
 *    批准之后才由调用方拿着脚本描述调 {@link executeApprovedBrowserAction}。
 * 3. **失效即停。** 执行器拿不准（登录态失效 / 页面结构变了 / 找不到按钮）就
 *    回 `handover`，这里翻成一句"请你接管"，**不重试**——重试一个不知道点到哪儿
 *    的动作，比不做危险得多。
 * 4. **脚本描述里没有凭据。** 浏览器会话是登录态的（人自己在第三栏里登过），
 *    这个文件从头到尾不碰 cookie 也不碰密码。{@link BrowserAction} 的字段里
 *    放不下一个 token。
 */

import type { SocialChannel } from '@agentsws/contracts'
import { hostAllowed } from '@agentsws/contracts'
import {
  type BroadcastInput,
  browserRequired,
  type ChannelComment,
  type ChannelMember,
  type ChannelPost,
  type ChannelProfile,
  guardConnected,
  type MemberDecisionInput,
  type ModerateInput,
  type PublishInput,
  type ReplyInput,
  type SocialChannelAdapter,
  type SocialError,
  type SocialResult,
  type SocialTransport,
} from './types.js'

const CHANNEL: SocialChannel = 'facebook_group'
const LABEL = 'Facebook 群组'

/**
 * 这条渠道能开的站（职责 yml `social/facebook-group.yml` 的 `browser_scope`
 * 写的是同一份）。**两处都写**是有意的：yml 那份是真闸（经
 * `RunRequest.allowed_hosts` 到 `checkBrowserNavigation`），这一份是适配器
 * 自己那一道——两处不一致的时候测试会喊（`facebook-group.test.ts`）。
 */
export const FACEBOOK_GROUP_HOSTS: readonly string[] = ['*.facebook.com', 'facebook.com']

/**
 * 一段给受控浏览器的动作描述。
 *
 * 为什么是"描述"而不是一串选择器：选择器一周就失效一次，而**这件事要干什么**
 * 一年也不变。执行器（55 §3）拿着 `goal` + `steps` 去让浏览器代理自己找按钮；
 * `verify` 是做完之后的自证——没有它，"点过了"和"以为点过了"分不开。
 */
export interface BrowserAction {
  /** 从哪个页面开始（群的地址 / 待审成员页 / 某条帖子）。 */
  url: string
  /** 一句话说清要干成什么（给浏览器代理的目标）。 */
  goal: string
  /** 人话的步骤。执行器按它走，走不通就停下来问人，**不自己发挥**。 */
  steps: string[]
  /** 怎么确认真做成了（"刷新之后这条帖子出现在群里最上面"）。 */
  verify: string
  /** 这一步会不会改变外部状态（写动作永远 `true`——决定它要不要先过审批）。 */
  writes: boolean
}

/**
 * 执行器回来的三种结果。
 *
 * `handover` 与 `failed` 分得开是这条渠道的全部意义（文件头第 3 条）：
 * 前者要**人去浏览器里接管**（登录态掉了、页面改版了），后者是这一次没成
 * （网络断了）。两个的下一步完全不同，混成一个"出错了"等于把人接管那条路砍掉。
 */
export type BrowserRunResult =
  | {
      status: 'ok'
      /**
       * 读回来的条目（只读动作才有）。**外部文本**——调用方进模型上下文前要围栏
       * （21 §1 / 39）。适配器只做形状转换，一个字不改写。
       */
      items?: readonly Record<string, unknown>[]
      /** 执行器的自证（`verify` 那一句的答案）。 */
      verified?: boolean
    }
  | { status: 'handover'; message: string }
  | { status: 'failed'; message: string }

/**
 * 受控浏览器执行器在这个包里的**形状**（55 §3 / WP82 的那一个）。
 *
 * 这个包不认识 dsh、不认识 Playwright、也起不了浏览器——它只知道"把一段动作
 * 描述交出去，拿回三种结果之一"。真正的那一个在服务进程那一侧装配；测试里
 * 塞一个假的就能把"读走白名单、写先出卡、失效即停"三条钉死。
 */
export interface BrowserExecutor {
  /**
   * 这次运行能开哪些站（来源是职责 yml 的 `browser_scope`）。
   *
   * 不给 = 按 {@link FACEBOOK_GROUP_HOSTS}。给了就以它为准——岗位可能带多条
   * 职责，白名单是并集，那个并集只有服务进程那一侧算得出来。
   */
  allowedHosts?(): readonly string[]
  run(action: BrowserAction): Promise<BrowserRunResult>
}

const groupUrl = (id: string): string => `https://www.facebook.com/groups/${encodeURIComponent(id)}`

/** 读群里的帖子该怎么看。 */
export function postsScript(account_external_id: string, limit: number): BrowserAction {
  return {
    url: groupUrl(account_external_id),
    goal: `把这个群里最近 ${limit} 条帖子读回来`,
    steps: [
      '打开群页面，等帖子列表出来',
      `往下滚到看见 ${limit} 条为止（滚不动了就有几条算几条）`,
      '每条记下：帖子 id（从"…"菜单里的固定链接取）、作者、正文、发布时间、点赞与评论数',
    ],
    verify: '读回来的每一条都有帖子 id 与发布时间；一条都没有的话说"这个群现在没有帖子"',
    writes: false,
  }
}

/** 读待审入群申请该怎么看。 */
export function pendingMembersScript(account_external_id: string): BrowserAction {
  return {
    url: `${groupUrl(account_external_id)}/member-requests`,
    goal: '把还没处理的入群申请读回来',
    steps: [
      '打开群的"成员申请"页',
      '每条记下：这个人的主页 id、名字、申请时间、他填的答案（原样抄，不要概括）',
    ],
    verify: '读回来的每一条都有主页 id；页面上写着"没有待处理的申请"时回空',
    writes: false,
  }
}

/** 读群里的讨论 / 评论该怎么看。 */
export function commentsScript(
  account_external_id: string,
  post_external_id: string | undefined,
): BrowserAction {
  return {
    url:
      post_external_id === undefined
        ? groupUrl(account_external_id)
        : `${groupUrl(account_external_id)}/posts/${encodeURIComponent(post_external_id)}`,
    goal: post_external_id === undefined ? '把群里最近的讨论读回来' : '把这条帖子下的评论读回来',
    steps: [
      post_external_id === undefined ? '打开群页面' : '打开这条帖子',
      '点开"查看更多评论"直到点不动为止',
      '每条记下：评论 id、作者主页 id、作者名、正文、时间',
    ],
    verify: '读回来的每一条都有评论 id 与作者；没有评论时回空',
    writes: false,
  }
}

/** 读群资料与成员数该怎么看。 */
export function profileScript(account_external_id: string): BrowserAction {
  return {
    url: `${groupUrl(account_external_id)}/about`,
    goal: '把这个群的名字、简介与成员数读回来',
    steps: ['打开群的"关于"页', '记下群名、简介、成员数'],
    verify: '群名与成员数都有；成员数读不到就留空，**不要猜一个数**',
    writes: false,
  }
}

/** 发一条群帖该怎么点。 */
export function publishScript(input: PublishInput): BrowserAction {
  return {
    url: groupUrl(input.account_external_id),
    goal: `在这个群里发一条帖子${input.scheduled_at === undefined ? '' : `，并把它排在 ${input.scheduled_at}`}`,
    steps: [
      '在群页面顶部找到发帖框（"写点什么…"），点开它',
      '把正文粘进去，一个字不改',
      ...(input.media_urls ?? []).map((u) => `插入这张素材：${u}`),
      input.scheduled_at === undefined
        ? '点"发布"'
        : `点发布按钮旁边的下拉，选"定时发布"，把时间设成 ${input.scheduled_at}，再确认`,
    ],
    verify:
      input.scheduled_at === undefined
        ? '刷新群页面，这条帖子出现在最上面，正文与我们给的一字不差'
        : '在群的"定时帖子"列表里能看到这一条，时间对得上',
    writes: true,
  }
}

/** 回一条帖子 / 评论该怎么点。 */
export function replyScript(input: ReplyInput): BrowserAction {
  return {
    url: `${groupUrl(input.account_external_id ?? '')}/posts/${encodeURIComponent(input.parent_external_id)}`,
    goal: `在这条帖子下回一条评论：${input.parent_external_id}`,
    steps: ['打开这条帖子', '点评论框', '把正文粘进去，一个字不改', '按回车发出去'],
    verify: '刷新之后这条评论出现在帖子下面，正文与我们给的一字不差',
    writes: true,
  }
}

/** 批 / 拒一条入群申请该怎么点。 */
export function memberDecisionScript(input: MemberDecisionInput): BrowserAction {
  const verb = input.decision === 'approve' ? '批准' : input.decision === 'reject' ? '拒绝' : '移出'
  return {
    url: `${groupUrl(input.account_external_id)}/member-requests`,
    goal: `${verb}这个人的入群申请：${input.member_external_id}`,
    steps: [
      '打开群的"成员申请"页',
      `在列表里找到 ${input.member_external_id}`,
      `点他那一行的"${verb}"`,
    ],
    verify: `刷新之后这个人不再出现在待审列表里${input.decision === 'approve' ? '，并且出现在成员名单里' : ''}`,
    writes: true,
  }
}

/** 发一条群公告（置顶）该怎么点。 */
export function broadcastScript(input: BroadcastInput): BrowserAction {
  return {
    url: groupUrl(input.account_external_id),
    goal: '在这个群里发一条公告并置顶',
    steps: [
      '在群页面顶部找到发帖框，点开它',
      '把公告正文粘进去，一个字不改',
      '点"发布"',
      '在这条帖子的"…"菜单里选"置顶帖子"',
    ],
    verify: '刷新之后这条公告出现在群的置顶区',
    writes: true,
  }
}

/** 管理动作（删帖 / 禁言 / 封禁）该怎么点。 */
export function moderateScript(input: ModerateInput): BrowserAction {
  const words: Record<ModerateInput['action'], string> = {
    delete_post: '删掉这条帖子',
    mute: '把这个人设成"需要审核后才能发帖"',
    unmute: '取消这个人的发帖审核',
    ban: '把这个人移出并封禁',
    permanent_ban: '把这个人永久封禁',
    unban: '解除这个人的封禁',
  }
  return {
    url: groupUrl(input.account_external_id),
    goal: `${words[input.action]}（目标：${input.target_external_id}）`,
    steps: [
      input.action === 'delete_post'
        ? `在群里找到这条帖子：${input.target_external_id}`
        : `打开群的成员管理页，找到 ${input.target_external_id}`,
      '点右上角的"…"菜单',
      `选"${words[input.action]}"`,
      ...(input.reason === undefined ? [] : [`理由填：${input.reason}`]),
      '确认',
    ],
    verify:
      input.action === 'delete_post'
        ? '刷新之后这条帖子不在群里了'
        : '在成员管理页上这个人的状态变了',
    writes: true,
  }
}

/* ── 执行那一跳 ──────────────────────────────────────────────────────── */

/** 越界那一句（文件头第 1 条）。 */
function outOfScope(url: string, allowed: readonly string[]): SocialError {
  return {
    ok: false,
    reason: 'browser_required',
    message: `这个地址不在这条职责能开的站里（只能开 ${allowed.join('、')}）：${url}。没开出去——越界的页面一旦打开就收不回来。`,
  }
}

/** 人接管那一句（文件头第 3 条）。 */
function handover(what: string, message: string): SocialError {
  return {
    ok: false,
    reason: 'browser_required',
    message: `${LABEL} 这一步（${what}）停下来了，要你自己在浏览器里接一下：${message} 我**没有重试**——重试一个不知道点到哪儿的动作比不做危险。`,
  }
}

/** 域名白名单（文件头第 1 条的第二道）。 */
function checkHost(action: BrowserAction, executor: BrowserExecutor): SocialError | undefined {
  const allowed = executor.allowedHosts?.() ?? FACEBOOK_GROUP_HOSTS
  let host: string
  try {
    host = new URL(action.url).hostname
  } catch {
    return {
      ok: false,
      reason: 'browser_required',
      message: `打不开这个地址：${action.url}`,
    }
  }
  return hostAllowed(host, allowed) ? undefined : outOfScope(action.url, allowed)
}

/**
 * 跑一段**只读**的动作，把执行器的三种结果翻成 `SocialResult`。
 *
 * 写动作走不到这里——它在适配器那一层就被挡下出卡了（文件头第 2 条）。
 */
async function runRead(
  executor: BrowserExecutor,
  action: BrowserAction,
  what: string,
): Promise<{ ok: true; items: readonly Record<string, unknown>[] } | SocialError> {
  const scope = checkHost(action, executor)
  if (scope !== undefined) return scope
  let result: BrowserRunResult
  try {
    result = await executor.run(action)
  } catch (e) {
    return {
      ok: false,
      reason: 'upstream_error',
      message: `${LABEL} 的浏览器这一步没跑起来（${what}）：${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`,
    }
  }
  if (result.status === 'handover') return handover(what, result.message)
  if (result.status === 'failed')
    return {
      ok: false,
      reason: 'upstream_error',
      message: `${LABEL} 的浏览器这一步没做成（${what}）：${result.message}`,
    }
  return { ok: true, items: result.items ?? [] }
}

/**
 * **批准之后**才调的那一跳：拿着卡上那段脚本描述，让执行器真去点。
 *
 * 为什么不放在适配器的 `publish` / `moderate` 里：那几个口子是起草那一跳也会
 * 调到的（面板上算"这条渠道做得了什么"、模型试着提一个动作）。把"真去点"
 * 放在一个**要带审批 id 才调得动**的函数里，路径上就不存在"想发就发"这回事。
 *
 * `approval_id` 只是一道形状上的闸（空字符串直接拒），真正的判定在变更账本
 * 那一侧——这里不认识审批，也不该认识。
 */
export async function executeApprovedBrowserAction(
  executor: BrowserExecutor,
  action: BrowserAction,
  context: { approval_id: string; now: string },
): Promise<SocialResult<{ verified: boolean }>> {
  if (context.approval_id.trim() === '')
    return {
      ok: false,
      reason: 'needs_approval',
      message: `${LABEL} 的写动作要先有一张批过的卡。没有卡 id 就不点——浏览器只是手，不是授权。`,
    }
  const scope = checkHost(action, executor)
  if (scope !== undefined) return scope
  let result: BrowserRunResult
  try {
    result = await executor.run(action)
  } catch (e) {
    return {
      ok: false,
      reason: 'upstream_error',
      message: `${LABEL} 的浏览器没跑起来：${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`,
    }
  }
  if (result.status === 'handover') return handover(action.goal, result.message)
  if (result.status === 'failed')
    return {
      ok: false,
      reason: 'upstream_error',
      message: `${LABEL} 那一步没做成：${result.message}（没有重试——这一条要你看一眼再决定）`,
    }
  /*
   * `verified` 为假 = 点是点了，但执行器自己也说不准做成没有。
   * **照实报**，不当成成功：`verify` 那一句存在的全部意义就是这一下。
   */
  return {
    ok: true,
    observed_at: context.now,
    data: { verified: result.verified === true },
  }
}

/* ── 适配器 ─────────────────────────────────────────────────────────── */

const str = (row: Record<string, unknown>, key: string): string | undefined => {
  const v = row[key]
  return typeof v === 'string' && v !== '' ? v : undefined
}
const num = (row: Record<string, unknown>, key: string): number | undefined => {
  const v = row[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export interface FacebookGroupOptions {
  /** 受控浏览器执行器。不给 = 这条渠道还是"只出脚本描述"（WP72 那个样子）。 */
  browser?: BrowserExecutor
}

export function createFacebookGroupAdapter(
  transport: SocialTransport,
  options: FacebookGroupOptions = {},
): SocialChannelAdapter {
  // 浏览器模式没有"连接"，但第三栏里得先登过——`connected` 报的就是这件事
  const off = () => guardConnected(transport, CHANNEL, LABEL)
  const browser = options.browser

  return {
    channel: CHANNEL,
    mode: 'browser',

    async profile(account_external_id: string): Promise<SocialResult<ChannelProfile>> {
      const guard = off()
      if (guard !== undefined) return guard
      if (browser === undefined) return browserRequired(LABEL, '读群资料与成员数')
      const res = await runRead(browser, profileScript(account_external_id), '读群资料')
      if (!('items' in res)) return res
      const row = res.items[0] ?? {}
      return {
        ok: true,
        observed_at: transport.now(),
        data: {
          channel: CHANNEL,
          external_id: account_external_id,
          handle: str(row, 'handle') ?? account_external_id,
          display_name: str(row, 'display_name') ?? str(row, 'name') ?? account_external_id,
          url: groupUrl(account_external_id),
          // 读不到就留空（脚本里那句"不要猜一个数"的落点）
          ...(num(row, 'member_count') === undefined
            ? {}
            : { member_count: num(row, 'member_count') as number }),
          ...(str(row, 'bio') === undefined ? {} : { bio: str(row, 'bio') as string }),
        },
      }
    },

    async posts({
      account_external_id,
      limit,
    }: {
      account_external_id: string
      limit?: number
    }): Promise<SocialResult<ChannelPost[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      if (browser === undefined) return browserRequired(LABEL, '读群里的帖子')
      const res = await runRead(
        browser,
        postsScript(account_external_id, limit ?? 20),
        '读群里的帖子',
      )
      if (!('items' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: res.items.map((row) => ({
          external_id: str(row, 'external_id') ?? str(row, 'id') ?? '',
          kind: 'post' as const,
          body: str(row, 'body') ?? str(row, 'text') ?? '',
          ...(str(row, 'published_at') === undefined
            ? {}
            : { published_at: str(row, 'published_at') as string }),
          ...(str(row, 'url') === undefined ? {} : { url: str(row, 'url') as string }),
          metrics: {
            ...(num(row, 'likes') === undefined ? {} : { likes: num(row, 'likes') as number }),
            ...(num(row, 'comments') === undefined
              ? {}
              : { comments: num(row, 'comments') as number }),
          },
        })),
      }
    },

    async comments({
      account_external_id,
      post_external_id,
    }: {
      account_external_id: string
      post_external_id?: string
      limit?: number
    }): Promise<SocialResult<ChannelComment[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      if (browser === undefined) return browserRequired(LABEL, '读群里的讨论与评论')
      const res = await runRead(
        browser,
        commentsScript(account_external_id, post_external_id),
        '读群里的讨论',
      )
      if (!('items' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: res.items.map((row) => ({
          external_id: str(row, 'external_id') ?? str(row, 'id') ?? '',
          surface: 'thread' as const,
          author_external_id: str(row, 'author_external_id') ?? '',
          author_handle: str(row, 'author_handle') ?? str(row, 'author') ?? '',
          text: str(row, 'text') ?? '',
          created_at: str(row, 'created_at') ?? transport.now(),
          ...(post_external_id === undefined ? {} : { parent_external_id: post_external_id }),
        })),
      }
    },

    async members({
      account_external_id,
      status,
    }: {
      account_external_id: string
      status?: 'pending' | 'active'
      limit?: number
    }): Promise<SocialResult<ChannelMember[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      if (browser === undefined) return browserRequired(LABEL, '读成员名单与待审入群')
      /*
       * 只读**待审**那一页。整份成员名单在浏览器里要翻几百屏，而且我们要它做什么
       * 也说不上来——"待审入群"是这条职责真正要看的那一块（56 §2）。
       */
      if (status === 'active')
        return browserRequired(LABEL, '读整份成员名单（要翻几百屏，这条路我们没接）')
      const res = await runRead(browser, pendingMembersScript(account_external_id), '读待审入群')
      if (!('items' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: res.items.map((row) => {
          const answers = row.application_answers
          return {
            external_id: str(row, 'external_id') ?? str(row, 'id') ?? '',
            handle: str(row, 'handle') ?? str(row, 'name') ?? '',
            ...(str(row, 'display_name') === undefined
              ? {}
              : { display_name: str(row, 'display_name') as string }),
            status: 'pending' as const,
            ...(str(row, 'applied_at') === undefined
              ? {}
              : { joined_at: str(row, 'applied_at') as string }),
            ...(Array.isArray(answers)
              ? { application_answers: answers.map((a) => String(a)) }
              : {}),
          }
        }),
      }
    },

    /*
     * 五个写口子（文件头第 2 条）：**永远**回 `browser_required`，一个字都不执行。
     * 脚本描述由调用方用上面那几个 `*Script` 算出来挂在卡上；批准之后走
     * `executeApprovedBrowserAction`。
     */
    async publish(
      _input: PublishInput,
    ): Promise<SocialResult<{ external_id: string; url?: string }>> {
      return off() ?? browserRequired(LABEL, '发帖')
    },

    async reply(_input: ReplyInput): Promise<SocialResult<{ external_id: string }>> {
      return off() ?? browserRequired(LABEL, '回帖 / 回评论')
    },

    async decideMember(_input: MemberDecisionInput): Promise<SocialResult<{ ok: true }>> {
      return off() ?? browserRequired(LABEL, '批 / 拒入群申请')
    },

    async broadcast(
      _input: BroadcastInput,
    ): Promise<SocialResult<{ sent: number; failed: number }>> {
      return off() ?? browserRequired(LABEL, '发群公告')
    },

    async moderate(_input: ModerateInput): Promise<SocialResult<{ ok: true }>> {
      return off() ?? browserRequired(LABEL, '删帖 / 禁言 / 封禁')
    },
  }
}
