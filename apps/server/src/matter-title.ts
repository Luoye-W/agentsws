/**
 * WP264（决策 177 / 184）：事项**短标题**——首轮开跑时便宜模型单独起一次。
 *
 * - 只在这件事**第一次**开跑时起（时间线上还没有运行）；老事项、跑过的事项不动。
 * - 起好了记 `title_source: 'ai'`；没接模型 / 模型抛错 / 回了空话 → 退回原话前 20 字（`brief`）。
 * - 人在事项页上改过（`user`）的永远不覆盖（`Work.retitle` 再判一次：起标题途中人改了也不盖）。
 * - 不阻塞开跑：起标题与运行并行，失败不影响运行。原话进提示词前围栏、截断（那是数据不是指令）。
 */
import {
  cleanShortTitle,
  fallbackShortTitle,
  type Matter,
  type MatterId,
  shortTitlePrompt,
} from '@agentsws/contracts'
import { EXTERNAL_FENCE } from '@agentsws/core'
import type { Work } from '@agentsws/work'

/** 原话最多收多少字进提示词（起标题看开头一段就够了）。 */
export const MAX_TITLE_INPUT = 1500

/** 「拿一段字」的口子：给提示词回模型那句话；没接模型时整个口子是 `undefined`。 */
export type TitleComplete = (prompt: string, actor: { assignment_id: string }) => Promise<string>

export interface MatterTitlerOptions {
  /** 晚绑定：`Work` 与 `startRun` 互相需要。 */
  work: () => Pick<Work, 'getMatter' | 'retitle' | 'store'> | undefined
  /** 每次现取（模型设置改了下一次就生效）；没接真模型回 `undefined`。 */
  complete: () => TitleComplete | undefined
}

export interface MatterTitler {
  /**
   * 开跑前调一次。是这件事的第一次运行、还没起过标题才起；返回那次起标题的 Promise
   * （给测试等；正式调用方不等它）。不用起时回 `undefined`。
   */
  kick(input: {
    matter: Matter
    brief: string
    actor: { assignment_id: string }
  }): Promise<void> | undefined
}

export function createMatterTitler(options: MatterTitlerOptions): MatterTitler {
  const inflight = new Set<MatterId>()

  const firstRun = (matter_id: MatterId): boolean => {
    const work = options.work()
    if (work === undefined) return false
    return !work.store.listMatterEvents(matter_id, { limit: 500 }).some((e) => e.kind === 'run')
  }

  const settle = async (matter: Matter, brief: string, actor: { assignment_id: string }) => {
    const complete = options.complete()
    let title = ''
    if (complete !== undefined) {
      const fenced = `${EXTERNAL_FENCE.open}\n${EXTERNAL_FENCE.sanitizeText(brief, MAX_TITLE_INPUT)}\n${EXTERNAL_FENCE.close}`
      try {
        title = cleanShortTitle(await complete(shortTitlePrompt(fenced), actor))
      } catch {
        title = ''
      }
    }
    const work = options.work()
    if (work === undefined) return
    try {
      if (title !== '') work.retitle(matter.id, title, 'ai')
      else work.retitle(matter.id, fallbackShortTitle(brief === '' ? matter.title : brief), 'brief')
    } catch {
      // 事项没了 / 标题空：起不出就留着原来那个，不影响运行
    }
  }

  return {
    kick({ matter, brief, actor }) {
      if (matter.title_source !== undefined || inflight.has(matter.id)) return undefined
      if (!firstRun(matter.id)) return undefined
      inflight.add(matter.id)
      return settle(matter, brief.trim(), actor).finally(() => {
        inflight.delete(matter.id)
      })
    },
  }
}
