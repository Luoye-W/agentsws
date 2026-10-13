/**
 * WP299（决策 386 / 387）：红人合作上的两种「花钱」——**寄样成本**与**付款**。
 *
 * 两样都是一张 money 排版的卡（`kol_sample` / `kol_payment` 在 15 §2 的 `HARD_L1` 里，永远人审），
 * 批了才落库：寄样落 `Collaboration.sample`、合作从「谈成」进「已寄样」；付款往
 * `Collaboration.payments` 里追加一笔。提卡在 `kol-service.ts`，落库在这里（同 `kolQuoteApply`）。
 *
 * **收件地址不进账本**：变更的 `after` 里只有加密库的 key 名与脱敏样子，明文只在本机加密库。
 */
import type { Collaboration, KolPayment, KolSample } from '@agentsws/contracts'
import type { KolStore } from './kol.js'

/** 加密库里寄样地址那一段的 key 前缀。**全仓只有这一处拼它**。 */
export const SAMPLE_SECRET_PREFIX = 'kol.sample.'

/** 寄样地址在加密库那条记录里的字段名。 */
export const SAMPLE_SECRET_FIELD = 'address'

/** 能寄样的阶段：谈成之后（已寄样的可以补登快递单号、重寄一份）。 */
export const SAMPLE_STAGES: readonly string[] = ['agreed', 'sample_sent']

/** 能登记付款的阶段：谈成之后（含交付中、已交付、已结案——尾款常在交付后付）。 */
export const PAYMENT_STAGES: readonly string[] = [
  'agreed',
  'sample_sent',
  'delivering',
  'delivered',
  'closed',
]

/**
 * 脱敏的收件地址：只留「名字首字母 + 最后两段（城市、国家）」——认得出是哪一份，拼不回去。
 * `Jonas Weber, Hauptstr. 5, 10115 Berlin, DE` → `J*** · 10115 Berlin, DE`
 */
export function maskAddress(address: string): string {
  const parts = address
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
  if (parts.length === 0) return ''
  const head = `${(parts[0] ?? '').slice(0, 1)}***`
  if (parts.length === 1) return head
  return `${head} · ${parts.slice(-2).join(', ')}`
}

/** 合作上已经花了多少（批过的付款 + 批过的寄样成本）。 */
export function spentOn(row: Pick<Collaboration, 'payments' | 'sample'>): number {
  const paid = (row.payments ?? []).reduce((sum, p) => sum + p.amount, 0)
  return Math.round((paid + (row.sample?.cost ?? 0)) * 100) / 100
}

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined

type Applied = { status: 'ok'; execution_id: string; outcome_ref: { type: string; id: string } }

/** 寄样卡批了 → 落 `sample`，「谈成」推到「已寄样」。不是这种卡回 `undefined`。 */
export function kolSampleApply(
  brand: { kol?: Pick<KolStore, 'collaboration' | 'saveCollaboration'> } | undefined,
  change: { id: string; kind: string; after?: unknown },
  now: () => string,
): Applied | undefined {
  if (change.kind !== 'kol_sample') return undefined
  const store = brand?.kol
  const after = rec(change.after)
  const id = typeof after?.collaboration_id === 'string' ? after.collaboration_id : undefined
  const sample = rec(after?.sample) as KolSample | undefined
  if (store === undefined || id === undefined || sample === undefined) return undefined
  const row = store.collaboration(id)
  if (row === undefined) return undefined
  store.saveCollaboration(withSample(row, sample, now()))
  return {
    status: 'ok',
    execution_id: `ex_kol_sample_${change.id}`,
    outcome_ref: { type: 'collaboration', id },
  }
}

/** 付款卡批了 → 往 `payments` 里追加这一笔（同一条变更只落一次）。不是这种卡回 `undefined`。 */
export function kolPaymentApply(
  brand: { kol?: Pick<KolStore, 'collaboration' | 'saveCollaboration'> } | undefined,
  change: { id: string; kind: string; after?: unknown },
  now: () => string,
): Applied | undefined {
  if (change.kind !== 'kol_payment') return undefined
  const store = brand?.kol
  const after = rec(change.after)
  const id = typeof after?.collaboration_id === 'string' ? after.collaboration_id : undefined
  const payment = rec(after?.payment) as KolPayment | undefined
  if (store === undefined || id === undefined || payment === undefined) return undefined
  const row = store.collaboration(id)
  if (row === undefined) return undefined
  // 执行器重试同一条变更：同一笔不记两遍
  if (!(row.payments ?? []).some((p) => p.change_id === change.id))
    store.saveCollaboration({
      ...row,
      payments: [...(row.payments ?? []), { ...payment, change_id: change.id }],
      last_activity_at: now(),
    })
  return {
    status: 'ok',
    execution_id: `ex_kol_payment_${change.id}`,
    outcome_ref: { type: 'collaboration', id },
  }
}

/** 把一次寄样落到合作上（没成本当场记、有成本批了再记，两条路同一个写法）。 */
export function withSample(row: Collaboration, sample: KolSample, at: string): Collaboration {
  return {
    ...row,
    sample,
    // 只从「谈成」往前推一步；已经在「已寄样」或更后面的不动（补登单号不倒退阶段）
    stage: row.stage === 'agreed' ? 'sample_sent' : row.stage,
    last_activity_at: at,
  }
}
