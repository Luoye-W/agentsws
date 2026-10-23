/**
 * 47 J1 的"给人看的那一份"：设置页的**数据地图**（只读）。
 *
 * 它回答的是一个每个新同事都会问、而现在没人答得上来的问题：
 * **"我在这个系统里到底看得到什么？那些数字是从哪来的？多新？我能动它吗？"**
 *
 * 一行一类对象，四列：真源在哪、多新、我能看多大范围、能对它做什么。
 * 数据本身不在这一页——这里只是一张目录（47 J4：登记表不是新的存储）。
 *
 * 36 §7 三层信息：页面上只留一句副标题，"为什么" / "这一列什么意思"全进 tooltip。
 */

import type { TailoredAction, TailoredObject } from '@agentsws/ontology/view'
import { ORDER_RULE } from '@agentsws/ontology/view'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { getPositionOntology } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { tOr } from '@/lib/humanize'
import type { Lang } from '@/lib/i18n'
import { useMode } from '@/lib/mode'

/** `cached:300` → "缓存 5 分钟"；其余两档直接查表。 */
function freshnessText(
  freshness: TailoredObject['freshness'],
  t: (k: string, v?: Record<string, string | number>) => string,
): string {
  if (freshness === 'realtime' || freshness === 'authored')
    return t(`datamap.freshness.${freshness}`)
  const seconds = Number.parseInt(freshness.slice('cached:'.length), 10)
  return t('datamap.freshness.cached', { n: Math.max(1, Math.round(seconds / 60)) })
}

function actionsOf(object: TailoredObject, actions: readonly TailoredAction[]): TailoredAction[] {
  return actions.filter((a) => a.object === object.id)
}

type T = (k: string, v?: Record<string, string | number>) => string

const CJK = /[\u4e00-\u9fff]/u
/** 像内部名：`community_member`、`approve member`、`shopify_admin.get_order` 这类（没有中文、全是小写词）。 */
const INTERNAL = /^[a-z0-9_.\- ]+$/u

/** 这一个名字能不能直接上屏：中文界面要有中文；英文界面不能长得像内部名。 */
function readable(text: string, lang: Lang): boolean {
  const s = text.trim()
  if (s === '') return false
  return lang === 'zh' ? CJK.test(s) : !INTERNAL.test(s)
}

/**
 * WP480：对象的人话名。中文界面：登记表里的名字有中文就用它，没有再查词表（与职责页同一份
 * `duty.domain.*`）；英文界面先查词表。都不行回 `undefined`——整行收进「其他」，
 * 不把 `community_member` 印上屏。
 */
export function objectName(o: TailoredObject, t: T, lang: Lang): string | undefined {
  const named = tOr(t, `duty.domain.${o.id}`, '')
  if (lang === 'zh' && readable(o.label, lang)) return o.label
  if (named !== '') return named
  return readable(o.label, lang) ? o.label : undefined
}

/**
 * WP480：动作的人话名。登记表里是「做什么（对象）」，取前半截；前半截是英文内部名
 * （`approve member`）就查词表（`duty.action.*` / `org.action.*`，「批入群申请」）；
 * 都没有回 `undefined`，算进「另 N 项」。英文界面先查词表。
 */
export function actionName(a: TailoredAction, t: T, lang: Lang): string | undefined {
  const named = tOr(t, `duty.action.${a.id}`, tOr(t, `org.action.${a.id}`, ''))
  const what = a.label.replace(/（[^（）]*）$/u, '').trim()
  if (lang === 'zh' && readable(what, lang)) return what
  if (named !== '') return named
  return readable(what, lang) ? what : undefined
}

export function DataMapPanel({
  position,
  assignment,
}: {
  position: string
  assignment?: string
}): React.ReactNode {
  // WP271：① 个人里不说「范围」（docs/95 §6.1 那批词）
  const { t } = useMode()
  const { lang } = useApp()
  const map = useQuery({
    queryKey: ['ontology', position],
    queryFn: () => getPositionOntology(position, assignment),
    retry: false,
  })

  return (
    <Card data-testid="data-map">
      <CardHeader>
        <CardTitle className="flex items-center gap-1 text-sm">
          {t('datamap.title')}
          <Hint text={t('datamap.hint')} />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {map.isPending ? <Skeleton className="h-40 w-full" /> : null}
        {map.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {t('error.generic')}：{map.error.message}
          </p>
        ) : null}
        {map.data === undefined ? null : map.data.objects.length === 0 ? (
          <p className="text-muted-foreground">{t('datamap.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="data-map-table">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th scope="col" className="py-1 text-left font-normal">
                    {t('datamap.col.object')}
                  </th>
                  <th scope="col" className="py-1 text-left font-normal">
                    <span className="inline-flex items-center gap-1">
                      {t('datamap.col.source')}
                      <Hint text={t('datamap.col.source.hint')} />
                    </span>
                  </th>
                  <th scope="col" className="py-1 text-left font-normal">
                    <span className="inline-flex items-center gap-1">
                      {t('datamap.col.freshness')}
                      <Hint text={t('datamap.col.freshness.hint')} />
                    </span>
                  </th>
                  <th scope="col" className="py-1 text-left font-normal">
                    <span className="inline-flex items-center gap-1">
                      {t('datamap.col.range')}
                      <Hint text={t('datamap.col.range.hint')} />
                    </span>
                  </th>
                  <th scope="col" className="py-1 text-left font-normal">
                    {t('datamap.col.actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rowsOf(map.data.objects, map.data.actions, t, lang).map((row) => (
                  <tr
                    key={row.key}
                    className="border-b last:border-0"
                    {...(row.other ? { 'data-testid': 'data-map-other' } : {})}
                  >
                    <td className="py-1">{row.name}</td>
                    <td className="py-1">{row.source}</td>
                    <td className="py-1">{row.freshness}</td>
                    <td className="py-1">{row.range}</td>
                    <td className="py-1">
                      {row.actions === '' ? (
                        <span className="text-muted-foreground">{t('datamap.actions.none')}</span>
                      ) : (
                        row.actions
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/*
          47 J3：这段话与 Agent 提示词里那一段是**同一处生成的**（`ORDER_RULE`）。
          摆在这儿是为了让人看见"它是按什么顺序想问题的"——而不是让人去猜。
        */}
        <p className="flex items-start gap-1 text-xs text-muted-foreground">
          <span className="font-medium">{t('datamap.order')}</span>
          <Hint text={t('datamap.order.hint')} />
          <span data-testid="data-map-order">{ORDER_RULE}</span>
        </p>
      </CardContent>
    </Card>
  )
}

interface MapRow {
  key: string
  name: string
  source: string
  freshness: string
  range: string
  /** 「、」连起来的动作名；空串 = 只能看。 */
  actions: string
  other?: true
}

/**
 * WP480：一行一类对象；没有人话名的对象整行收进最后一行「其他（另外 N 类）」，
 * 动作里没有人话名的记成「另 N 项」——屏幕上不出现内部名（screen-words 守卫）。
 */
export function rowsOf(
  objects: readonly TailoredObject[],
  actions: readonly TailoredAction[],
  t: T,
  lang: Lang,
): MapRow[] {
  const rows: MapRow[] = []
  let otherKinds = 0
  let otherActions = 0
  const actionText = (mine: readonly TailoredAction[]): { text: string; hidden: number } => {
    const names: string[] = []
    let hidden = 0
    for (const a of mine) {
      const n = actionName(a, t, lang)
      if (n === undefined) hidden += 1
      else if (!names.includes(n)) names.push(n)
    }
    return { text: names.join(lang === 'zh' ? '、' : ', '), hidden }
  }
  for (const o of objects) {
    const mine = actionsOf(o, actions)
    const name = objectName(o, t, lang)
    if (name === undefined) {
      otherKinds += 1
      otherActions += mine.length
      continue
    }
    const { text, hidden } = actionText(mine)
    const more = hidden === 0 ? '' : t('datamap.actions.other', { n: hidden })
    rows.push({
      key: o.id,
      name,
      source: t(`datamap.source.${o.source_of_truth}`),
      freshness: freshnessText(o.freshness, t),
      range: o.read_range === undefined ? '—' : t(`datamap.range.${o.read_range}`),
      actions: [text, more].filter((x) => x !== '').join(lang === 'zh' ? '，' : ', '),
    })
  }
  if (otherKinds > 0)
    rows.push({
      key: '__other',
      name: `${t('datamap.other')}（${t('datamap.other.count', { n: otherKinds })}）`,
      source: '—',
      freshness: '—',
      range: '—',
      actions: otherActions === 0 ? '' : t('datamap.actions.other', { n: otherActions }),
      other: true,
    })
  return rows
}
