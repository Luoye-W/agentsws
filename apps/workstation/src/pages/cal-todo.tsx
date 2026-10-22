/**
 * WP469（决策 1521 / 1523 / 1526）：**日历与待办**——待办和日历合成一页，左栏一格。
 *
 * 页头最左一个「清单 / 日历」分段，两面来回切位置不动：
 * - 清单（`pages/todos.tsx`）：今天 / 本周 / 以后 / 做完的，打勾完成；
 * - 日历（`pages/calendar.tsx`）：日 / 周 / 月 / 议程，左边「还没排期的」拖去排期。
 *
 * 打开时是哪一面：地址上写了（`?view=list|calendar`）就听地址，否则记住上次那一面，第一次是清单（1523 丙）。
 * 老地址 `/todos`、`/calendar` 转到这里对应那一面，别的参数原样带上（`?tab=goals`、`?layers=`，1526 甲）。
 */
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { Segmented } from '@/components/design'
import { useApp } from '@/lib/app-context'
import { type CalTodoFace, loadFace, parseFace, saveFace } from '@/lib/cal-todo'
import { CalendarPage } from '@/pages/calendar'
import { TodosPage } from '@/pages/todos'

export const CAL_TODO_PATH = '/planner'

/** 只属于清单那一面的参数（切到日历时去掉）。 */
const LIST_ONLY = ['tab', 'fresh']
/** 只属于日历那一面的参数（切到清单时去掉）。 */
const CALENDAR_ONLY = ['focus']

export function CalTodoPage(): ReactNode {
  const { t } = useApp()
  const [params, setParams] = useSearchParams()
  const urlFace = parseFace(params.get('view'))
  const [face, setFace] = useState<CalTodoFace>(() => urlFace ?? loadFace())
  // 地址换了（清单里点了「排进日历」、首页点进来……）就跟着换
  useEffect(() => {
    if (urlFace !== undefined) setFace(urlFace)
  }, [urlFace])
  useEffect(() => {
    saveFace(face)
  }, [face])

  const switcher = (
    <Segmented
      kind="tabs"
      label={t('nav.cal_todo')}
      testId="caltodo-face"
      value={face}
      options={[
        { value: 'list', label: t('caltodo.face.list'), testId: 'caltodo-face-list' },
        { value: 'calendar', label: t('caltodo.face.calendar'), testId: 'caltodo-face-calendar' },
      ]}
      onChange={(next) => {
        setFace(next)
        setParams(
          (prev) => {
            const p = new URLSearchParams(prev)
            p.set('view', next)
            for (const k of next === 'calendar' ? LIST_ONLY : CALENDAR_ONLY) p.delete(k)
            return p
          },
          { replace: true },
        )
      }}
    />
  )

  return (
    <div data-testid="cal-todo" data-face={face}>
      {face === 'list' ? <TodosPage switcher={switcher} /> : <CalendarPage switcher={switcher} />}
    </div>
  )
}

/** 老地址 `/todos` → 清单、`/calendar` → 日历；别的参数原样带上（1526 甲）。 */
export function CalTodoRedirect({ face }: { face: CalTodoFace }): ReactNode {
  const { search } = useLocation()
  const p = new URLSearchParams(search)
  p.set('view', face)
  return <Navigate to={`${CAL_TODO_PATH}?${p.toString()}`} replace />
}
