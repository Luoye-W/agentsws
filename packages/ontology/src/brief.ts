/**
 * 47 J1 / J3：**给模型的那一份**。
 *
 * 同一份裁剪结果有两个形态——界面拿 JSON（`ontologyFor`），模型拿这段中文。
 * 它进 prompt 的静态前缀，所以两条硬要求：
 *
 * 1. **短**：`BRIEF_MAX_CHARS` 是硬上限，超了就砍对象清单的尾巴，
 *    不能让登记表把工作项上下文挤出预算（17 §1 装配顺序）。
 * 2. **稳**：同一份输入两次渲染逐字节相同——静态前缀的字节不稳，prompt 缓存就没了
 *    （22 §2），`prompt.assembled.hash` 的回放校验也会红（17 §6.1）。
 *
 * 最后那一段是 47 J3 指定的固定话，**从登记表生成、不手写**：它在代码里只有这一处，
 * 三个运行时都从 `assemblePrompt` 拿同一份，界面上的说明也是同一句。
 */
import type { Range, RiskClass } from '@agentsws/contracts'
import type { Freshness, SourceOfTruth, TailoredOntology } from './types.js'

/** 上限（字符）。47 J1 写的"≤ 1500 字"。 */
export const BRIEF_MAX_CHARS = 1500

/**
 * 47 J3 的固定话。调用顺序是登记表的结论——操作层实时、知识层会过时，
 * 所以矛盾时以操作层为准，并且**必须把矛盾说出来**（说出来才有 24 的学习回路吃）。
 */
export const ORDER_RULE =
  '回答关于某个客户 / 订单的问题，先查它的当前状态，再查相关政策；' +
  '两者矛盾以当前状态为准，并把矛盾报出来。'

const RANGE_TEXT: Record<Range, string> = {
  own: '只有我自己的',
  assigned: '我负责的范围',
  workspace: '整个工作区',
}

const SOURCE_TEXT: Record<SourceOfTruth, string> = {
  platform_api: '平台',
  connector: '连接器',
  local_ledger: '本地账本',
  human: '人写的',
}

const RISK_TEXT: Record<RiskClass, string> = { low: '低', medium: '中', high: '高' }

export function freshnessText(f: Freshness): string {
  if (f === 'realtime') return '实时'
  if (f === 'authored') return '人写的'
  const seconds = Number.parseInt(f.slice('cached:'.length), 10)
  return seconds % 60 === 0 ? `缓存 ${seconds / 60} 分钟` : `缓存 ${seconds} 秒`
}

const HEAD = '# 你能查什么、能做什么（本体登记表，按你的岗位裁剪）'
const OBJECTS_HEAD = '## 能查（只读，按你的范围自动过滤）'
const ACTIONS_HEAD = '## 能做（只提议，批了才算数）'
const ORDER_HEAD = '## 顺序'

/** 一行对象。`read_via` 最多列三个——列全了模型也只会用第一个。 */
function objectLine(o: TailoredOntology['objects'][number]): string {
  const via = o.read_via.slice(0, 3)
  const tail = via.length === 0 ? '' : `；用 ${via.join(' / ')}`
  const where = o.read_range === undefined ? '' : `，看得到${RANGE_TEXT[o.read_range]}`
  return `- ${o.label}：${SOURCE_TEXT[o.source_of_truth]}，${freshnessText(o.freshness)}${where}${tail}`
}

function actionLine(a: TailoredOntology['actions'][number]): string {
  const approval = a.requires_approval ? '要人批' : '额度内可自动'
  return `- ${a.tool ?? a.id}：${a.label}，风险${RISK_TEXT[a.risk_class]}，${approval}`
}

function render(tailored: TailoredOntology, objectLines: readonly string[]): string {
  const objects = objectLines.length === 0 ? ['- （这条岗位没有任何只读对象。）'] : objectLines
  const actions =
    tailored.actions.length === 0
      ? ['- （你没有可提议的写动作；需要改动就把情况说清楚，交给人。）']
      : tailored.actions.map(actionLine)
  return [
    HEAD,
    '',
    OBJECTS_HEAD,
    ...objects,
    '',
    ACTIONS_HEAD,
    ...actions,
    '',
    ORDER_HEAD,
    ORDER_RULE,
  ].join('\n')
}

/**
 * 渲染给模型的紧凑文本。超上限时**只砍对象清单的尾巴**：动作与顺序那两段是纪律，
 * 砍掉了模型就不知道自己能提什么、该按什么顺序查。
 */
export function ontologyBrief(tailored: TailoredOntology, max = BRIEF_MAX_CHARS): string {
  const lines = tailored.objects.map(objectLine)
  let text = render(tailored, lines)
  while (text.length > max && lines.length > 0) {
    lines.pop()
    const kept = [
      ...lines,
      `- （还有 ${tailored.objects.length - lines.length} 类没列，用得上时问一声。）`,
    ]
    text = render(tailored, kept)
    if (text.length <= max) return text
  }
  return text.length > max ? text.slice(0, max) : text
}
