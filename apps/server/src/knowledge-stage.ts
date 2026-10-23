/**
 * WP488（决策 1700 = B、1704 = C）：**售前 / 售后由 AI 判**——带副作用的那一半（提示词与认回话在
 * `@agentsws/support-core` 的 `stage-ai.ts`）。
 *
 * - {@link StageJudge.retrieval}：回客户之前（邮件草稿、在线聊天、邮件自动回、岗位问答、运行里查政策），
 *   **一律先问 AI** 这封 / 这段是售前还是售后。便宜：这个品牌最便宜的那一档模型、短提示、只回一个词、不思考；
 *   **同一条线程 / 会话只问一次**（缓存 24 小时）。模型出错 / 没接 / 撞了网关上限 → 退回规则（`stageOfText`）；
 *   AI 说拿不准、或规则也判不出 → 不给范围（两边都取）。
 * - {@link StageJudge.batch}：一批知识条目（FAQ 整表 / 品牌种子整批）**一次调用**判完各归哪一份。
 *   开跑前按条数估花费、撞上限就不问；出错 / 回话对不上 → `undefined`（调用方退回规则）。
 *
 * 不看系统时钟、不碰网络：时钟与模型都由调用方注入。
 */
import { createHash } from 'node:crypto'
import type { Clock, KnowledgeStage, WorkspaceId } from '@agentsws/contracts'
import { stageOfText } from '@agentsws/contracts'
import {
  parseStageAnswer,
  parseStageBatch,
  STAGE_BATCH_ITEM_CHARS,
  STAGE_BATCH_MAX,
  stageBatchPrompt,
  stageQuestionPrompt,
} from '@agentsws/support-core'

/** 判范围用的模型（这个品牌最便宜的那一档；没接回 `undefined`）。 */
export interface StageModel {
  complete(prompt: string, opts: { run_id: string; max_output_tokens: number }): Promise<string>
  /** N 次调用、每次多少字输入、多少 token 输出的估算花费；没价回 `undefined`。 */
  estimate?(calls: number, inputChars: number, outputTokens: number): number | undefined
  /** 网关这个月的用量与上限；没设上限回 `undefined`。 */
  budget?(): Promise<{ used: number; cap: number; frozen: boolean } | undefined>
}

export interface StageJudgeDeps {
  clock: Clock
  model(ws: WorkspaceId): Promise<StageModel | undefined>
  /** 同一条线程的结论缓存多久（默认 24 小时：线程可能从售前走到售后）。 */
  ttlMs?: number
  /** 缓存最多几条（满了丢最旧的）。 */
  max?: number
  log?(line: string): void
}

export type StageVerdict = 'presales' | 'postsales' | undefined

export interface StageJudge {
  /** 这封 / 这段是售前还是售后（`key` = 线程 / 会话 id；不给按正文 hash）。 */
  judge(ws: WorkspaceId, text: string, key?: string): Promise<StageVerdict>
  /** 直接摊进检索入参的那一格（判不出就是空对象 = 两边都取）。 */
  retrieval(
    ws: WorkspaceId,
    text: string,
    key?: string,
  ): Promise<{ stage?: 'presales' | 'postsales' }>
  /** 一批条目各归哪一份（与入参同序）；问不成回 `undefined`（调用方退回规则）。 */
  batch(ws: WorkspaceId, items: readonly string[]): Promise<KnowledgeStage[] | undefined>
}

const DAY_MS = 86_400_000
/** 退回规则那一次只记 5 分钟（模型恢复了就再问）。 */
const FALLBACK_TTL_MS = 5 * 60_000

const overCap = (
  cost: number | undefined,
  b: { used: number; cap: number; frozen: boolean } | undefined,
): boolean => b !== undefined && (b.frozen || (b.cap > 0 && b.used + (cost ?? 0) > b.cap))

export function createStageJudge(deps: StageJudgeDeps): StageJudge {
  const ttl = deps.ttlMs ?? DAY_MS
  const max = deps.max ?? 5000
  const cache = new Map<string, { at: number; ttl: number; verdict: StageVerdict }>()
  let seq = 0
  const now = (): number => Date.parse(deps.clock.now())
  const keyOf = (ws: string, text: string, key: string | undefined): string =>
    `${ws}|${key ?? `h:${createHash('sha256').update(text).digest('hex').slice(0, 24)}`}`
  const remember = (k: string, verdict: StageVerdict, life: number): StageVerdict => {
    cache.delete(k)
    cache.set(k, { at: now(), ttl: life, verdict })
    while (cache.size > max) {
      const first = cache.keys().next().value
      if (first === undefined) break
      cache.delete(first)
    }
    return verdict
  }

  const judge: StageJudge['judge'] = async (ws, text, key) => {
    if (text.trim() === '') return undefined
    const k = keyOf(ws, text, key)
    const hit = cache.get(k)
    if (hit !== undefined && now() - hit.at < hit.ttl) return hit.verdict
    const fallback = (): StageVerdict => remember(k, stageOfText(text), FALLBACK_TTL_MS)
    const model = await deps.model(ws).catch(() => undefined)
    if (model === undefined) return fallback()
    const budget = await model.budget?.().catch(() => undefined)
    if (overCap(model.estimate?.(1, 600, 4), budget)) return fallback()
    try {
      seq += 1
      const answer = await model.complete(stageQuestionPrompt(text), {
        run_id: `stage_${now().toString(36)}_${String(seq)}`,
        max_output_tokens: 8,
      })
      // AI 说拿不准 → 两边都取（不再拿规则硬判）
      return remember(k, parseStageAnswer(answer), ttl)
    } catch (e) {
      deps.log?.(
        `[knowledge-stage] 判售前售后没成，退回规则：${e instanceof Error ? e.message : String(e)}`,
      )
      return fallback()
    }
  }

  const batch: StageJudge['batch'] = async (ws, items) => {
    if (items.length === 0) return []
    const model = await deps.model(ws).catch(() => undefined)
    if (model === undefined) return undefined
    const chunks: string[][] = []
    for (let i = 0; i < items.length; i += STAGE_BATCH_MAX)
      chunks.push(items.slice(i, i + STAGE_BATCH_MAX))
    const cost = model.estimate?.(
      chunks.length,
      800 + Math.min(items.length, STAGE_BATCH_MAX) * (STAGE_BATCH_ITEM_CHARS + 20),
      Math.min(items.length, STAGE_BATCH_MAX) * 6 + 20,
    )
    if (overCap(cost, await model.budget?.().catch(() => undefined))) return undefined
    const out: KnowledgeStage[] = []
    for (const chunk of chunks) {
      try {
        seq += 1
        const text = await model.complete(stageBatchPrompt(chunk), {
          run_id: `stage_batch_${now().toString(36)}_${String(seq)}`,
          max_output_tokens: chunk.length * 6 + 40,
        })
        const got = parseStageBatch(text, chunk.length)
        if (got === undefined) return undefined
        out.push(...got)
      } catch (e) {
        deps.log?.(
          `[knowledge-stage] 整批判范围没成，退回规则：${e instanceof Error ? e.message : String(e)}`,
        )
        return undefined
      }
    }
    return out
  }

  return {
    judge,
    async retrieval(ws, text, key) {
      const stage = await judge(ws, text, key)
      return stage === undefined ? {} : { stage }
    },
    batch,
  }
}

/**
 * 这个品牌「最便宜的那一档」：网关上挂着的文字模型里单价（输入 + 输出）最低、且标了价的那一个；
 * 都没标价就用 `extraction` 那一档（缺省就是默认模型）。stub 不算（stub 回的是假话）。
 */
export function cheapestRef<R extends { provider: string; model: string }>(
  candidates: readonly R[],
  priceOf: (ref: R) => { in: number; out: number } | undefined,
  fallback: R | undefined,
): R | undefined {
  const usable = candidates.filter(
    (r) => r.provider !== 'stub' && !/embed|whisper|tts|transcri|image|vision-only/i.test(r.model),
  )
  let best: { ref: R; price: number } | undefined
  for (const ref of usable) {
    const p = priceOf(ref)
    if (p === undefined || p.in + p.out <= 0) continue
    const price = p.in + p.out
    if (best === undefined || price < best.price) best = { ref, price }
  }
  if (best !== undefined) return best.ref
  return fallback === undefined || fallback.provider === 'stub' ? undefined : fallback
}
