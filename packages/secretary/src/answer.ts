/**
 * 代答（41 §1.2 第一行）：别人问"李默在做什么 / 负责哪些店 / 现在忙不忙 / 擅长什么"，
 * 问他的秘书就能答。
 *
 * 三条边界，全部在本文件里兑现：
 * 1. **只答本人设定的公开级别内的内容**——事实由调用方过滤好递进来，这里再核一遍
 *    "这个字段问方看得见吗"，看不见就回"这个要问本人"，而不是含糊其辞。
 * 2. **秘书从不透露对话正文、私有待办、个人记忆**——问到这些一律拒（不是级别问题，是边界）。
 * 3. **专业的事不归秘书**——转给对的岗位 Agent（41 §1.4）。
 *
 * 没有模型也能跑：规则版就是这份实现。装了模型的部署把同一份事实交给模型润色，
 * **判据与可见字段仍然是这里算的**——模型只负责把话说得像人话，不负责决定给不给看。
 */
import type { Iso8601 } from '@agentsws/contracts'
import { looksLikeQuestion, normalize } from './text.js'
import type { AnswerFacts, AnswerKind, ProfileField, SecretaryAnswer } from './types.js'

/** 秘书永远不答的（41 §1.2）：对话正文、私有待办、个人记忆、"和谁开会"。 */
const PRIVATE_CUES = [
  '待办',
  '私有',
  '个人记忆',
  '记忆',
  '聊天记录',
  '聊天',
  '对话',
  '消息内容',
  '私信',
  '和谁开会',
  '跟谁开会',
  '见了谁',
  '日程明细',
  '密码',
  'todo',
  'memory',
  'chatlog',
]

/** 顺序有讲究：「在忙什么」问的是在做什么，不是忙不忙，所以 doing 要排在 busy 前面。 */
const DOING_CUES = [
  '在做什么',
  '在忙什么',
  '忙什么',
  '在干什么',
  '在干嘛',
  '手上有什么',
  '手上的活',
  '在跟进',
  '在处理什么',
  '最近在做',
  '进展',
  'doing',
  'workingon',
]

const BUSY_CUES = [
  '忙不忙',
  '有空',
  '有时间',
  '什么时候有空',
  '几点有空',
  '日程',
  '安排',
  '忙吗',
  '空吗',
  '能约',
  '约个时间',
  'available',
  'busy',
  'free',
]

const SCOPE_CUES = [
  '负责',
  '管什么',
  '管哪',
  '管几',
  '岗位',
  '职责',
  '范围',
  '哪些店',
  '什么角色',
  'responsible',
  'incharge',
  'role',
]

const SKILL_CUES = ['擅长', '强项', '会什么', '特长', '技能', '专长', 'goodat', 'skill', 'expert']

const hit = (n: string, cues: readonly string[]): boolean =>
  cues.some((c) => n.includes(normalize(c)))

/**
 * 这句话在问哪一类。
 *
 * 四类能答（`doing` / `scope` / `busy` / `skills`），两类不答（`private` / `professional`），
 * 剩下的 `unknown` 一律回"这个要问本人"——秘书不猜。
 */
export function classifyQuestion(question: string): AnswerKind {
  const n = normalize(question)
  if (n === '') return 'unknown'
  if (hit(n, PRIVATE_CUES)) return 'private'
  if (hit(n, DOING_CUES)) return 'doing'
  if (hit(n, BUSY_CUES)) return 'busy'
  if (hit(n, SCOPE_CUES)) return 'scope'
  if (hit(n, SKILL_CUES)) return 'skills'
  return looksLikeQuestion(question) ? 'professional' : 'unknown'
}

/** 每一类要用到的字段。看不见其中任何一个就答不了（回"这个要问本人"）。 */
export const FIELDS_BY_KIND: Readonly<Partial<Record<AnswerKind, readonly ProfileField[]>>> =
  Object.freeze({
    doing: ['in_progress'],
    scope: ['positions', 'ranges'],
    busy: ['availability'],
    skills: ['skills'],
  })

const MINUTE_MS = 60_000

function localTime(at: Iso8601, tzOffsetMinutes: number): string {
  const d = new Date(Date.parse(at) + tzOffsetMinutes * MINUTE_MS)
  const h = `${d.getUTCHours()}`.padStart(2, '0')
  const m = `${d.getUTCMinutes()}`.padStart(2, '0')
  return `${h}:${m}`
}

function localDate(at: Iso8601, tzOffsetMinutes: number): string {
  const d = new Date(Date.parse(at) + tzOffsetMinutes * MINUTE_MS)
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
}

function sameLocalDay(a: Iso8601, b: Iso8601, tz: number): boolean {
  return localDate(a, tz) === localDate(b, tz)
}

/** 最多报几条进行中的标题（再多就只报数）。 */
export const MAX_TITLES = 3

export interface AnswerInput {
  question: string
  facts: AnswerFacts
  /** 问方看得见的字段（已按公开级别算好） */
  visible: ReadonlySet<ProfileField>
  now: Iso8601
  tz_offset_minutes: number
  /** 专业问题转给谁（由路由算） */
  refer?: SecretaryAnswer['refer_to']
}

const ASK_HIM = (name: string): string =>
  `这个要问${name}本人——秘书只答四类：他的岗位与范围、手上在做什么、忙不忙、擅长什么。`

/** 规则版代答。给同样的输入永远出同样的一句话（可回放）。 */
export function answerQuestion(input: AnswerInput): SecretaryAnswer {
  const kind = classifyQuestion(input.question)
  const name = input.facts.name
  const tz = input.tz_offset_minutes

  if (kind === 'private')
    return {
      kind,
      answer: `这个秘书不能说——私有待办、个人记忆、对话正文、跟谁开会都只有${name}本人看得到。${ASK_HIM(name)}`,
      fields: [],
      refused: true,
    }

  if (kind === 'professional') {
    const refer = input.refer
    return {
      kind,
      answer:
        refer === undefined
          ? `这是专业问题，秘书不答。${ASK_HIM(name)}`
          : `这是${refer.role_name}的专业问题，秘书不答——去问${refer.role_name}岗位的 Agent${
              refer.person_id === undefined ? '' : `（或者直接问${refer.person_id}）`
            }。`,
      fields: [],
      refused: true,
      ...(refer === undefined ? {} : { refer_to: refer }),
    }
  }

  if (kind === 'unknown') return { kind, answer: ASK_HIM(name), fields: [], refused: true }

  const needed = FIELDS_BY_KIND[kind] ?? []
  const usable = needed.filter((f) => input.visible.has(f))
  if (usable.length === 0)
    return {
      kind,
      answer: `${name}把这一项设成了只有自己可见。${ASK_HIM(name)}`,
      fields: [],
      refused: true,
    }

  if (kind === 'doing') {
    const ip = input.facts.in_progress
    if (ip === undefined || ip.count === 0)
      return {
        kind,
        answer: `${name}手上现在没有进行中的事。`,
        fields: [...usable],
        refused: false,
      }
    const titles = ip.titles
      .slice(0, MAX_TITLES)
      .map((t) => `「${t}」`)
      .join('、')
    const more = ip.count > MAX_TITLES ? `，还有 ${ip.count - MAX_TITLES} 件` : ''
    return {
      kind,
      answer: `${name}手上有 ${ip.count} 件在进行：${titles}${more}。`,
      fields: [...usable],
      refused: false,
    }
  }

  if (kind === 'scope') {
    const positions = input.visible.has('positions') ? (input.facts.positions ?? []) : []
    const ranges = input.visible.has('ranges') ? (input.facts.ranges ?? []) : []
    const roleText =
      positions.length === 0
        ? `${name}现在没有岗位分配`
        : `${name}的岗位是${positions.map((p) => p.role_name).join('、')}`
    const rangeText =
      ranges.length === 0 ? '' : `，负责范围：${ranges.map((r) => `${r.kind} ${r.id}`).join('、')}`
    return { kind, answer: `${roleText}${rangeText}。`, fields: [...usable], refused: false }
  }

  if (kind === 'busy') {
    const busy = input.facts.busy
    const today = (busy?.slots ?? []).filter((s) => sameLocalDay(s.start, input.now, tz))
    const free = busy?.next_free
    const head =
      today.length === 0
        ? `${name}今天日程是空的`
        : `${name}今天 ${today
            .map((s) => `${localTime(s.start, tz)}–${localTime(s.end, tz)}`)
            .join('、')} 有安排`
    const tail =
      free === undefined
        ? '，最近七天没找到空档'
        : sameLocalDay(free.start, input.now, tz)
          ? `，${localTime(free.start, tz)} 之后有空`
          : `，最近能约的是 ${localDate(free.start, tz)} ${localTime(free.start, tz)}`
    return { kind, answer: `${head}${tail}。`, fields: [...usable], refused: false }
  }

  const skills = (input.facts.skills ?? []).filter((s) => s.hidden !== true)
  return {
    kind,
    answer:
      skills.length === 0
        ? `${name}还没写过擅长什么。`
        : `${name}擅长：${skills.map((s) => s.name).join('、')}。`,
    fields: [...usable],
    refused: false,
  }
}
