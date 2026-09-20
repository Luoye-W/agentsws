/**
 * WP120（69 §4）第三栏「角色」面板：**这个岗位 / 这条职责是谁，公司可改写**。
 *
 * 为什么它该在第三栏而不在设置页：persona 是"当前岗位 / 当前职责"的一部分，
 * 与记忆 / 技能 / 知识 / 额度是同一类东西（36 §10 那四个面板）——
 * 人是在干这条活的时候想起"它怎么会这么说话"的，不是在设置页里。
 *
 * 三条硬规矩：
 *
 * 1. **包里的原文永远看得见**。改写是另存的一层，所以面板上同时有"现在生效的"
 *    与"包里的原文"，「还原」按钮拿后者比——与技能的六层覆盖同一条规矩（24 §1）。
 * 2. **能不能改由服务端说**（同 `memory-panel` 的 `can_edit`）。这里没有第二遍判断：
 *    非 owner 点「改写」拿到的是 403 与一句人话，不是一个静默失败的输入框。
 * 3. **改的是一段话，不是一张表**（36 §13.2）。这一栏没有"新增一行 / 删除一行 /
 *    拖动排序"——persona 是内容，内容归数据；这里给的是「预览 + 改一段」。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { dutyHref } from '@/components/app-shell'
import { PanelError } from '@/components/rail/panel-error'
import type { RailScope } from '@/components/rail/rail-scope'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  ApiClientError,
  getPersona,
  getPosition,
  type PersonaTextData,
  type PersonaViewData,
  revertPersona,
  setPersona,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 取界面语言那一份；那一份空了就回落另一份（与服务端 `personaTextIn` 同一条）。 */
function textIn(persona: PersonaTextData | undefined, lang: string): string {
  if (persona === undefined) return ''
  if (typeof persona === 'string') return persona
  const zh = persona.zh ?? ''
  const en = persona.en ?? ''
  const want = lang === 'zh' ? zh : en
  return want.trim() === '' ? (lang === 'zh' ? en : zh) : want
}

/** 一段 persona：读的时候是正文，改的时候是一个文本框。 */
function PersonaBody({
  view,
  lang,
  canEdit,
  onSaved,
}: {
  view: PersonaViewData
  lang: string
  canEdit: boolean
  onSaved: () => void
}): React.ReactNode {
  const { t } = useApp()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const fail = (err: unknown): void => {
    setError(err instanceof ApiClientError ? err.message : t('error.generic'))
  }

  const save = useMutation({
    mutationFn: (text: string) =>
      setPersona({
        kind: view.subject.kind,
        id: view.subject.id,
        ...(lang === 'zh' ? { zh: text } : { en: text }),
      }),
    onSuccess: () => {
      setEditing(false)
      setError(null)
      onSaved()
    },
    onError: fail,
  })

  const revert = useMutation({
    mutationFn: () => revertPersona({ kind: view.subject.kind, id: view.subject.id }),
    onSuccess: () => {
      setEditing(false)
      setError(null)
      onSaved()
    },
    onError: fail,
  })

  const effective = textIn(view.effective, lang)
  const packaged = textIn(view.packaged, lang)

  return (
    <div className="flex flex-col gap-2" data-testid="role-persona" data-subject={view.subject.id}>
      <div className="flex flex-wrap items-baseline gap-1">
        <span className="text-sm font-medium">{lang === 'zh' ? view.name.zh : view.name.en}</span>
        <span
          className="rounded border px-1 py-0.5 text-[11px] text-muted-foreground"
          data-testid="role-source"
        >
          {view.overridden ? t('rail.role.overridden') : t('rail.role.bundled')}
        </span>
      </div>

      {editing ? (
        <div className="flex flex-col gap-1">
          <Textarea
            rows={12}
            className="text-xs"
            aria-label={t('rail.role.edit')}
            data-testid="role-editor"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
            }}
          />
          <div className="flex gap-1">
            <Button
              size="xs"
              data-testid="role-save"
              disabled={save.isPending || draft.trim() === ''}
              onClick={() => {
                save.mutate(draft)
              }}
            >
              {t('action.save')}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              data-testid="role-cancel"
              onClick={() => {
                setEditing(false)
                setError(null)
              }}
            >
              {t('action.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <p
          className="whitespace-pre-wrap rounded-md border p-2 text-xs leading-relaxed"
          data-testid="role-effective"
        >
          {effective}
        </p>
      )}

      {/* 69 §4：包里的原文永远留着——不显示出来，「还原」就是一个看不见结果的按钮 */}
      {view.overridden ? (
        <details data-testid="role-packaged">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            {t('rail.role.packaged')}
          </summary>
          <p className="mt-1 whitespace-pre-wrap rounded-md border border-dashed p-2 text-[11px] leading-relaxed text-muted-foreground">
            {packaged}
          </p>
        </details>
      ) : null}

      {view.overridden && view.updated_at !== undefined ? (
        <p className="text-[11px] text-muted-foreground" data-testid="role-updated">
          {t('rail.role.updated', { who: view.updated_by ?? '', at: view.updated_at.slice(0, 10) })}
        </p>
      ) : null}

      {canEdit ? (
        editing ? null : (
          <div className="flex gap-1">
            <Button
              size="xs"
              variant="outline"
              data-testid="role-edit"
              onClick={() => {
                setDraft(effective)
                setEditing(true)
              }}
            >
              {t('rail.role.edit')}
            </Button>
            {view.overridden ? (
              <Button
                size="xs"
                variant="ghost"
                data-testid="role-revert"
                disabled={revert.isPending}
                onClick={() => {
                  revert.mutate()
                }}
              >
                <RotateCcw aria-hidden className="size-3.5" />
                {t('rail.role.revert')}
              </Button>
            ) : null}
          </div>
        )
      ) : (
        <p className="text-[11px] text-muted-foreground" data-testid="role-readonly">
          {t('rail.role.readonly')}
        </p>
      )}

      <p className="text-[11px] text-muted-foreground">{t('rail.role.hint')}</p>

      {error === null ? null : (
        <p role="alert" className="text-[11px] text-destructive" data-testid="role-error">
          {error}
        </p>
      )}
    </div>
  )
}

/** 一段 persona 的读取 + 渲染（拿不到就说拿不到，不画一个空框）。 */
function PersonaSection({
  kind,
  id,
  canEdit,
}: {
  kind: 'position' | 'role'
  id: string
  canEdit: boolean
}): React.ReactNode {
  const { lang } = useApp()
  const client = useQueryClient()
  const persona = useQuery({
    queryKey: ['persona', kind, id],
    queryFn: () => getPersona(kind, id),
  })
  if (persona.isPending) return <Skeleton className="h-40 w-full" />
  if (persona.error !== null || persona.data === undefined)
    return <PanelError error={persona.error} />
  return (
    <PersonaBody
      view={persona.data}
      lang={lang}
      canEdit={canEdit}
      onSaved={() => {
        void client.invalidateQueries({ queryKey: ['persona'] })
      }}
    />
  )
}

export function RolePanel({ scope }: { scope: RailScope }): React.ReactNode {
  const { t } = useApp()
  const position = useQuery({
    queryKey: ['position-instance', scope.assignment ?? ''],
    enabled: scope.tier === 'position' && scope.assignment !== undefined,
    queryFn: () => getPosition(scope.assignment ?? ''),
  })

  /*
   * 能不能改由服务端说（36 §10.1 / 同 `memory-panel` 的 `can_edit`）：
   * 界面一律先把「改写」画出来，点下去非 owner 拿到的是 403 与一句人话。
   * 在这里预判一遍"我是不是 owner"只会多出一份会与服务端漂移的判断。
   */
  const canEdit = true

  if (scope.tier === 'role')
    return (
      <div className="flex flex-col gap-3" data-testid="role-panel" data-scope={scope.scope_id}>
        <PersonaSection kind="role" id={scope.scope_id} canEdit={canEdit} />
        {/* 69 §3：运行时先装岗位那一段、再装职责那一段，所以这里也按这个顺序给人看 */}
        {scope.parent === undefined ? (
          <p className="text-[11px] text-muted-foreground" data-testid="role-no-position">
            {t('rail.role.no_position')}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="text-[11px] text-muted-foreground">{t('rail.role.position_of')}</p>
            <PersonaSection kind="position" id={scope.parent.scope_id} canEdit={canEdit} />
          </div>
        )}
      </div>
    )

  if (position.isPending) return <Skeleton className="h-40 w-full" />
  const duties = (position.data?.roles ?? []).filter((r) => r.my_assignment_id !== undefined)
  return (
    <div className="flex flex-col gap-3" data-testid="role-panel" data-scope={scope.scope_id}>
      <PersonaSection kind="position" id={scope.scope_id} canEdit={canEdit} />
      {duties.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <p className="text-[11px] text-muted-foreground">{t('rail.role.duties')}</p>
          <ul className="flex flex-col gap-1">
            {duties.map((r) => (
              <li key={r.role_id}>
                <Link
                  to={dutyHref(r.my_assignment_id ?? '', r.role_id)}
                  className="flex items-center justify-between rounded-md border px-2 py-1.5 text-sm hover:bg-accent"
                  data-testid="role-duty-link"
                  data-duty={r.role_id}
                >
                  <span className="truncate">{r.role_name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
