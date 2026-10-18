/**
 * WP417（自查客服 A8 / A43 / B7 / C23 / D2–D4）：客服四条职责的**查询类工具**——给模型看的名字、描述、参数。
 * 真正干活在服务端（`apps/server/src/records.ts` 的记录源执行器）。
 *
 * | 工具 | 干什么 |
 * |---|---|
 * | `list_support_threads` | 客服邮箱里还等着回的来信（最后一封是客户发的），按等了多久排；Amazon 买家消息带「离 24 小时还剩多久」 |
 * | `list_chat_sessions` | 网站聊天窗里的会话（等人工的、转邮件跟进的、还开着的），带等了几分钟和访客最后一句 |
 * | `list_community_threads` | 社群 / 私信 / 评论区的帖子（缺省只列没处理完的，含社媒运营转过来的） |
 *
 * 三个都只读本机的消息库 / 聊天库 / 社媒库，不碰外部账号，不出卡。
 */
import type { ToolDef } from '@agentsws/contracts'

export const LIST_SUPPORT_THREADS_TOOL = 'list_support_threads'
export const LIST_CHAT_SESSIONS_TOOL = 'list_chat_sessions'
export const LIST_COMMUNITY_THREADS_TOOL = 'list_community_threads'

/** 两个新工具（排好序：`tools.allow` 要字节稳定）。`list_community_threads` 早就有，不在这一组里。 */
export const SUPPORT_TOOL_NAMES: readonly string[] = [
  LIST_CHAT_SESSIONS_TOOL,
  LIST_SUPPORT_THREADS_TOOL,
].sort()

export const SUPPORT_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: LIST_SUPPORT_THREADS_TOOL,
    description:
      '列客服邮箱里还等着回的来信（这条会话里最后一封是客户发的），等得最久的在前；每条带主题、来信人、等了几小时，' +
      'Amazon 买家消息另带「离 24 小时回复线还剩几小时」。问「超时没回的」「快超 24 小时的」「现在有哪些没回」时用它。只读。',
    input_schema: {
      type: 'object',
      properties: {
        min_waiting_hours: {
          type: 'number',
          description: '只要等了至少这么多小时的（「超过 8 小时没回」就给 8；不给 = 全部）',
        },
        amazon_only: { type: 'boolean', description: '只看 Amazon 买家消息' },
        due_within_hours: {
          type: 'number',
          description: '只看离 24 小时回复线还剩不到这么多小时的（只对 Amazon 买家消息有意义）',
        },
        limit: { type: 'integer', description: '要几条（默认 20，最多 50）' },
      },
    },
  },
  {
    name: LIST_CHAT_SESSIONS_TOOL,
    description:
      '列网站聊天窗里的会话：等人工的、已转邮件跟进的、还开着的；每条带访客、状态、等了几分钟、访客最后一句。' +
      '问「现在谁在等着回」「聊天里有哪些要人工」时用它。只读。',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['waiting', 'email_follow_up', 'open', 'all'],
          description:
            'waiting = 等人工（缺省）；email_follow_up = 已转邮件跟进；open = 还开着；all = 全部',
        },
        limit: { type: 'integer', description: '要几条（默认 20，最多 50）' },
      },
    },
  },
  {
    name: LIST_COMMUNITY_THREADS_TOOL,
    description:
      '列社群 / 私信 / 评论区的帖子（Discord、Telegram、WhatsApp、Reddit 等），缺省只列还没处理完的、' +
      '包括社媒运营转过来的客户问题；每条带渠道、作者、正文摘要、状态。问「有哪些转过来的问题」「这问题是不是问过很多遍」时用它。只读。',
    input_schema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: '只看这个渠道（discord / telegram_group / whatsapp / reddit …）',
        },
        open: { type: 'boolean', description: 'false = 连处理完的一起列（缺省只列没处理完的）' },
        handed_over: { type: 'boolean', description: '只看社媒运营转过来的客户问题' },
        since_days: {
          type: 'number',
          description: '只看最近这么多天的（数「问过几遍」时用，最多 90）',
        },
        limit: { type: 'integer', description: '要几条（默认 20，最多 50）' },
      },
    },
  },
]

export const SUPPORT_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  SUPPORT_TOOL_DEFS.map((d) => [d.name, d]),
)
