/**
 * WP284（决策 275）：**职责规矩里那几句「以后都这样」**。
 *
 * 卡上指导选「以后都这样」→ 策略卡点了通过 → 这条职责多一句规矩，AI 之后每次干这条活都照做。
 * 这里列出来：一句一行，下面一行小字「谁定的 · 来自哪张卡」；能改的人每行一个「改」一个「删」。
 *
 * 两处用：职责规矩卡（`RoleDetail`，没有时也出标题 + 「还没有」，人才知道规矩在这儿）与右栏角色面板
 * （`hideWhenEmpty`：没有就整块不出）。能不能改由服务端说（`can_edit`）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Textarea } from '@/components/ui/textarea'
import {
  ApiClientError,
  deleteRoleRule,
  listRoleRules,
  type RoleRuleData,
  updateRoleRule,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

function RuleRow({
  rule,
  assignment,
  onChanged,
}: {
  rule: RoleRuleData
  assignment?: string | undefined
  onChanged: () => void
}): React.ReactNode {
  const { t } = useApp()
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fail = (err: unknown): void => {
    setError(err instanceof ApiClientError ? err.message : t('error.generic'))
  }
  const save = useMutation({
    mutationFn: (text: string) => updateRoleRule(rule.role_id, rule.id, text, assignment),
    onSuccess: () => {
      setDraft(null)
      setError(null)
      onChanged()
    },
    onError: fail,
  })
  const remove = useMutation({
    mutationFn: () => deleteRoleRule(rule.role_id, rule.id, assignment),
    onSuccess: onChanged,
    onError: fail,
  })
  // 改过就写改的人（「何佳 改的」），没改过写定的人（「王岚 定的」）
  const edited = rule.updated_by_name !== undefined
  const who = rule.updated_by_name ?? rule.by_name ?? ''

  return (
    <li className="flex flex-col gap-1 rounded-md border px-2 py-1.5" data-testid="role-rule">
      {draft === null ? (
        <div className="flex items-start justify-between gap-2">
          <span className="whitespace-pre-wrap text-sm" data-testid="role-rule-text">
            {rule.text}
          </span>
          {rule.can_edit ? (
            <div className="flex flex-none gap-0.5">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t('role_rules.edit')}
                title={t('role_rules.edit')}
                data-testid="role-rule-edit"
                onClick={() => {
                  setDraft(rule.text)
                }}
              >
                <Pencil aria-hidden />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t('role_rules.delete')}
                title={t('role_rules.delete')}
                data-testid="role-rule-delete"
                disabled={remove.isPending}
                onClick={() => {
                  if (globalThis.confirm(t('role_rules.delete_confirm'))) remove.mutate()
                }}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <Textarea
            rows={2}
            className="text-sm"
            maxLength={300}
            aria-label={t('role_rules.edit')}
            data-testid="role-rule-editor"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
            }}
          />
          <div className="flex gap-1">
            <Button
              size="xs"
              data-testid="role-rule-save"
              disabled={save.isPending || draft.trim() === ''}
              onClick={() => {
                save.mutate(draft.trim())
              }}
            >
              {t('action.save')}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setDraft(null)
                setError(null)
              }}
            >
              {t('action.cancel')}
            </Button>
          </div>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground" data-testid="role-rule-meta">
        {who === '' ? null : t(edited ? 'role_rules.edited_by' : 'role_rules.by', { who })}
        {rule.source_title === undefined ? null : (
          <>
            {who === '' ? null : ' · '}
            {rule.matter_id === undefined ? (
              t('role_rules.from', { title: rule.source_title })
            ) : (
              <Link
                to={`/matters/${encodeURIComponent(rule.matter_id)}`}
                className="underline-offset-2 hover:underline"
                data-testid="role-rule-source"
              >
                {t('role_rules.from', { title: rule.source_title })}
              </Link>
            )}
          </>
        )}
      </p>
      {error === null ? null : (
        <p role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      )}
    </li>
  )
}

export function RoleRules({
  roleId,
  assignment,
  hideWhenEmpty = false,
}: {
  roleId: string
  /** 带哪条分配去问（右栏用当前职责那条；不给 = 工作台默认那条）。 */
  assignment?: string | undefined
  hideWhenEmpty?: boolean
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const rules = useQuery({
    queryKey: ['role-rules', roleId],
    queryFn: () => listRoleRules(roleId, assignment),
  })
  const list = rules.data ?? []
  if (hideWhenEmpty && list.length === 0) return null
  // 读不到（没装配 / 没权限）就不出这一块：它是补充，不该把整张职责卡弄成报错
  if (rules.error !== null) return null

  return (
    <section className="flex flex-col gap-1" data-testid="role-rules" data-role={roleId}>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        {t('role_rules.title')}
        <Hint text={t('role_rules.hint')} />
      </span>
      {list.length === 0 ? (
        rules.isPending ? null : (
          <span className="text-sm text-muted-foreground" data-testid="role-rules-empty">
            {t('role_rules.empty')}
          </span>
        )
      ) : (
        <ul className="flex flex-col gap-1">
          {list.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              assignment={assignment}
              onChanged={() => {
                void client.invalidateQueries({ queryKey: ['role-rules', roleId] })
              }}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
