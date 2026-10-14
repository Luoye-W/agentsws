/**
 * WP330（docs/102 附：甲方周报要求）：**Reddit 周报的分节与措辞**两个工具——给模型看的名字、描述、参数。
 * 真正干活在服务端（`apps/server/src/reddit-weekly-tools.ts`）。
 *
 * 用户几句话交代（「回复那节放最前面」「评估改成 需关注 / 可忽略」「每周四下午五点出」），AI 先读现在的样子，
 * 再只把要改的那几项交给 `set_reddit_weekly_format`；改的是我们自己的周报怎么写，不往外发任何东西，所以直接生效
 * （回一份小节标题预览，用户不满意再说一句改回来）。数字永远是数出来的，模型只碰措辞。
 */
import type { ToolDef } from '@agentsws/contracts'

export const GET_REDDIT_WEEKLY_FORMAT_TOOL = 'get_reddit_weekly_format'
export const SET_REDDIT_WEEKLY_FORMAT_TOOL = 'set_reddit_weekly_format'

/** 两个工具（排好序：`tools.allow` 要字节稳定）。 */
export const REDDIT_WEEKLY_TOOL_NAMES: readonly string[] = [
  GET_REDDIT_WEEKLY_FORMAT_TOOL,
  SET_REDDIT_WEEKLY_FORMAT_TOOL,
].sort()

const SECTION_HINT =
  '四节：own_stats 自家版块帖子 / 评论数、voc_ugc 自家版块 VOC 与 UGC、external 外部社区话题与评估、' +
  'our_replies 我们本周的回复与链接。'

export const REDDIT_WEEKLY_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: GET_REDDIT_WEEKLY_FORMAT_TOOL,
    description:
      '看 Reddit 周报现在怎么写：标题、四节的顺序 / 标题 / 开关 / 引言、编号、三档评估的写法、原文截断、时间写法、' +
      '数据窗口从周几开始、每周几几点出，以及最近一份周报的小节标题。只读。用户要改周报的样子前先调它。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: SET_REDDIT_WEEKLY_FORMAT_TOOL,
    description:
      `按用户的话改 Reddit 周报的分节与措辞（只给要改的那几项）。${SECTION_HINT}` +
      'sections 给了顺序就按它排，没提到的节接在后面；不要的节 enabled=false。' +
      '评估三档：no_action（日常讨论无需处理）、low_relevance（相关度不高不建议回复）、follow_up（需跟进）。' +
      '数字、原文、链接都由系统数出来，这里只改怎么写。直接生效，回一份小节标题预览给用户看。',
    input_schema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: '用户的原话（照抄）' },
        title: {
          type: 'string',
          description: '周报标题；{brand} {start} {end} 会换成品牌名与起止日期',
        },
        sections: {
          type: 'array',
          description: '小节（顺序 = 出现顺序）',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', enum: ['own_stats', 'voc_ugc', 'external', 'our_replies'] },
              title: { type: 'string', description: '小节标题' },
              enabled: { type: 'boolean', description: '要不要这一节' },
              intro: { type: 'string', description: '标题下的一句引言（空串 = 去掉）' },
            },
            required: ['id'],
          },
        },
        numbering: {
          type: 'string',
          enum: ['zh', 'arabic', 'none'],
          description: '小节编号：一、二 / 1. 2. / 不编号',
        },
        assessment_labels: {
          type: 'object',
          description: '三档评估的写法',
          properties: {
            no_action: { type: 'string' },
            low_relevance: { type: 'string' },
            follow_up: { type: 'string' },
          },
        },
        quote_max_chars: { type: 'number', description: '原文最多几个字（40–2000）' },
        max_quotes_per_topic: { type: 'number', description: '每个话题最多列几条原文（0 = 全列）' },
        date_format: { type: 'string', description: '时间写法，如 MM/DD HH:mm' },
        window_start_weekday: { type: 'number', description: '数据从周几 00:00 算起（0 = 周日）' },
        weekday: { type: 'number', description: '每周几出（0 = 周日 … 5 = 周五）' },
        time: { type: 'string', description: '几点出（HH:MM，24 小时）' },
        reset: { type: 'boolean', description: '先回到默认再改' },
      },
      required: ['instruction'],
    },
  },
]

export const REDDIT_WEEKLY_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  REDDIT_WEEKLY_TOOL_DEFS.map((d) => [d.name, d]),
)
