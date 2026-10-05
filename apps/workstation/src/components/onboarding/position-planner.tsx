/**
 * 向导第 ③ 步（WP234，docs/70 §5 / docs/54 §6.2）：**说说你要做什么 → 推荐 → 你的岗位**。
 *
 * 三块，从上往下：
 *
 * 1. 一个输入框「说说你要做什么工作」+「帮我推荐」：AI 推荐职责（每条一句理由，引用原话），
 *    同时给岗位划分建议。没接上能用的模型就照实说，下面照样能手选。
 * 2. 推荐与「按类别浏览全部职责」：**推荐只是一个小标签，点了才算选上**——一条都不预勾。
 *    类别 = 随软件带的岗位模板，只当目录用。
 * 3. 「你的岗位」：选上的职责按建议分成几个岗位；拖动 / 「移到…」换岗位、改名、新建、删空。
 *    改完以用户为准（规则在 `lib/position-board.ts`）。
 */
import { GripVertical, Plus, Sparkles, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { DutyRecommendation } from '@/components/onboarding/preset-roles'
import { DutyIcon, PositionIcon } from '@/components/role-icons/role-icon'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { PlannedTag } from '@/components/ui/planned-tag'
import { Textarea } from '@/components/ui/textarea'
import type { OnboardingPositionView, OnboardingSuggestView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { addRow, type Board, moveDuty, removeRow, renameRow, tooMany } from '@/lib/position-board'
import { cn } from '@/lib/utils'

const DRAG_TYPE = 'application/x-agentsws-duty'

/** 一条职责的小块：点它 = 选上 / 去掉；推荐的带一个「推荐」标签。 */
function DutyChip({
  id,
  name,
  picked,
  recommended,
  onToggle,
  testId,
}: {
  id: string
  name: string
  picked: boolean
  recommended: boolean
  onToggle(): void
  testId: string
}): React.ReactNode {
  const { t } = useApp()
  return (
    <button
      type="button"
      aria-pressed={picked}
      data-testid={testId}
      data-role={id}
      data-recommended={recommended ? 'true' : undefined}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-left text-[13px] transition-colors hover:bg-muted',
        picked && 'border-primary bg-primary/10',
      )}
      onClick={onToggle}
    >
      <DutyIcon role_id={id} size={14} className="text-ws-muted-fg" />
      {name}
      {recommended ? (
        <Badge
          variant="secondary"
          className="ml-0.5 px-1 py-0 text-[10.5px]"
          data-testid="duty-rec-tag"
        >
          {t('onboarding.plan3.recs.tag')}
        </Badge>
      ) : null}
    </button>
  )
}

export function PositionPlanner({
  catalog,
  text,
  onText,
  onSuggest,
  suggesting,
  suggestion,
  recommendations,
  board,
  onToggleDuty,
  onAdopt,
  onRegroup,
  onBoard,
}: {
  catalog: OnboardingPositionView[]
  text: string
  onText(next: string): void
  onSuggest(): void
  suggesting: boolean
  suggestion?: OnboardingSuggestView
  /** AI 的 + 第 ② 步分析出来的（AI 在前）。 */
  recommendations: DutyRecommendation[]
  board: Board
  onToggleDuty(role_id: string): void
  /** 「按推荐来」：把推荐的都选上，并按建议分好。 */
  onAdopt(): void
  /** 「按建议重新分」。 */
  onRegroup(): void
  onBoard(next: Board): void
}): React.ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState<string[]>([])
  const [dropTarget, setDropTarget] = useState<string | undefined>(undefined)
  const roleName = new Map(catalog.flatMap((c) => c.roles.map((r) => [r.id, r.name])))
  const recommended = new Set(recommendations.map((r) => r.role_id))
  const picked = new Set(board.selected)
  const filled = board.rows.filter((r) => r.role_ids.length > 0)

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="onboarding-roles">
      {/* 1. 说说你要做什么 */}
      <section className="flex flex-col gap-2" data-testid="onboarding-intent">
        <label htmlFor="onboarding-intent-text" className="font-medium">
          {t('onboarding.plan3.intent.label')}
        </label>
        <Textarea
          id="onboarding-intent-text"
          data-testid="onboarding-intent-text"
          rows={3}
          maxLength={2000}
          value={text}
          placeholder={t('onboarding.plan3.intent.placeholder')}
          onChange={(e) => {
            onText(e.target.value)
          }}
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="onboarding-intent-go"
            disabled={suggesting || text.trim() === ''}
            onClick={onSuggest}
          >
            <Sparkles aria-hidden className="size-3.5" />
            {suggesting ? t('onboarding.plan3.intent.busy') : t('onboarding.plan3.intent.go')}
          </Button>
          {suggestion?.note === undefined ? null : (
            <p className="text-xs text-muted-foreground" data-testid="onboarding-intent-note">
              {suggestion.note}
            </p>
          )}
        </div>
      </section>

      {/* 2a. 推荐给你（只是推荐：点了才选上） */}
      {recommendations.length === 0 ? null : (
        <section className="flex flex-col gap-2" data-testid="onboarding-recs">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium">{t('onboarding.plan3.recs.title')}</p>
            <Button size="sm" variant="ghost" data-testid="onboarding-recs-adopt" onClick={onAdopt}>
              {t('onboarding.plan3.recs.adopt')}
            </Button>
          </div>
          <ul className="flex flex-col gap-1.5">
            {recommendations.map((r) => (
              <li
                key={r.role_id}
                className="flex flex-wrap items-center gap-2"
                data-testid="onboarding-rec"
              >
                <DutyChip
                  id={r.role_id}
                  name={roleName.get(r.role_id) ?? r.role_id}
                  picked={picked.has(r.role_id)}
                  recommended={false}
                  testId="onboarding-rec-duty"
                  onToggle={() => {
                    onToggleDuty(r.role_id)
                  }}
                />
                <span className="text-xs text-muted-foreground" data-testid="onboarding-rec-reason">
                  {r.reason}
                  {r.quote === undefined ? null : (
                    <span className="ml-1 text-foreground">「{r.quote}」</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {suggestion === undefined || suggestion.positions.length === 0 ? null : (
            <p className="text-xs text-muted-foreground" data-testid="onboarding-recs-split">
              {t('onboarding.plan3.recs.split', {
                list: suggestion.positions
                  .map((p) => `「${p.name}」${String(p.role_ids.length)}`)
                  .join(' · '),
              })}
            </p>
          )}
        </section>
      )}

      {/* 2b. 按类别浏览全部职责（类别 = 岗位模板，只当目录） */}
      <section className="flex flex-col gap-2" data-testid="onboarding-catalog">
        <p className="font-medium">{t('onboarding.plan3.catalog.title')}</p>
        <div className="flex flex-col gap-1.5">
          {catalog.map((c) => {
            const isOpen = open.includes(c.id)
            const count = c.roles.filter((r) => picked.has(r.id)).length
            const recs = c.roles.filter((r) => recommended.has(r.id)).length
            return (
              <div key={c.id} className="rounded-md border" data-testid="onboarding-category">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  data-testid="onboarding-category-toggle"
                  data-category={c.id}
                  className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-muted"
                  onClick={() => {
                    setOpen((cur) => (isOpen ? cur.filter((x) => x !== c.id) : [...cur, c.id]))
                  }}
                >
                  <PositionIcon
                    position_id={c.id}
                    {...(c.icon === undefined ? {} : { icon: c.icon })}
                    role_ids={c.roles.map((r) => r.id)}
                    className="text-ws-muted-fg"
                  />
                  {c.name}
                  {c.factory_name === undefined ? null : (
                    <span
                      className="text-[11px] text-muted-foreground"
                      data-testid="onboarding-category-factory"
                    >
                      （{c.factory_name}）
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {count > 0 ? `${String(count)}/${String(c.roles.length)}` : c.roles.length}
                  </span>
                  {recs > 0 ? (
                    <Badge variant="secondary" className="px-1 py-0 text-[10.5px]">
                      {t('onboarding.plan3.recs.tag')} {recs}
                    </Badge>
                  ) : null}
                </button>
                {isOpen ? (
                  <div className="flex flex-wrap gap-2 border-t p-2">
                    {c.roles.map((r) => (
                      <span key={r.id} className="inline-flex items-center gap-1">
                        <DutyChip
                          id={r.id}
                          name={r.name}
                          picked={picked.has(r.id)}
                          recommended={recommended.has(r.id)}
                          testId="onboarding-role"
                          onToggle={() => {
                            onToggleDuty(r.id)
                          }}
                        />
                        <Hint text={r.what_it_does} testId="onboarding-role-hint" />
                        {r.planned === true ? (
                          <PlannedTag testId="onboarding-role-planned" />
                        ) : null}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </section>

      {/* 3. 你的岗位 */}
      <section className="flex flex-col gap-2" data-testid="onboarding-board">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1 font-medium">
            {t('onboarding.plan3.board.title')}
            <Hint text={t('onboarding.plan3.board.hint')} />
          </p>
          {board.customized && board.selected.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="onboarding-board-regroup"
              onClick={onRegroup}
            >
              {t('onboarding.plan3.board.regroup')}
            </Button>
          ) : null}
        </div>
        {board.rows.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="onboarding-board-empty">
            {t('onboarding.plan3.board.empty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {board.rows.map((row) => (
              <li
                key={row.key}
                data-testid="onboarding-board-row"
                data-row={row.key}
                className={cn(
                  'flex flex-col gap-2 rounded-md border p-2 transition-colors',
                  dropTarget === row.key && 'border-primary bg-primary/5',
                )}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
                  e.preventDefault()
                  setDropTarget(row.key)
                }}
                onDragLeave={() => {
                  setDropTarget((cur) => (cur === row.key ? undefined : cur))
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  setDropTarget(undefined)
                  const role = e.dataTransfer.getData(DRAG_TYPE)
                  if (role !== '') onBoard(moveDuty(board, role, row.key))
                }}
              >
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={t('onboarding.plan3.board.name')}
                    data-testid="onboarding-board-name"
                    className="h-7 max-w-56 text-[13px] font-medium"
                    maxLength={64}
                    value={row.name}
                    onChange={(e) => {
                      onBoard(renameRow(board, row.key, e.target.value))
                    }}
                  />
                  <span className="text-xs text-muted-foreground">{row.role_ids.length}</span>
                  {tooMany(row) ? (
                    <Badge
                      variant="outline"
                      className="text-[11px]"
                      data-testid="onboarding-board-too-many"
                    >
                      {t('onboarding.plan3.board.too_many', { n: '6' })}
                    </Badge>
                  ) : null}
                  {row.role_ids.length === 0 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-7"
                      data-testid="onboarding-board-remove"
                      aria-label={t('onboarding.plan3.board.remove')}
                      onClick={() => {
                        onBoard(removeRow(board, row.key))
                      }}
                    >
                      <Trash2 aria-hidden className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
                <ul className="flex flex-wrap gap-1.5">
                  {row.role_ids.map((id) => (
                    <li
                      key={id}
                      draggable
                      data-testid="onboarding-board-duty"
                      data-role={id}
                      className="inline-flex cursor-grab items-center gap-1 rounded-md border bg-ws-card py-0.5 pr-1 pl-0.5 text-[12.5px] active:cursor-grabbing"
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DRAG_TYPE, id)
                        e.dataTransfer.effectAllowed = 'move'
                      }}
                    >
                      <GripVertical aria-hidden className="size-3 text-ws-muted-fg" />
                      <DutyIcon role_id={id} size={13} className="text-ws-muted-fg" />
                      {roleName.get(id) ?? id}
                      {board.rows.length > 1 ? (
                        <select
                          aria-label={t('onboarding.plan3.board.move')}
                          data-testid="onboarding-board-move"
                          className="ml-0.5 max-w-5 cursor-pointer appearance-none bg-transparent text-[11px] text-ws-muted-fg"
                          value=""
                          onChange={(e) => {
                            if (e.target.value !== '') onBoard(moveDuty(board, id, e.target.value))
                          }}
                        >
                          <option value="">⇄</option>
                          {board.rows
                            .filter((r) => r.key !== row.key)
                            .map((r) => (
                              <option key={r.key} value={r.key}>
                                {t('onboarding.plan3.board.move_to', {
                                  name: r.name.trim() === '' ? '…' : r.name,
                                })}
                              </option>
                            ))}
                        </select>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between gap-2">
          <Button
            size="sm"
            variant="ghost"
            data-testid="onboarding-board-add"
            onClick={() => {
              onBoard(addRow(board, t('onboarding.plan3.board.new_name')))
            }}
          >
            <Plus aria-hidden className="size-3.5" />
            {t('onboarding.plan3.board.add')}
          </Button>
          <p className="text-xs text-muted-foreground" data-testid="onboarding-role-count">
            {board.selected.length === 0
              ? t('onboarding.roles.none')
              : t('onboarding.plan3.board.count', {
                  p: String(filled.length),
                  n: String(board.selected.length),
                })}
          </p>
        </div>
      </section>
    </div>
  )
}
