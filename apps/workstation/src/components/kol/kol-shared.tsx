/**
 * WP117（66 断点 #5 / #6 / #7）：红人界面的三个共用件。
 *
 * 断点 #5、#6、#7 表面上是三个不同的毛病，病根是同一个：**这个岗位的界面
 * 只报成功，不报失败、也不报回执**。九个 mutation 里只有一个写了 `onError`；
 * 加一条联系方式 400 了，框里的邮箱还留在那儿，看着像成功；接受一份清单
 * 接口回了 200，清单直接消失，什么回执都没有。
 *
 * 所以这里放三件东西，红人的每一个视图都用它们，不再各写各的：
 *
 * | 件 | 管什么 |
 * |---|---|
 * | {@link KolError} | 失败照实说（`role="alert"`），**永远不吞** |
 * | {@link KolReceipt} | 成功也要有回执：做成了什么、下一步在哪 |
 * | {@link errorText} | `ApiClientError` → 一句人话（没有 message 才兜底） |
 */
import { AlertCircle, CheckCircle2 } from 'lucide-react'
import { ApiClientError } from '@/lib/api'
import { apiErrorText } from '@/lib/error-text'
import { translate } from '@/lib/i18n'

/**
 * 一个异常 → 给人看的那句话。
 *
 * 服务端的错误体里**已经有一句人话**（「还没建联就说交付完了」这种），
 * 优先用它；真的没有才兜底。不把 `code` 显示给用户——`invalid_input`
 * 对非开发者没有任何信息量。
 *
 * WP139：例外是网关自己的那几种（判权限拒的 403、501、401、429、500 internal）——
 * 它们的原文是 `无权限：creator.read（range=assigned）` 这种内部值，统一走
 * `apiErrorText` 换成人话（403「这条职责没有这项权限」与 501「这台没装」分开说）。
 */
export function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiClientError) {
    if (e.message === '') return fallback
    const human = apiErrorText(e, (k, v) => translate('zh', k, v))
    return human === e.message ? e.message : human
  }
  if (e instanceof Error && e.message !== '') return e.message
  return fallback
}

/**
 * 失败那一条。
 *
 * `role="alert"` 不是装饰：这一条是**替用户发现问题**的，读屏器要念出来。
 * `error` 为空就什么都不渲染（不占位、不留一个空框）。
 */
export function KolError({
  error,
  testid = 'kol-error',
}: {
  error: string | undefined
  testid?: string
}): React.ReactNode {
  if (error === undefined || error === '') return null
  return (
    <p
      role="alert"
      className="flex items-start gap-1 text-xs text-destructive"
      data-testid={testid}
    >
      <AlertCircle className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span>{error}</span>
    </p>
  )
}

/**
 * 成功那一条回执。
 *
 * 36 §1「说清楚发生了什么」：**接口 200 不等于用户知道发生了什么**。
 * 出了卡就说「在卡片里等你批」，建了合作就说建了几条——
 * 66 断点 #5 的「清单直接消失，没有任何回执」就是缺这一句。
 */
export function KolReceipt({
  text,
  testid = 'kol-receipt',
}: {
  text: string | undefined
  testid?: string
}): React.ReactNode {
  if (text === undefined || text === '') return null
  return (
    <p
      className="flex items-start gap-1 text-xs text-[var(--ws-good)]"
      data-testid={testid}
      role="status"
    >
      <CheckCircle2 className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span>{text}</span>
    </p>
  )
}
