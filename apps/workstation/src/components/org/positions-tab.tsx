/**
 * 公司页「岗位」tab：一个岗位一行——岗位名、持有人、职责数，三个动作
 * （分给同事 / 加减职责 / 删掉）。
 *
 * WP70（54 §4，Luoye 09-16）：**职责一律归在岗位下面，默认折叠收纳**。
 * 以前这一页顶上还有一个独立的「职责」tab，岗位卡上的职责也是摊开的一排徽章——
 * 于是"这家公司有什么"被同一批东西讲了两遍，一遍按岗位、一遍按职责。现在只剩
 * 一遍：职责在岗位行下面那个折叠层里，点开才看得见，每条旁边的动作（复制一份 /
 * 改名与额度 / 已提交审批）就是原「职责」tab 那一套（`RoleDetail`）。
 *
 * "岗位"在这里是 05 §2 的模板：它只在分配那一刻展开成一组职责，
 * 所以"分给了谁"是算出来的（安放在这里的，加上没安放、手上有这个岗位里一条职责的），不是另存一张表。
 *
 * WP235：分两块——上面「你们的岗位」（有人在做的 + 自建的；卡上写谁在做、他手上是哪几条；
 * 合并 / 移动 / 拆出只在这一块），下面折叠的「可以加的岗位（模板）」（没人做的出厂模板）。
 */
import { Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { PositionReshape } from '@/components/org/position-reshape'
import { type RoleChangePatch, RoleDetail } from '@/components/org/roles-tab'
import { DutyIcon, PositionIcon } from '@/components/role-icons/role-icon'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DutyFold } from '@/components/ui/duty-fold'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { OrgPositionView, RoleSummaryView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { inUseCount, splitPositions } from '@/lib/org-positions'
import { rangeText } from '@/lib/ranges'
import { cn } from '@/lib/utils'

/** 持有人一枚：一个首字的圆头像 + 名字（+ 他管的范围）（+ WP235：他在这个岗位里做的那几条）。 */
function Holder({
  name,
  ranges,
  duties = [],
}: {
  name: string
  ranges: { kind: string; id: string }[]
  duties?: string[]
}): React.ReactNode {
  const { t } = useApp()
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2 pl-0.5 text-xs">
      <span
        aria-hidden
        className="flex size-5 items-center justify-center rounded-full bg-muted font-medium text-[11px]"
      >
        {name.slice(0, 1)}
      </span>
      {name}
      {ranges.length === 0 ? null : (
        <span className="text-muted-foreground">
          （{ranges.map((r) => rangeText(r, t)).join('、')}）
        </span>
      )}
      {duties.length === 0 ? null : (
        <span className="text-muted-foreground" data-testid="position-holder-duties">
          · {duties.join('、')}
        </span>
      )}
    </span>
  )
}

/**
 * WP202：勾选职责时能列哪几条。拆过的老职责（`superseded_by`，如「Meta 社媒运营」）
 * 不再给人新勾；只有这个岗位**本来就含着它**时照常列出（老岗位不能看着像少了一条）。
 */
export function pickableRoles(roles: RoleSummaryView[], held: string[] = []): RoleSummaryView[] {
  return roles.filter((r) => r.superseded_by === undefined || held.includes(r.id))
}

/** WP234：「负责人」那个岗位行的 id（身份，不在岗位清单里列）。 */
export { OWNER_POSITION } from '@/lib/org-positions'

/** 新建岗位时的预填（WP202：从「连接 → 浏览器插件」那句提示跳来，预填红人营销）。 */
export interface PositionDraft {
  name: string
  roles: string[]
}

export function PositionsTab({
  positions,
  roles,
  submitted,
  busy,
  error,
  onAssign,
  onCreate,
  onSaveRoles,
  onDelete,
  onCopyRole,
  onProposeRole,
  people = [],
  onSupervisor,
  onRename,
  assigning,
  below,
  draft: preset,
  onMerge,
  onMoveDuty,
  onSplit,
  notice,
}: {
  positions: OrgPositionView[]
  roles: RoleSummaryView[]
  /** 刚提交过审批的职责 id（折叠层里那条显示「已提交审批」）。 */
  submitted?: string
  busy: boolean
  error?: string
  onAssign(position_id: string): void
  onCreate(input: { name: string; roles: { role_id: string; default: boolean }[] }): void
  onSaveRoles(
    id: string,
    input: { name: string; roles: { role_id: string; default: boolean }[] },
  ): void
  onDelete(id: string): void
  /** 原「职责」tab 的两个动作，现在挂在折叠层里每条职责下面。 */
  onCopyRole(id: string): void
  onProposeRole(id: string, patch: RoleChangePatch): void
  /** WP174：上级下拉的候选（工作区里还在的人）。 */
  people?: { person_id: string; name: string }[]
  /** WP174：改上级（`null` = 不设，超授权的审批转老板）。不给就不出这一行。 */
  onSupervisor?(position_id: string, person_id: string | null): void
  /**
   * WP196：岗位改名（只改显示名，中英各一；id、职责、路由都不动）。不给就不出「改名」。
   * `name_en` 空着 = 英文名不变。
   */
  onRename?(position_id: string, input: { name: string; name_en?: string }): void
  /**
   * WP202：正在「分给同事」的那个岗位。向导（`below` 给的那块）**就长在这张岗位卡下面**，
   * 不再摆在页顶——按钮在页面下半截时，页顶那张卡根本看不见，点了像没反应。
   * 打开时焦点给向导里第一个选项；关上（取消 / 完成）时焦点回到这张卡的「分给同事」。
   */
  assigning?: string
  /** WP202：某张岗位卡下面要就地展开的那一块（分配向导 / 上岗回执）；没有就回 `null`。 */
  below?(position_id: string): React.ReactNode
  /** WP202：一进来就打开「新建岗位」并预填（名字 + 勾好的职责）。 */
  draft?: PositionDraft
  /** WP234（docs/54 §6.4）：合并到… / 移动职责 / 拆出…。三个都给了才出那一排。`name`：合并后叫什么（WP235）。 */
  onMerge?(id: string, into: string, name: string): void
  onMoveDuty?(id: string, role_id: string, to: string): void
  onSplit?(id: string, input: { name: string; role_ids: string[] }): void
  /** WP234：刚调整完的一句回执。 */
  notice?: string
}): React.ReactNode {
  const { t, lang } = useApp()
  // WP196：正在改名的那个岗位与两格草稿（一次一个）
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameZh, setRenameZh] = useState('')
  const [renameEn, setRenameEn] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<string[]>([])
  const [creating, setCreating] = useState(preset !== undefined)
  const [newName, setNewName] = useState(preset?.name ?? '')
  const [newRoles, setNewRoles] = useState<string[]>(preset?.roles ?? [])
  const createRef = useRef<HTMLDivElement>(null)
  // 预填是从别的页跳来的：打开以后把「新建岗位」那张卡滚到眼前
  const presetKey = preset === undefined ? undefined : `${preset.name}|${preset.roles.join(',')}`
  useEffect(() => {
    if (presetKey === undefined) return
    setCreating(true)
    const [name = '', list = ''] = presetKey.split('|')
    setNewName(name)
    setNewRoles(list === '' ? [] : list.split(','))
    requestAnimationFrame(() => {
      createRef.current?.scrollIntoView?.({ block: 'nearest' })
    })
  }, [presetKey])

  /*
   * WP202：分配向导就地展开 + 焦点来回。开的时候把焦点给向导里第一个能按的，
   * 关的时候（取消 / 完成）焦点回到那张卡的「分给同事」——人从哪儿点的，回哪儿去。
   */
  const listRef = useRef<HTMLDivElement>(null)
  const lastAssigning = useRef<string | undefined>(undefined)
  useEffect(() => {
    const root = listRef.current
    const previous = lastAssigning.current
    lastAssigning.current = assigning
    if (root === null || previous === assigning) return
    const cardOf = (id: string): Element | null =>
      [...root.querySelectorAll('[data-testid="position-card"]')].find(
        (el) => el.getAttribute('data-position') === id,
      ) ?? null
    if (assigning !== undefined) {
      const panel = cardOf(assigning)?.querySelector('[data-testid="position-below"]')
      panel?.scrollIntoView?.({ block: 'nearest' })
      panel?.querySelector<HTMLElement>('button:not([disabled]), input, select')?.focus()
      return
    }
    if (previous === undefined) return
    const button = cardOf(previous)?.querySelector<HTMLElement>('[data-testid="position-assign"]')
    button?.scrollIntoView?.({ block: 'nearest' })
    button?.focus()
  }, [assigning])
  // 折叠层里展开看规矩的那一条职责（一次一条：`岗位 id / 职责 id`）
  const [detail, setDetail] = useState<string | null>(null)

  const toggle = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id]

  const { ours, templates } = splitPositions(positions)
  /** 职责显示名：岗位视图里带的名字优先，其次职责清单，都没有才用 id。 */
  const roleNameOf = (p: OrgPositionView, id: string): string =>
    p.roles.find((r) => r.role_id === id)?.name ?? roles.find((r) => r.id === id)?.name ?? id

  const renderCard = (p: OrgPositionView, isOurs: boolean): React.ReactNode => (
    <Card key={p.id} data-testid="position-card" data-position={p.id}>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <PositionIcon
            position_id={p.id}
            icon={p.icon}
            role_ids={p.roles.map((r) => r.role_id)}
            size={20}
            className="text-ws-muted-fg"
          />
          <span data-testid="position-name">
            {lang === 'en' && p.name_en !== '' ? p.name_en : p.name}
          </span>
          <Badge variant="outline" data-testid="position-duty-count">
            {/* WP235（Fable 10-06）：你们的岗位上写「在做 N / 共 M」（M 不算「工作区成员」那条） */}
            {(() => {
              const count = isOurs ? inUseCount(p) : undefined
              return count === undefined
                ? t('org.positions.duties', { count: p.roles.length })
                : t('org.positions.duties.inuse', {
                    n: String(count.n),
                    m: String(count.m),
                  })
            })()}
          </Badge>
          {onRename === undefined || renaming === p.id ? null : (
            <Button
              size="xs"
              variant="ghost"
              data-testid="position-rename"
              disabled={busy}
              onClick={() => {
                setRenaming(p.id)
                setRenameZh(p.name)
                setRenameEn(p.name_en)
              }}
            >
              <Pencil aria-hidden className="size-3" />
              {t('org.positions.rename')}
            </Button>
          )}
        </CardTitle>
        {p.holders.length === 0 ? (
          <span className="text-muted-foreground text-xs">{t('org.positions.nobody')}</span>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="position-holders">
            {p.holders.map((h) => (
              <Holder
                key={h.person_id}
                name={h.name}
                ranges={h.ranges}
                duties={(h.role_ids ?? []).map((id) => roleNameOf(p, id))}
              />
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {/* WP196：改名——只改显示名，中英各一格；说明进问号（界面少字） */}
        {onRename === undefined || renaming !== p.id ? null : (
          <div
            className="flex flex-wrap items-end gap-2 rounded-md border p-2"
            data-testid="position-rename-form"
          >
            <div className="flex min-w-40 flex-1 flex-col gap-1">
              <Label htmlFor={`rename-zh-${p.id}`} className="text-xs">
                {t('org.positions.rename.zh')}
              </Label>
              <Input
                id={`rename-zh-${p.id}`}
                data-testid="position-rename-zh"
                value={renameZh}
                maxLength={64}
                onChange={(e) => {
                  setRenameZh(e.target.value)
                }}
              />
            </div>
            <div className="flex min-w-40 flex-1 flex-col gap-1">
              <Label htmlFor={`rename-en-${p.id}`} className="text-xs">
                {t('org.positions.rename.en')}
              </Label>
              <Input
                id={`rename-en-${p.id}`}
                data-testid="position-rename-en"
                value={renameEn}
                maxLength={64}
                onChange={(e) => {
                  setRenameEn(e.target.value)
                }}
              />
            </div>
            <div className="flex items-center gap-1">
              <Hint text={t('org.positions.rename.hint')} />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRenaming(null)
                }}
              >
                {t('org.cancel')}
              </Button>
              <Button
                size="sm"
                data-testid="position-rename-save"
                disabled={renameZh.trim() === '' || busy}
                onClick={() => {
                  const en = renameEn.trim()
                  onRename(p.id, {
                    name: renameZh.trim(),
                    ...(en === '' ? {} : { name_en: en }),
                  })
                  setRenaming(null)
                }}
              >
                {t('org.save')}
              </Button>
            </div>
          </div>
        )}
        {/* WP174：上级——超授权的审批先转他，没设就转老板。说明进问号（界面少字） */}
        {onSupervisor === undefined ? null : (
          <div className="flex items-center gap-2" data-testid="position-supervisor">
            <label htmlFor={`supervisor-${p.id}`} className="text-xs text-muted-foreground">
              {t('org.positions.supervisor')}
            </label>
            <select
              id={`supervisor-${p.id}`}
              data-testid="position-supervisor-select"
              className="h-8 rounded-md border bg-background px-2 text-sm"
              disabled={busy}
              value={p.supervisor?.person_id ?? ''}
              onChange={(e) => {
                onSupervisor(p.id, e.target.value === '' ? null : e.target.value)
              }}
            >
              <option value="">{t('org.positions.supervisor.none')}</option>
              {people.map((m) => (
                <option key={m.person_id} value={m.person_id}>
                  {m.name}
                </option>
              ))}
              {/* 上级不在候选里（刚走、名单还没刷新）也照实显示他，不悄悄换成「没设」 */}
              {p.supervisor === undefined ||
              people.some((m) => m.person_id === p.supervisor?.person_id) ? null : (
                <option value={p.supervisor.person_id}>{p.supervisor.name}</option>
              )}
            </select>
            <Hint text={t('org.positions.supervisor.hint')} />
          </div>
        )}
        {/* WP70：职责是第二层，默认折叠；点开才看得到这个岗位含哪几条 */}
        <DutyFold
          testId="position-duties"
          duties={p.roles.map((r) => ({ id: r.role_id, name: r.name }))}
          renderDuty={(duty) => {
            const inPosition = p.roles.find((r) => r.role_id === duty.id)
            const full = roles.find((r) => r.id === duty.id)
            const key = `${p.id}/${duty.id}`
            const open = detail === key
            return (
              <div className="rounded-md border" data-testid="position-duty">
                <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1.5">
                  <span className="flex items-center gap-1.5">
                    <DutyIcon role_id={duty.id} className="text-ws-muted-fg" />
                    {duty.name}
                    {inPosition?.default === false ? (
                      <Badge variant="outline">{t('org.positions.role.optional')}</Badge>
                    ) : null}
                    {inPosition?.loaded === false ? (
                      <Badge variant="destructive">{t('org.positions.role.missing')}</Badge>
                    ) : null}
                  </span>
                  {full === undefined ? null : (
                    <Button
                      size="xs"
                      variant="ghost"
                      data-testid="position-duty-detail"
                      onClick={() => {
                        setDetail(open ? null : key)
                      }}
                    >
                      {open ? t('org.positions.duty.close') : t('org.positions.duty.detail')}
                    </Button>
                  )}
                </div>
                {/* 原「职责」tab 的那张说明卡：复制一份 / 改名与额度 / 已提交审批 */}
                {open && full !== undefined ? (
                  <div className="border-t p-2">
                    <RoleDetail
                      key={full.id}
                      role={full}
                      {...(submitted === undefined ? {} : { submitted })}
                      busy={busy}
                      onCopy={onCopyRole}
                      onPropose={onProposeRole}
                    />
                  </div>
                ) : null}
              </div>
            )
          }}
        />

        {editing === p.id ? (
          <div className="flex flex-col gap-2 rounded-md border p-2">
            <span className="text-xs text-muted-foreground">{t('org.positions.pick')}</span>
            <div className="flex flex-wrap gap-1">
              {pickableRoles(
                roles,
                p.roles.map((r) => r.role_id),
              ).map((r) => (
                <button
                  key={r.id}
                  type="button"
                  data-testid="position-role-toggle"
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-muted',
                    draft.includes(r.id) && 'border-primary bg-primary/10 [--ia:var(--ws-brand)]',
                  )}
                  onClick={() => {
                    setDraft((current) => toggle(current, r.id))
                  }}
                >
                  <DutyIcon role_id={r.id} size={14} className="text-ws-muted-fg" />
                  {r.name}
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(null)
                }}
              >
                {t('org.cancel')}
              </Button>
              <Button
                size="sm"
                disabled={draft.length === 0 || busy}
                data-testid="position-save"
                onClick={() => {
                  onSaveRoles(p.id, {
                    name: p.name,
                    roles: draft.map((role_id) => ({ role_id, default: true })),
                  })
                  setEditing(null)
                }}
              >
                {t('org.save')}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            data-testid="position-assign"
            aria-expanded={assigning === p.id}
            onClick={() => {
              onAssign(p.id)
            }}
          >
            {t('org.positions.assign')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(p.id)
              setDraft(p.roles.filter((r) => r.default).map((r) => r.role_id))
            }}
          >
            {t('org.positions.edit')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="position-delete"
            disabled={busy}
            onClick={() => {
              onDelete(p.id)
            }}
          >
            {t('org.positions.delete')}
          </Button>
        </div>
        {/* WP235：合并 / 移动 / 拆出只在「你们的岗位」上，目标也只列这一块 */}
        {!isOurs ||
        onMerge === undefined ||
        onMoveDuty === undefined ||
        onSplit === undefined ? null : (
          <PositionReshape
            position={p}
            others={ours.filter((o) => o.id !== p.id)}
            busy={busy}
            onMerge={(into, name) => {
              onMerge(p.id, into, name)
            }}
            onMoveDuty={(role_id, to) => {
              onMoveDuty(p.id, role_id, to)
            }}
            onSplit={(input) => {
              onSplit(p.id, input)
            }}
          />
        )}
        {/* WP202：分配向导 / 上岗回执就地展开在这张卡里，不在页顶 */}
        {(() => {
          const node = below?.(p.id)
          return node === null || node === undefined ? null : (
            <div data-testid="position-below">{node}</div>
          )
        })()}
      </CardContent>
    </Card>
  )

  return (
    <div className="flex flex-col gap-3">
      {error === undefined ? null : (
        <p role="alert" className="text-sm text-destructive" data-testid="positions-error">
          {error}
        </p>
      )}
      {notice === undefined ? null : (
        <p className="text-sm text-muted-foreground" data-testid="positions-reshaped">
          {notice}
        </p>
      )}
      <div className="flex flex-col gap-3" ref={listRef}>
        {/* WP235：上面「你们的岗位」（有人在做的 + 自建的），下面折叠的「可以加的岗位（模板）」。
            「负责人」在页顶身份卡、「普通成员」是底座身份，都不进岗位清单 */}
        <section className="flex flex-col gap-3" data-testid="positions-ours">
          <h3 className="font-medium text-sm">{t('org.positions.ours')}</h3>
          {ours.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('org.positions.ours.empty')}</p>
          ) : (
            ours.map((p) => renderCard(p, true))
          )}
        </section>
        {templates.length === 0 ? null : (
          <details className="group flex flex-col gap-3" data-testid="positions-templates">
            <summary className="flex cursor-pointer items-center gap-2 font-medium text-sm">
              {t('org.positions.templates')}
              <Badge variant="outline">{templates.length}</Badge>
              <Hint text={t('org.positions.templates.hint')} />
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              {templates.map((p) => renderCard(p, false))}
            </div>
          </details>
        )}
      </div>

      {creating ? (
        <Card ref={createRef} data-testid="new-position-card">
          <CardHeader>
            <CardTitle className="text-sm">{t('org.positions.new')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-position-name">{t('org.positions.name')}</Label>
              <Input
                id="new-position-name"
                value={newName}
                placeholder={t('org.positions.name.hint')}
                onChange={(e) => {
                  setNewName(e.target.value)
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">{t('org.positions.pick')}</span>
              <div className="flex flex-wrap gap-1">
                {pickableRoles(roles).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    data-testid="new-position-role"
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-muted',
                      newRoles.includes(r.id) &&
                        'border-primary bg-primary/10 [--ia:var(--ws-brand)]',
                    )}
                    onClick={() => {
                      setNewRoles((current) => toggle(current, r.id))
                    }}
                  >
                    <DutyIcon role_id={r.id} size={14} className="text-ws-muted-fg" />
                    {r.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCreating(false)
                }}
              >
                {t('org.cancel')}
              </Button>
              <Button
                size="sm"
                data-testid="new-position-save"
                disabled={newName.trim() === '' || newRoles.length === 0 || busy}
                onClick={() => {
                  onCreate({
                    name: newName.trim(),
                    roles: newRoles.map((role_id) => ({ role_id, default: true })),
                  })
                  setCreating(false)
                  setNewName('')
                  setNewRoles([])
                }}
              >
                {t('org.positions.create')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div>
          <Button
            variant="outline"
            size="sm"
            data-testid="position-new"
            onClick={() => {
              setCreating(true)
            }}
          >
            {t('org.positions.new')}
          </Button>
        </div>
      )}
    </div>
  )
}
