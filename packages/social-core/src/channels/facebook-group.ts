/**
 * Facebook 群组适配器：**浏览器模式**（56 §1 / §3；36 §9 第三栏、55 §3 浏览器执行器）。
 *
 * 这条渠道没有接口。Meta 2024 年停掉了 Groups API 的读写口子，剩下的只有
 * "一个人坐在浏览器前面点"。所以它与另外八条**形状不同**：每个写动作回的不是
 * "发出去了"，而是一段**受控浏览器脚本描述**（{@link BrowserAction}）——
 * 该开哪个页面、点哪个东西、填什么、以及**做完之后凭什么确认真做成了**。
 *
 * 三条纪律：
 *
 * 1. **本 WP 不接执行器**。调用 `publish` / `broadcast` / `moderate` 回的是
 *    `browser_required` 那句人话 + 一段脚本描述；真去点由 WP73 接上 55 的浏览器
 *    执行器。回一个假的"成功"是这里最容易犯也最糟的错——群里什么都没发生，
 *    而账本上写着发过了。
 * 2. **写动作照样先出卡**。浏览器只是手，不是授权：`community_broadcast`
 *    在 `HARD_L1` 里，走浏览器不改变这一条。脚本描述是**批准之后**交给执行器的
 *    东西，不是绕过审批的旁路。
 * 3. **脚本描述里没有凭据**。浏览器会话是登录态的（人自己在第三栏里登过），
 *    这个文件从头到尾不碰 cookie 也不碰密码。{@link BrowserAction} 的字段里
 *    放不下一个 token。
 */

import type { SocialChannel } from '@agentsws/contracts'
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
  type SocialResult,
  type SocialTransport,
} from './types.js'

const CHANNEL: SocialChannel = 'facebook_group'
const LABEL = 'Facebook 群组'

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

const groupUrl = (id: string): string => `https://www.facebook.com/groups/${encodeURIComponent(id)}`

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

export function createFacebookGroupAdapter(transport: SocialTransport): SocialChannelAdapter {
  // 浏览器模式没有"连接"，但第三栏里得先登过——`connected` 报的就是这件事
  const off = () => guardConnected(transport, CHANNEL, LABEL)

  return {
    channel: CHANNEL,
    mode: 'browser',

    async profile(_account_external_id: string): Promise<SocialResult<ChannelProfile>> {
      return off() ?? browserRequired(LABEL, '读群资料与成员数')
    },

    async posts(_input: {
      account_external_id: string
      limit?: number
    }): Promise<SocialResult<ChannelPost[]>> {
      return off() ?? browserRequired(LABEL, '读群里的帖子')
    },

    async comments(_input: {
      account_external_id: string
      post_external_id?: string
      limit?: number
    }): Promise<SocialResult<ChannelComment[]>> {
      return off() ?? browserRequired(LABEL, '读群里的讨论与评论')
    },

    async members(_input: {
      account_external_id: string
      status?: 'pending' | 'active'
      limit?: number
    }): Promise<SocialResult<ChannelMember[]>> {
      return off() ?? browserRequired(LABEL, '读成员名单与待审入群')
    },

    async publish(
      _input: PublishInput,
    ): Promise<SocialResult<{ external_id: string; url?: string }>> {
      // 脚本描述算得出来（`publishScript`），但**不假装发出去了**（文件头第 1 条）
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
