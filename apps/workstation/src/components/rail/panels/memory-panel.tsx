/**
 * WP71（36 §10 / 54 §3）第三栏「记忆」面板：**这一层攒下的规矩，可手改**。
 *
 * 四块，自上而下：
 *
 * 1. **本层条目**：一条一行，写着正文与来源（从哪个事项提升 · 谁批的 / 手动加 · 谁 · 日期），
 *    每条可**改 / 删 / 提到上一层**；
 * 2. **手动加一条**：当场写进本层（不是提议）——本层就是本人自己干活的那一层，
 *    没有第二个人要为它点头；
 * 3. **上面继承的**：折着的一行，写清上面几层各有多少条（看得见，但在这里改不了）；
 * 4. **六层怎么叠**：`package → company → department → position → role → personal`，
 *    本层高亮。这张小卡是整个记忆模型唯一的解释处（36 §7：解释性文字就放在它说明的东西旁边）。
 *
 * 两条纪律：
 *
 * - **改本层是写，提到上一层是提议**。后者走 `POST /v1/skills/:name/promote` → 一张待审卡
 *   （24 §3 不批不生效）；这里只有前者是直接写。
 * - **能不能改由服务端说**（`can_edit`）。前端不自己判"我是不是这条职责的人"，
 *   否则同一条判据就有了两份。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpFromLine, Check, ChevronDown, ChevronRight, Plus, Sparkles, X } from 'lucide-react'
import { useState } from 'react'
import { PanelError } from '@/components/rail/panel-error'
import type { RailScope } from '@/components/rail/rail-scope'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  ApiClientError,
  addMemoryEntry,
  deleteMemoryEntry,
  getLayerMemory,
  type MemoryEntryData,
  promoteSkillTo,
  updateMemoryEntry,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * 六层的顺序。**真源是 `packages/skills` 的 `TIER_ORDER`**——工作台不依赖那个包
 * （它是服务端的东西），所以这里抄了一份；抄的是顺序，不是判据：这张卡只用来讲解，
 * 真正按层叠加永远发生在服务端。
 */
const TIERS = ['package', 'company', 'department', 'position', 'role', 'personal'] as const

function originLabel(entry: MemoryEntryData, t: (k: string) => string): string {
  if (entry.source === 'manual') return t('memory.source.manual')
  if (entry.origin === 'learned') return t('memory.source.learned')
  return t('memory.source.promoted')
}

/** 一条记忆：看的时候是一段话，改的时候就地变成一个文本框。 */
function Entry({
  entry,
  scope,
  canEdit,
  onChanged,
}: {
  entry: MemoryEntryData
  scope: RailScope
  canEdit: boolean
  onChanged: () => void
}): React.ReactNode {
  const { t, lang } = useApp()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.body)
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (text: string) => updateMemoryEntry(entry.id ?? '', { text }),
    onSuccess: () => {
      setEditing(false)
      setError(null)
      onChanged()
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiClientError ? err.message : t('error.generic'))
    },
  })
  const drop = useMutation({
    mutationFn: () => deleteMemoryEntry(entry.id ?? ''),
    onSuccess: onChanged,
    onError: (err: unknown) => {
      setError(err instanceof ApiClientError ? err.message : t('error.generic'))
    },
  })
  /**
   * 「提到上一层」——**出的是一张卡，不是一次写入**（24 §3）。
   * 职责层提到岗位层；岗位层提到公司层。第三栏只会落在这两层，所以上面永远还有一层。
   */
  const promote = useMutation({
    mutationFn: () =>
      promoteSkillTo({
        skill: entry.skill,
        section_ids: [entry.section_id],
        to_tier: scope.tier === 'role' ? 'position' : 'company',
        ...(scope.tier === 'role' && scope.parent !== undefined
          ? { scope_id: scope.parent.scope_id }
          : {}),
      }),
  })

  const when = entry.added_at ?? entry.learned_from?.at
  return (
    <li className="rounded-md border p-2" data-testid="memory-entry" data-source={entry.source}>
      {editing ? (
        <div className="flex flex-col gap-1">
          <Textarea
            rows={4}
            value={draft}
            aria-label={t('memory.edit')}
            data-testid="memory-edit-text"
            onChange={(e) => {
              setDraft(e.target.value)
            }}
          />
          <div className="flex gap-1">
            <Button
              size="xs"
              disabled={save.isPending || draft.trim() === ''}
              data-testid="memory-edit-save"
              onClick={() => {
                save.mutate(draft.trim())
              }}
            >
              <Check aria-hidden className="size-3.5" />
              {t('action.save')}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setDraft(entry.body)
                setEditing(false)
              }}
            >
              <X aria-hidden className="size-3.5" />
              {t('action.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words text-sm">{entry.body}</p>
          <p className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
            {entry.origin === 'learned' ? <Sparkles aria-hidden className="size-3" /> : null}
            <span data-testid="memory-origin">{originLabel(entry, t)}</span>
            {entry.added_by === undefined ? null : <span>· {entry.added_by}</span>}
            {when === undefined ? null : <span>· {formatDate(when, lang)}</span>}
          </p>
        </>
      )}
      {canEdit && !editing ? (
        <div className="mt-1 flex flex-wrap gap-1">
          <Button
            size="xs"
            variant="ghost"
            data-testid="memory-edit"
            disabled={entry.id === undefined}
            onClick={() => {
              setEditing(true)
            }}
          >
            {t('memory.edit')}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            data-testid="memory-delete"
            disabled={entry.id === undefined || drop.isPending}
            onClick={() => {
              drop.mutate()
            }}
          >
            {t('memory.delete')}
          </Button>
          {/* 职责层往上是岗位层，岗位层往上是公司层——两层之上还有层，所以这个按钮总在 */}
          <Button
            size="xs"
            variant="ghost"
            data-testid="memory-promote"
            disabled={promote.isPending}
            onClick={() => {
              promote.mutate()
            }}
          >
            <ArrowUpFromLine aria-hidden className="size-3.5" />
            {t('memory.promote.up')}
          </Button>
        </div>
      ) : null}
      {promote.data === undefined ? null : (
        <p className="mt-1 text-[11px] text-muted-foreground" data-testid="memory-promote-result">
          {promote.data.accepted ? t('memory.promote.ok') : promote.data.reason}
        </p>
      )}
      {error === null ? null : (
        <p role="alert" className="mt-1 text-[11px] text-destructive" data-testid="memory-error">
          {error}
        </p>
      )}
    </li>
  )
}

/** 折着的"上面继承的"：上面几层各有多少条。只数、不列——那几层在它们自己的面板里改。 */
function Inherited({ scope }: { scope: RailScope }): React.ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const parent = scope.parent
  const above = useQuery({
    queryKey: ['layer-memory', 'above', scope.tier, scope.scope_id],
    queryFn: async () => {
      const rows = await Promise.all([
        parent === undefined
          ? Promise.resolve(null)
          : getLayerMemory(parent.tier, parent.scope_id).then((m) => ({
              name: parent.name,
              count: m.entries.length,
            })),
        getLayerMemory('company').then((m) => ({
          name: t('rail.tier.company'),
          count: m.entries.length,
        })),
      ])
      return rows.filter((r): r is { name: string; count: number } => r !== null)
    },
  })
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        data-testid="memory-inherited-toggle"
        className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => {
          setOpen((v) => !v)
        }}
      >
        {open ? (
          <ChevronDown aria-hidden className="size-3.5" />
        ) : (
          <ChevronRight aria-hidden className="size-3.5" />
        )}
        {t('memory.inherited')}
      </button>
      {open ? (
        <ul
          className="flex flex-col gap-0.5 text-xs text-muted-foreground"
          data-testid="memory-inherited"
        >
          {(above.data ?? []).map((row) => (
            <li key={row.name}>
              {t('memory.inherited.row', { name: row.name, count: row.count })}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** "六层怎么叠"：越靠下越具体、越优先；本层高亮。 */
function TierCard({ tier }: { tier: RailScope['tier'] }): React.ReactNode {
  const { t } = useApp()
  return (
    <div className="rounded-md border p-2" data-testid="memory-tier-card">
      <p className="mb-1 text-xs font-medium">{t('memory.tiers.title')}</p>
      <ol className="flex flex-col gap-0.5 text-xs">
        {TIERS.map((value, i) => (
          <li
            key={value}
            className={cn(
              'flex items-center gap-1 rounded px-1 py-0.5',
              value === tier
                ? 'bg-secondary font-medium text-secondary-foreground'
                : 'text-muted-foreground',
            )}
            data-testid={`memory-tier-${value}`}
            aria-current={value === tier ? 'true' : undefined}
          >
            <span className="tabular-nums">{i + 1}</span>
            <span>{t(`rail.tier.${value}`)}</span>
          </li>
        ))}
      </ol>
      <p className="mt-1 text-[11px] text-muted-foreground">{t('memory.tiers.hint')}</p>
    </div>
  )
}

export function MemoryPanel({ scope }: { scope: RailScope }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const key = ['layer-memory', scope.tier, scope.scope_id]
  const memory = useQuery({
    queryKey: key,
    queryFn: () => getLayerMemory(scope.tier, scope.scope_id),
  })
  const invalidate = (): void => {
    void client.invalidateQueries({ queryKey: ['layer-memory'] })
  }

  const add = useMutation({
    mutationFn: (text: string) =>
      addMemoryEntry({ tier: scope.tier, scope_id: scope.scope_id, text }),
    onSuccess: () => {
      setDraft('')
      setAdding(false)
      setError(null)
      invalidate()
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiClientError ? err.message : t('error.generic'))
    },
  })

  if (memory.isPending) return <Skeleton className="h-40 w-full" />
  if (memory.error !== null || memory.data === undefined) return <PanelError error={memory.error} />
  const view = memory.data
  // 老服务进程不回 `can_edit`，那时整面板只读（少一个按钮，好过一个按下去 404 的按钮）
  const canEdit = view.can_edit === true

  return (
    <div className="flex flex-col gap-3" data-testid="memory-panel" data-scope={scope.scope_id}>
      <p className="text-xs text-muted-foreground" data-testid="memory-summary">
        {view.summary}
      </p>

      {canEdit ? (
        adding ? (
          <div className="flex flex-col gap-1">
            <Textarea
              rows={3}
              value={draft}
              aria-label={t('memory.add')}
              data-testid="memory-add-text"
              placeholder={t('memory.add.placeholder')}
              onChange={(e) => {
                setDraft(e.target.value)
              }}
            />
            <div className="flex gap-1">
              <Button
                size="xs"
                disabled={add.isPending || draft.trim() === ''}
                data-testid="memory-add-save"
                onClick={() => {
                  add.mutate(draft.trim())
                }}
              >
                {t('action.save')}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setAdding(false)
                  setDraft('')
                }}
              >
                {t('action.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button
              size="xs"
              variant="outline"
              data-testid="memory-add"
              onClick={() => {
                setAdding(true)
              }}
            >
              <Plus aria-hidden className="size-3.5" />
              {t('memory.add')}
            </Button>
          </div>
        )
      ) : (
        <p className="text-[11px] text-muted-foreground" data-testid="memory-readonly">
          {t('memory.readonly')}
        </p>
      )}
      {error === null ? null : (
        <p role="alert" className="text-[11px] text-destructive" data-testid="memory-add-error">
          {error}
        </p>
      )}

      {view.entries.length === 0 ? (
        <p className="text-muted-foreground" data-testid="memory-empty">
          {t('memory.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {view.entries.map((e) => (
            <Entry
              key={e.id ?? `${e.skill}:${e.section_id}`}
              entry={e}
              scope={scope}
              canEdit={canEdit}
              onChanged={invalidate}
            />
          ))}
        </ul>
      )}

      <Inherited scope={scope} />
      <TierCard tier={scope.tier} />
    </div>
  )
}
