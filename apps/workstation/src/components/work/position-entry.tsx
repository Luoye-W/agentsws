/**
 * WP69（54）：**交给这个岗位一件事**——岗位页顶部那个按钮，与它下面折叠着的职责层。
 *
 * 54 §4 的认知成本硬规矩落在这个文件里：
 * - 用户看到的是**岗位**（网站运营 / 客服），职责是第二层，默认折叠；
 * - 主入口只要**一句话**：输进去 → 开事项 → 岗位自己判断走哪条职责 → 起 Run；
 * - 拿不准的时候界面不替人选：把候选摆出来，让人点一下。
 */
import { useQuery } from '@tanstack/react-query'
import { Send, Split } from 'lucide-react'
import { useState } from 'react'
import { DutyIcon, PositionIcon } from '@/components/role-icons/role-icon'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DutyFold } from '@/components/ui/duty-fold'
import { Hint } from '@/components/ui/hint'
import { PlannedTag } from '@/components/ui/planned-tag'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { getPosition } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { usePositionOpen } from './use-position-open'

/**
 * 岗位页顶部：岗位名 + 一句话入口 + 折叠着的职责层。
 *
 * `id` 就是地址栏里那个（工作台的"岗位"= 本人持有的一条分配）；服务端会把它换算成
 * 它所属的岗位，所以这里不用先查一次模板 id。
 */
/** 输入框下面最多摆几条：一行摆得下，读不完就等于没有（54 §4 认知成本）。 */
const MAX_ENTRY_SUGGESTIONS = 4

export function PositionEntry({ id }: { id: string }): React.ReactNode {
  const { t, lang } = useApp()
  const [text, setText] = useState('')
  // WP241：三条提交路抽成 `usePositionOpen`（岗位页 v2 的一行入口也用它），行为不变
  const { open, withRole, pick, choice } = usePositionOpen(id, () => {
    setText('')
  })

  const position = useQuery({
    queryKey: ['position-instance', id],
    queryFn: () => getPosition(id),
    enabled: id !== '',
  })

  if (position.isPending) return <Skeleton className="h-28 w-full" />
  // 没装岗位面的服务进程（或这条 id 不属于任何岗位）：整块不出，岗位页照旧能用
  if (position.error !== null || position.data === undefined) return null
  const view = position.data
  /*
   * 建议只从**本人**那几条职责来（54 §1 第三条纪律：拿别人那条去开就是借岗位扩权）。
   * 一个岗位下几条职责各写各的，这里按职责顺序取前几条——一屏读不完就等于没有。
   */
  const suggestions = view.roles
    .filter((r) => r.my_assignment_id !== undefined)
    .flatMap((r) => r.quick_prompts ?? [])
    .slice(0, MAX_ENTRY_SUGGESTIONS)

  /*
   * WP141（docs/78 §2 红人）：输入框的示例**按岗位给**。原来每个岗位都写「比如『把 A 商品
   * 降价 10%』」，红人、客服也一样。现在抄这个岗位自己的第一条快捷提示；一条都没有就
   * 只说「一句话说清要办什么」，不拿别的岗位的活儿举例。
   */
  const example = suggestions[0]
  const placeholder =
    example === undefined
      ? t('position.entry.placeholder.plain')
      : t('position.entry.placeholder.example', {
          example: lang === 'en' ? example.label.en : example.label.zh,
        })

  return (
    <Card data-testid="position-entry" data-position={view.position_id}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            {/* WP213：岗位页头的图标 = 「你在这儿」，点睛那一笔是品牌色 */}
            <PositionIcon
              position_id={view.position_id}
              icon={view.icon}
              role_ids={view.roles.map((r) => r.role_id)}
              size={20}
              selected
            />
            {view.name.zh}
          </CardTitle>
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
            placeholder={placeholder}
            data-testid="position-entry-input"
            onChange={(e) => {
              setText(e.target.value)
            }}
          />
          {/*
            WP98（09-18 收口）：**快捷提示落在输入框下面**，当"可以这么说"的建议。
            它原来平铺在首页岗位卡下面（WP84），那儿它答的是"我想自己起一件事"——
            而真正要起事的地方就是上面这个框。点一条不再另走一条路：把那句话**填进框里**，
            人再按一下"交给它"。于是这一层一条纪律都没多：提交仍旧只有一个出口
            （54 §2 的岗位入口），职责由岗位自己判，与人手打一句话一模一样。
          */}
          {suggestions.length === 0 ? null : (
            <div className="flex flex-wrap gap-1.5" data-testid="entry-suggestions">
              {suggestions.map((q) => (
                <button
                  key={q.id}
                  type="button"
                  className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  data-testid="entry-suggestion"
                  data-prompt={q.id}
                  title={q.prompt}
                  onClick={() => {
                    setText(q.prompt)
                  }}
                >
                  {lang === 'en' ? q.label.en : q.label.zh}
                </button>
              ))}
            </div>
          )}
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
            {/* WP157：「岗位自己判断走哪条职责」是解释，进问号 */}
            <Hint text={t('position.entry.hint')} testId="position-entry-hint" />
          </div>
        </div>

        {/* 拿不准：这件事像 A 也像 B，你定（54 §2） */}
        {choice === undefined ? null : (
          <fieldset className="rounded-md border p-3" data-testid="route-choice">
            <p className="flex items-center gap-1 text-sm" data-slot="status">
              {choice.reason}
              <Hint text={t('position.choice.hint')} />
            </p>
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
                  <DutyIcon role_id={c.role_id} size={14} />
                  {c.role_name}
                </Button>
              ))}
            </div>
          </fieldset>
        )}

        {/* 职责是第二层：默认折叠（54 §4 / WP70 的共用折叠件） */}
        <DutyFold
          testId="position-roles"
          label={t('position.roles.toggle', { count: view.roles.length })}
          duties={view.roles.map((r) => ({ id: r.role_id, name: r.role_name }))}
          renderDuty={(duty) => {
            const role = view.roles.find((r) => r.role_id === duty.id)
            return (
              <div
                className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-sm"
                data-role={duty.id}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <DutyIcon role_id={duty.id} className="text-ws-muted-fg" />
                  <span className="truncate">{duty.name}</span>
                  {role?.planned === true ? <PlannedTag testId="position-role-planned" /> : null}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={
                    role?.my_assignment_id === undefined || text.trim() === '' || withRole.isPending
                  }
                  title={text.trim() === '' ? t('position.roles.open_with.need_text') : undefined}
                  data-testid="open-with-role"
                  onClick={() => {
                    // 只能用**本人**那一条：拿别人那条去开，就是借岗位扩权
                    const assignment = role?.my_assignment_id
                    if (assignment === undefined) return
                    withRole.mutate({ assignment, title: text.trim() })
                  }}
                >
                  <Split className="size-3.5" aria-hidden />
                  {t('position.roles.open_with')}
                </Button>
              </div>
            )
          }}
        />
      </CardContent>
    </Card>
  )
}
