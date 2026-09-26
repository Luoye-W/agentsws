/**
 * WP71（36 §10 / 05 §1.3 / 14 §1）第三栏「额度」面板：**这条职责能做到哪一步，可改**。
 *
 * 表格来自职责 yml：每个动作的 `mandate.caps`（改价 ≤ 20% 这种）、窗口计数
 * （`window.max_count / per`）与自动化上限（`automation.ceiling`）。
 *
 * 两条硬规矩，这一栏的全部设计都从它们来：
 *
 * 1. **改额度 = 提一张 `policy_change` 审批卡，不是当场生效**（14 §1）。走的是
 *    `PUT /v1/roles/:id`（org 页职责编辑那条路，**不另起一条**），回执里 `status`
 *    永远是 `pending_approval`——界面照它显示"已提交审批"。
 * 2. **内置模板只读，先复制一份才能改**（05 §0）。`RoleSummaryView.editable === false`
 *    时这一栏出的是「复制一份再改」（`POST /v1/roles`），不是一个按下去会 403 的输入框。
 *
 * 岗位层没有自己的额度——**权限与额度永远长在职责上**（54 §2：岗位本身一个 scope
 * 字段都没有）。所以在岗位层这一栏列的是这个岗位下每条职责各自的额度，只读，
 * 点一条切到那条职责去改。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { dutyHref } from '@/components/app-shell'
import { PanelError } from '@/components/rail/panel-error'
import type { RailScope } from '@/components/rail/rail-scope'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ApiClientError,
  copyRoleDefinition,
  getPosition,
  getRoleDefinition,
  proposeRoleChange,
  type RoleDetailView,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 一条动作的额度：键值对现在是字符串（服务端给的人话），改的时候只收数字。 */
function ActionRow({
  action,
  editable,
  draft,
  onDraft,
}: {
  action: RoleDetailView['actions'][number]
  editable: boolean
  draft: Record<string, string>
  onDraft: (key: string, value: string) => void
}): React.ReactNode {
  const { t } = useApp()
  return (
    <div className="rounded-md border p-2" data-testid="caps-action" data-action={action.id}>
      <p className="text-sm font-medium">{action.id}</p>
      <p className="text-[11px] text-muted-foreground">
        {t('rail.caps.kind', { kind: action.kind, target: action.target })}
      </p>
      {action.caps.length === 0 ? (
        <p className="mt-1 text-[11px] text-muted-foreground">{t('rail.caps.none')}</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {action.caps.map((cap) => (
            <li key={cap.key} className="flex items-center gap-1" data-testid="caps-row">
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                {cap.key}
              </span>
              {editable ? (
                <Input
                  className="h-6 w-20 text-xs"
                  inputMode="decimal"
                  aria-label={`${action.id} ${cap.key}`}
                  data-testid="caps-input"
                  value={draft[`${action.id}:${cap.key}`] ?? cap.value}
                  onChange={(e) => {
                    onDraft(`${action.id}:${cap.key}`, e.target.value)
                  }}
                />
              ) : (
                <span className="font-mono text-xs tabular-nums">{cap.value}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {action.window === undefined ? null : (
        <p className="mt-1 text-[11px] text-muted-foreground" data-testid="caps-window">
          {t('rail.caps.window', {
            count: action.window.max_count,
            per: action.window.per,
          })}
        </p>
      )}
    </div>
  )
}

/** 职责层：一张可改的表 + 「提交审批」。 */
function RoleCaps({ role_id }: { role_id: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const role = useQuery({
    queryKey: ['role-definition', role_id],
    queryFn: () => getRoleDefinition(role_id),
  })

  const copy = useMutation({
    mutationFn: () => copyRoleDefinition(role_id, undefined),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['role-definition'] })
    },
  })

  const propose = useMutation({
    mutationFn: (view: RoleDetailView) =>
      proposeRoleChange(role_id, {
        actions: view.actions
          .map((a) => {
            const caps: Record<string, number> = {}
            for (const cap of a.caps) {
              const raw = draft[`${a.id}:${cap.key}`]
              if (raw === undefined) continue
              const n = Number.parseFloat(raw)
              if (Number.isFinite(n)) caps[cap.key] = n
            }
            return Object.keys(caps).length === 0 ? undefined : { id: a.id, caps }
          })
          .filter((x): x is { id: string; caps: Record<string, number> } => x !== undefined),
      }),
    onSuccess: () => {
      setDraft({})
      setError(null)
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiClientError ? err.message : t('error.generic'))
    },
  })

  if (role.isPending) return <Skeleton className="h-40 w-full" />
  if (role.error !== null || role.data === undefined) return <PanelError error={role.error} />
  const view = role.data
  const dirty = Object.keys(draft).length > 0

  return (
    <div className="flex flex-col gap-2" data-testid="caps-role" data-role={view.id}>
      <div className="flex flex-wrap items-baseline gap-1">
        <span className="text-sm font-medium">{view.name}</span>
        <span className="font-mono text-[11px] text-muted-foreground">v{view.version}</span>
        <span
          className="rounded border px-1 py-0.5 text-[11px] text-muted-foreground"
          data-testid="caps-source"
        >
          {view.source === 'bundled' ? t('rail.caps.bundled') : t('rail.caps.custom')}
        </span>
      </div>
      {view.editable ? null : (
        <div className="flex flex-col gap-1">
          {/* 05 §0：内置模板不给改，只能复制一份再改——所以这里给的是复制，不是一个会 403 的输入框 */}
          <p className="text-[11px] text-muted-foreground" data-testid="caps-readonly">
            {t('rail.caps.readonly')}
          </p>
          <div>
            <Button
              size="xs"
              variant="outline"
              data-testid="caps-copy"
              disabled={copy.isPending}
              onClick={() => {
                copy.mutate()
              }}
            >
              <Copy aria-hidden className="size-3.5" />
              {t('rail.caps.copy')}
            </Button>
          </div>
          {copy.data === undefined ? null : (
            <p className="text-[11px] text-muted-foreground" data-testid="caps-copy-result">
              {t('rail.caps.copied', { name: copy.data.name })}
            </p>
          )}
        </div>
      )}
      {view.actions.map((a) => (
        <ActionRow
          key={a.id}
          action={a}
          editable={view.editable}
          draft={draft}
          onDraft={(key, value) => {
            setDraft((prev) => ({ ...prev, [key]: value }))
          }}
        />
      ))}
      {view.automation.length === 0 ? null : (
        <div className="rounded-md border p-2" data-testid="caps-automation">
          <p className="text-xs font-medium">{t('rail.caps.automation')}</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-muted-foreground">
            {view.automation.map((a) => (
              <li key={a.action_id}>
                {t('rail.caps.automation.row', {
                  action: a.action_id,
                  initial: a.initial,
                  ceiling: a.ceiling,
                })}
                {a.hard_ceiling ? ` · ${t('rail.caps.hard')}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {view.editable ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              data-testid="caps-submit"
              disabled={!dirty || propose.isPending}
              onClick={() => {
                propose.mutate(view)
              }}
            >
              {t('rail.caps.submit')}
            </Button>
            {/* 14 §1：改额度永远是"提了一张卡"，不是"已经改好了"——WP157：这句进提交按钮旁的问号 */}
            <Hint text={t('rail.caps.approval_hint')} testId="caps-approval-hint" />
          </div>
          {propose.data === undefined ? null : (
            <p className="text-[11px] text-muted-foreground" data-testid="caps-submitted">
              {propose.data.status === 'pending_approval'
                ? t('rail.caps.submitted')
                : propose.data.summary}
            </p>
          )}
        </div>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-[11px] text-destructive" data-testid="caps-error">
          {error}
        </p>
      )}
    </div>
  )
}

export function CapsPanel({ scope }: { scope: RailScope }): React.ReactNode {
  const { t } = useApp()
  const position = useQuery({
    queryKey: ['position-instance', scope.assignment ?? ''],
    enabled: scope.tier === 'position' && scope.assignment !== undefined,
    queryFn: () => getPosition(scope.assignment ?? ''),
  })

  if (scope.tier === 'role')
    return (
      <div data-testid="caps-panel" data-scope={scope.scope_id}>
        <RoleCaps role_id={scope.scope_id} />
      </div>
    )

  if (position.isPending) return <Skeleton className="h-40 w-full" />
  const duties = (position.data?.roles ?? []).filter((r) => r.my_assignment_id !== undefined)
  return (
    <div className="flex flex-col gap-2" data-testid="caps-panel" data-scope={scope.scope_id}>
      {/* 54 §2：岗位本身没有权限也没有额度，改额度要落到具体那条职责上 */}
      <p className="text-xs text-muted-foreground" data-testid="caps-position-hint">
        {t('rail.caps.position_hint')}
      </p>
      <ul className="flex flex-col gap-1">
        {duties.map((r) => (
          <li key={r.role_id}>
            <Link
              to={dutyHref(r.my_assignment_id ?? '', r.role_id)}
              className="flex items-center justify-between rounded-md border px-2 py-1.5 text-sm hover:bg-accent"
              data-testid="caps-duty-link"
              data-duty={r.role_id}
            >
              <span className="truncate">{r.role_name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
