/**
 * WP69（54）：**交给这个岗位一件事**——岗位页顶部那个按钮，与它下面折叠着的职责层。
 *
 * 54 §4 的认知成本硬规矩落在这个文件里：
 * - 用户看到的是**岗位**（网站运营 / 客服），职责是第二层，默认折叠；
 * - 主入口只要**一句话**：输进去 → 开事项 → 岗位自己判断走哪条职责 → 起 Run；
 * - 拿不准的时候界面不替人选：把候选摆出来，让人点一下。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Send, Split } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  createMatterWithRole,
  getPosition,
  type OpenAtPositionData,
  openMatterAtPosition,
  rerouteMatter,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/**
 * 岗位页顶部：岗位名 + 一句话入口 + 折叠着的职责层。
 *
 * `id` 就是地址栏里那个（工作台的"岗位"= 本人持有的一条分配）；服务端会把它换算成
 * 它所属的岗位，所以这里不用先查一次模板 id。
 */
export function PositionEntry({ id }: { id: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [openRoles, setOpenRoles] = useState(false)
  const [choice, setChoice] = useState<OpenAtPositionData | undefined>(undefined)

  const position = useQuery({
    queryKey: ['position-instance', id],
    queryFn: () => getPosition(id),
    enabled: id !== '',
  })

  const open = useMutation({
    mutationFn: (input: { title: string }) => openMatterAtPosition(id, input),
    onSuccess: (out) => {
      setText('')
      void client.invalidateQueries({ queryKey: ['position-instance', id] })
      // 判准了就直接进事项页；拿不准就停在这儿，把候选摆出来让人点一下
      if (out.ambiguous) setChoice(out)
      else navigate(`/matters/${out.matter.id}`)
    },
  })

  /**
   * 54 §2 次入口：**用这条职责开**——跳过路由，指定用它的规矩做。
   * 用的就是那条职责的分配，所以权限、额度、动作面一个不多一个不少。
   */
  const withRole = useMutation({
    mutationFn: (input: { assignment: string; title: string }) =>
      createMatterWithRole(input.assignment, { title: input.title }),
    onSuccess: (out) => {
      setText('')
      navigate(`/matters/${out.matter.id}`)
    },
  })

  /** 选择卡上点了一条：把这件事定给那条职责，然后进事项页（新的 Run 走它）。 */
  const pick = useMutation({
    mutationFn: (input: { matter_id: string; role_id: string }) =>
      rerouteMatter(input.matter_id, input.role_id),
    onSuccess: (_out, input) => {
      setChoice(undefined)
      navigate(`/matters/${input.matter_id}`)
    },
  })

  if (position.isPending) return <Skeleton className="h-28 w-full" />
  // 没装岗位面的服务进程（或这条 id 不属于任何岗位）：整块不出，岗位页照旧能用
  if (position.error !== null || position.data === undefined) return null
  const view = position.data

  return (
    <Card data-testid="position-entry" data-position={view.position_id}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle className="text-sm">{view.name.zh}</CardTitle>
          {/* 54 §4：计数按岗位聚合（"网站运营：3 张待审"），点开才看是哪条职责的 */}
          <span className="text-xs text-muted-foreground" data-testid="position-counts">
            {t('position.counts', {
              cards: view.pending_cards,
              matters: view.open_matters,
            })}
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium" htmlFor="position-entry-text">
            {t('position.entry.title')}
          </label>
          <Textarea
            id="position-entry-text"
            rows={2}
            value={text}
            placeholder={t('position.entry.placeholder')}
            data-testid="position-entry-input"
            onChange={(e) => {
              setText(e.target.value)
            }}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={text.trim() === '' || open.isPending}
              data-testid="position-entry-submit"
              onClick={() => {
                open.mutate({ title: text.trim() })
              }}
            >
              <Send className="size-3.5" aria-hidden />
              {t('position.entry.submit')}
            </Button>
            <span className="text-xs text-muted-foreground">{t('position.entry.hint')}</span>
          </div>
        </div>

        {/* 拿不准：这件事像 A 也像 B，你定（54 §2） */}
        {choice === undefined ? null : (
          <fieldset className="rounded-md border p-3" data-testid="route-choice">
            <p className="text-sm">{choice.reason}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {choice.candidates.map((c) => (
                <Button
                  key={c.role_id}
                  size="xs"
                  variant="outline"
                  data-testid="route-choice-option"
                  disabled={pick.isPending}
                  onClick={() => {
                    pick.mutate({ matter_id: choice.matter.id, role_id: c.role_id })
                  }}
                >
                  {c.role_name}
                </Button>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">{t('position.choice.hint')}</p>
          </fieldset>
        )}

        {/* 职责是第二层：默认折叠（54 §4） */}
        <div>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground"
            aria-expanded={openRoles}
            data-testid="position-roles-toggle"
            onClick={() => {
              setOpenRoles((v) => !v)
            }}
          >
            {openRoles ? (
              <ChevronDown className="size-3.5" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden />
            )}
            {t('position.roles.toggle', { count: view.roles.length })}
          </button>
          {openRoles ? (
            <ul className="mt-2 flex flex-col gap-1" data-testid="position-roles">
              {view.roles.map((r) => (
                <li
                  key={r.role_id}
                  className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-sm"
                  data-role={r.role_id}
                >
                  <span className="truncate">{r.role_name}</span>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={
                      r.my_assignment_id === undefined || text.trim() === '' || withRole.isPending
                    }
                    title={text.trim() === '' ? t('position.roles.open_with.need_text') : undefined}
                    data-testid="open-with-role"
                    onClick={() => {
                      // 只能用**本人**那一条：拿别人那条去开，就是借岗位扩权
                      const assignment = r.my_assignment_id
                      if (assignment === undefined) return
                      withRole.mutate({ assignment, title: text.trim() })
                    }}
                  >
                    <Split className="size-3.5" aria-hidden />
                    {t('position.roles.open_with')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
