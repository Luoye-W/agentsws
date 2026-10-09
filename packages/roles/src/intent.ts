/**
 * WP287（Luoye 10-09 真机）：岗位输入框里的一句话，是**问**还是**交办**。
 *
 * 「现在店铺里有哪些产品」——是问，当场答一句就完了；以前它被开成一件「进行中」的事项，
 * 点进去还要人选职责。这里只做那一下判断，纯函数、不调模型（测试与模拟都不联网）：
 *
 * 1. 问「怎么做」（`怎么 / 如何 / 怎样` 打头）→ 问（教人怎么做是答得出来的）；
 * 2. 有要动手的词（改、发、写、做一份、上架、退款、回复…）→ 交办；
 *    说的是已经发生的（「发了几封」「改过吗」）不算动手；
 * 3. 一大段（多行或 ≥ 80 字）还没问号 → 交办（那是在写需求）；
 * 4. 其余一律按问——**判不准时先答**；答的过程中真要动手，宿主再把它转成一件事。
 */

export type EntryIntent = 'ask' | 'task'

export interface EntryIntentResult {
  intent: EntryIntent
  /** 为什么这么判（测试与排障用，不上界面） */
  why: 'how_to' | 'action' | 'long' | 'question' | 'default'
}

const HOW_TO = /^(请问|想问一下|问一下)?(我)?(该|要|应该)?(怎么|怎样|如何)/u

/** 要动手的词（中文）。只认「要人或 AI 去改变什么」的，查 / 看 / 统计 / 分析都不在里面。 */
const ACTION_ZH =
  /(修改|改成|改一下|改个|改下|改价|调价|调整|更新|上架|下架|发布|上线|发给|发出|发一|发个|发封|发条|发帖|发邮件|发消息|群发|回复|回一下|回个|起草|草拟|写一|写个|写篇|写份|写封|写条|做一|做个|做份|做套|做张|做篇|创建|新建|新增|添加|加一|加个|加上|生成|设计|搭建|搭一|删掉|删除|删了吧|退款|补发|取消订单|打折|设置成|设成|安排|排期|整理成|整理一份|出一|出个|出份|出张|出篇|申请|上传|导出|提交|跟进|联系一下|去联系|处理一下|帮我处理|优化|翻译|制作|剪辑|投放|开一个|开个|下单|批量|替换|同步到|迁移|安装|配置|接入|授权|策划|调研|改)/u

const ACTION_EN =
  /\b(create|update|change|edit|publish|send|reply|write|draft|build|make|delete|remove|refund|cancel|set up|setup|schedule|launch|post|upload|export|add|design|generate|fix|optimi[sz]e|translate|rename|install|configure)\b/iu

/** 说的是已经发生的动作（「发了几封」「改过吗」「上架的商品」）——是问，不是要动手。 */
const PAST_ACTION =
  /(改|发|写|做|建|删|加|上架|下架|发布|回复|退款|处理|安排|设置|更新)(了|过|的)/gu

const QUESTION =
  /([?？]|吗|么$|呢$|哪些|哪个|哪里|哪儿|多少|几个|几单|几件|几条|几封|几天|什么|啥|怎么样|为什么|为啥|是否|有没有|是不是|能不能|可不可以|查一下|查查|查询|看看|看一下|看下|列一下|列出|告诉我|说说|讲讲|统计|现在|目前|最近|今天|昨天|本周|这周|上周)/u

const QUESTION_EN =
  /^(what|how|which|who|when|where|why|is|are|do|does|did|can|could|list|show|tell)\b/iu

/** 一大段话（在写需求）的门槛：多行，或这么多字以上。 */
export const LONG_TASK_CHARS = 80

export function classifyEntryIntent(text: string): EntryIntentResult {
  const bare = text.normalize('NFKC').trim()
  if (HOW_TO.test(bare)) return { intent: 'ask', why: 'how_to' }
  const acting = bare.replace(PAST_ACTION, '')
  if (ACTION_ZH.test(acting) || ACTION_EN.test(acting)) return { intent: 'task', why: 'action' }
  const asking = QUESTION.test(bare) || QUESTION_EN.test(bare)
  const long = bare.includes('\n') || Array.from(bare).length >= LONG_TASK_CHARS
  if (long && !/[?？]\s*$/u.test(bare)) return { intent: 'task', why: 'long' }
  return { intent: 'ask', why: asking ? 'question' : 'default' }
}
