/**
 * 免费默认会议助手 = 内核自带的第一个 `MeetingProcessor`（23 扩展点 `meeting.processor`）。
 *
 * 它和第三方的处理器走**同一个接口**——付费增强与第三方应用只要注册一个同名或另一个
 * `MeetingProcessor` 就能替换或叠加（37 §4.2）。默认版靠规则（`extract.ts`）；
 * 模型抽取是可注入的 `refine` 回调：给了就在规则产出之上再补一层，不给就零模型调用。
 *
 * 两条不许破的：
 * - **只读围栏后的文本**。`input.fenced_text` 是宿主包好的；处理器不许拆围栏，也拿不到音频字节。
 * - **每条产出必须带出处**（`provenance`：哪份记录、原话、谁说的、第几秒）。
 */
import type {
  MeetingProcessor,
  MeetingProcessorInput,
  MeetingProcessorOutput,
} from '@agentsws/contracts'
import {
  extractBoundaryAnswers,
  extractDecisions,
  extractKnowledge,
  extractNextMeeting,
  extractTodos,
  utterances,
} from './extract.js'

export const DEFAULT_PROCESSOR_ID = 'agentsws/default-meeting-assistant'

/**
 * 模型抽取的注入点。宿主可以给一个"拿围栏文本去问模型、回一份产出"的回调；
 * 默认版不给，因此**免费默认层不产生任何模型调用**（也就没有出境与预算问题）。
 */
export type MeetingRefine = (
  input: MeetingProcessorInput,
  rules: MeetingProcessorOutput,
) => Promise<MeetingProcessorOutput> | MeetingProcessorOutput

export interface DefaultMeetingAssistantOptions {
  refine?: MeetingRefine
  /** 产出 id 的前缀（默认 `mo`）；给同一份记录重复处理时保持稳定。 */
  idPrefix?: string
}

/** 外部参与者的所有称呼——他们说的话不进知识库（19：客户原话永远不是知识）。 */
function externalSpeakers(input: MeetingProcessorInput): string[] {
  const out: string[] = []
  for (const p of input.meeting.participants) {
    if (p.external !== true) continue
    for (const v of [p.name, p.email, p.person_id]) if (v !== undefined && v !== '') out.push(v)
  }
  return out
}

export function defaultMeetingAssistant(
  options: DefaultMeetingAssistantOptions = {},
): MeetingProcessor {
  const prefix = options.idPrefix ?? 'mo'
  return {
    id: DEFAULT_PROCESSOR_ID,
    name: { zh: '默认会议助手', en: 'Default meeting assistant' },
    async process(input) {
      const us = utterances(input.transcript.segments ?? [])
      const rid = input.record.id
      const id = (kind: string) => (n: number) => `${prefix}_${kind}_${rid}_${n + 1}`
      const next = extractNextMeeting(us, rid)
      const rules: MeetingProcessorOutput = {
        decisions: extractDecisions(us, rid, id('dec')),
        todos: extractTodos(us, {
          record_id: rid,
          participants: input.meeting.participants,
          now: input.now,
          id: id('todo'),
        }),
        boundary_answers: extractBoundaryAnswers(us, rid, id('bnd')),
        knowledge: extractKnowledge(us, {
          record_id: rid,
          externalSpeakers: externalSpeakers(input),
          id: id('kb'),
        }),
        ...(next === undefined ? {} : { next_meeting: next }),
      }
      return options.refine === undefined ? rules : await options.refine(input, rules)
    },
  }
}
