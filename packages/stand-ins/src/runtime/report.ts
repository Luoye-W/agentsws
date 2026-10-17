/**
 * WP331（决策 691，Luoye 10-15）：**报告积木**的四个工具——给模型看的名字、描述、参数，以及 stub 运行时的剧本。
 * 真正干活在服务端（`apps/server/src/report-tools.ts`）。
 *
 * 周报 / 日报 / 月报都不是固定功能：用户说「每周五 17 点给我出一份……」，AI 用官方「自动化任务」建一条定时
 * （`schedule_create`，提示词就是用户的要求），到点那次运行里用下面四个工具取数、出报告；改格式 = AI 改那条
 * 定时的提示词（`schedule_update`）。工具名字与描述**不带平台、不带客户**。
 *
 * | 工具 | 干什么 |
 * |---|---|
 * | `query_watch_items` | 查巡查入库的条目：时间窗、自家 / 外部、判断档、话题、关键词、有效 VOC / UGC；计数与按话题归组 |
 * | `run_watch_now` | 现在巡查一次并等它做完（出报告前要最新数据时） |
 * | `query_sent_records` | 查我们发出去的条目（发出记录）：时间窗 / 渠道 / 动作，计数与链接 |
 * | `publish_report` | 发布一份报告到这个岗位的报表区；同一系列同一周期再发 = 同一份的新版本 |
 * | `list_competitor_changes` | WP392：查竞品变化表（上新 / 下架 / 改价 / 打折 / 断货 / 评分 / 评论数 / 排名）：按竞品、种类、时间窗、来源筛 |
 */
import type { ToolDef } from '@agentsws/contracts'

export const QUERY_WATCH_ITEMS_TOOL = 'query_watch_items'
export const RUN_WATCH_NOW_TOOL = 'run_watch_now'
export const QUERY_SENT_RECORDS_TOOL = 'query_sent_records'
export const PUBLISH_REPORT_TOOL = 'publish_report'
/** WP392（docs/104）：竞品变化表（竞品监控那份数据口；只给担竞品监控的职责）。 */
export const LIST_COMPETITOR_CHANGES_TOOL = 'list_competitor_changes'

/** 四个工具（排好序：`tools.allow` 要字节稳定）。 */
export const REPORT_TOOL_NAMES: readonly string[] = [
  LIST_COMPETITOR_CHANGES_TOOL,
  PUBLISH_REPORT_TOOL,
  QUERY_SENT_RECORDS_TOOL,
  QUERY_WATCH_ITEMS_TOOL,
  RUN_WATCH_NOW_TOOL,
].sort()

/** 跟巡查有关的那两个（只给担巡查那几条职责的运行）。 */
export const WATCH_TOOL_NAMES: readonly string[] = [QUERY_WATCH_ITEMS_TOOL, RUN_WATCH_NOW_TOOL]

/** WP392：竞品变化表那一个（只给担竞品监控的职责：店铺管理、Amazon 店铺运营）。 */
export const COMPETITOR_TOOL_NAMES: readonly string[] = [LIST_COMPETITOR_CHANGES_TOOL]

const PERIOD = {
  period: {
    type: 'string',
    enum: [
      'today',
      'yesterday',
      'this_week',
      'last_week',
      'last_7_days',
      'this_month',
      'last_month',
    ],
    description:
      '时间窗（不给 = 最近 7 天；给了 since / until 就以它们为准）。到点提醒是关机后补跑的（提醒里的 occurrence_at 早于现在），按 occurrence_at 用 since / until 定窗口',
  },
  week_start: {
    type: 'integer',
    description: '一周从周几起：0 周日、1 周一（默认）… 6 周六。用户说「周日到周五」就给 0',
  },
  since: { type: 'string', description: '起：ISO 时间或本地日期 YYYY-MM-DD' },
  until: { type: 'string', description: '止：ISO 时间或本地日期 YYYY-MM-DD（含那一天）' },
}

const BASE_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: QUERY_WATCH_ITEMS_TOOL,
    description:
      '查巡查入库的条目：自家版块 / 频道（scope=own）的帖子与评论、外部社区关键词命中（scope=external）。' +
      '按时间窗筛（按平台上的发出时间），回计数（帖子 / 评论、自家 / 外部、有效 VOC / UGC）和原文引用（作者、地点、时间、链接）；' +
      '可按判断档（follow_up 需跟进 / no_action 日常讨论无需处理 / low_relevance 相关度不高不建议回复）、话题、关键词、' +
      '有效 VOC / UGC、「优先」（命中告警词）、本地标签筛，group_by=topic 按话题归组（每组带 post / comment 数和组里最重的判断档）。' +
      '只读；数字是数出来的，写报告时照抄，不要估。被删的原文照样计数但不引用。结果里的 window.start_date 可作发布报告的 period_start。',
    input_schema: {
      type: 'object',
      properties: {
        ...PERIOD,
        platform: {
          type: 'string',
          description:
            '哪个平台（不给 = 这个岗位配的那一个；competitor = 竞品监控比出来的变化；all = 配了的全部一起查）',
        },
        scope: { type: 'string', enum: ['own', 'external'], description: '自家 / 外部' },
        assessment: {
          type: 'array',
          items: { type: 'string', enum: ['follow_up', 'no_action', 'low_relevance'] },
          description: '只要这几档',
        },
        topic: { type: 'string', description: '话题概括里含这几个字' },
        keyword: { type: 'string', description: '命中的关键词' },
        signal: {
          type: 'string',
          enum: ['voc', 'ugc', 'any'],
          description: '只要判过有效的 VOC / UGC（any = 两样有一样）',
        },
        kind: {
          type: 'string',
          enum: ['post', 'comment', 'change'],
          description: 'change = 只要竞品变化',
        },
        priority: {
          type: 'boolean',
          description: 'true = 只要命中告警词的「优先」条目（巡查设置里的告警词，本地匹配）',
        },
        tag: {
          type: 'string',
          description: '只要带这个本地标签的（巡查设置里的标签词，如型号写法）',
        },
        group_by: { type: 'string', enum: ['topic'], description: '按话题归组' },
        limit: { type: 'number', description: '列几条原文（每组 / 总共；默认 30，最多 200）' },
      },
    },
  },
  {
    name: RUN_WATCH_NOW_TOOL,
    description:
      '现在巡查一次（收件箱、自家版块、外部关键词），等它做完再回（最多等几分钟；已经在跑的那一轮直接等它）。' +
      '出报告前想要最新数据时用；没读成的那几块会照实说，照样可以用已入库的数据出报告。只读；外部关键词按条计积分。',
    input_schema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: '哪个平台（不给 = 这个岗位配的那一个）' },
      },
    },
  },
  {
    name: QUERY_SENT_RECORDS_TOOL,
    description:
      '查我们发出去的条目（发出记录：回复、评论、发帖、邮件、消息…）。按时间窗、渠道、动作筛，' +
      '回计数（按动作；回帖子 / 回评论 / 发帖）和每条的时间、发到哪、原帖标题、我们那一条的链接。只读；默认只算已发出的。',
    input_schema: {
      type: 'object',
      properties: {
        ...PERIOD,
        channel: {
          type: 'string',
          description: '渠道：reddit / email / x / discord …（不给 = 全部）',
        },
        actions: {
          type: 'array',
          items: { type: 'string' },
          description: '只要这些动作：reply / comment / post / email …',
        },
        limit: { type: 'number', description: '列几条（默认 50）' },
      },
    },
  },
  {
    name: PUBLISH_REPORT_TOOL,
    description:
      '发布一份报告到这个岗位的报表区（看一眼就过，不进审批队列）：标题、周期、Markdown 正文。' +
      '同一系列（series，不给就用标题）同一周期（period_start）再发，就是同一份的新版本。' +
      '报表区上能复制整份、导出 .md；记录去处里点名要报告（动作 report）的表会记一行。' +
      '正文里的数字与原文要来自查数据的工具；分几节、什么顺序、怎么叫，照用户的要求写。',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '标题' },
        period: { type: 'string', description: '覆盖哪段时间（人看的一句，如 10/11 – 10/16）' },
        period_start: {
          type: 'string',
          description: '周期从哪天起（YYYY-MM-DD；查数据工具回的 window.start_date）',
        },
        markdown: { type: 'string', description: '正文（Markdown）' },
        series: {
          type: 'string',
          description: '系列名（同一份报告每期都用同一个，例如「r/xxx 周报」）',
        },
      },
      required: ['title', 'period', 'markdown'],
    },
  },
]

/** WP392：竞品变化表（报告积木的数据口之一）。 */
const LIST_COMPETITOR_CHANGES_DEF: ToolDef = {
  name: LIST_COMPETITOR_CHANGES_TOOL,
  description:
    '查竞品变化表：竞品独立站和 Amazon 对标款跟上一次比出来的变化——上新、下架、改价、开始 / 结束打折（含优惠券）、' +
    '断货 / 补货、评分、评论数、排名。按竞品、变化种类、时间窗（按发现时间）、来源（独立站 / Amazon）筛；' +
    '回计数（按种类、按竞品）和每条的标题、链接、前后值、幅度、时间、一句人话，写了对标款的还有「比自家贵 / 便宜多少」；' +
    '也回各家这次读没读到（没读到的照实写进报告，不要当成「没变化」）。只读；数字是数出来的，写报告时照抄。' +
    '第一次读只建底子不出变化；什么算重要由用户定，这里不判。',
  input_schema: {
    type: 'object',
    properties: {
      ...PERIOD,
      competitor: { type: 'string', description: '竞品名或 id（不给 = 全部）' },
      kinds: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'new',
            'removed',
            'price',
            'discount_start',
            'discount_end',
            'out_of_stock',
            'back_in_stock',
            'rating',
            'reviews',
            'bsr',
          ],
        },
        description: '只要这几种变化',
      },
      source: {
        type: 'string',
        enum: ['shop', 'amazon'],
        description: '只要独立站（shop）/ Amazon 的',
      },
      limit: { type: 'number', description: '列几条（默认 50，最多 200）' },
    },
  },
}

export const REPORT_TOOL_DEFS: readonly ToolDef[] = [...BASE_TOOL_DEFS, LIST_COMPETITOR_CHANGES_DEF]

export const REPORT_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  REPORT_TOOL_DEFS.map((d) => [d.name, d]),
)
