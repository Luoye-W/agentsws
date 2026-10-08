/**
 * WP277（docs/95 §3.4–§3.6，决策 239 / 240）：③ 公司模式在工作台上的那几样。
 *
 * - {@link CompanyModeEntry}：一行小字入口——发起人看到「开公司模式…」，③ 里老板看到「回到同事互联…」。
 *   放在设置页底部与团队页底部（不在首页推，docs/95 §7 D 单）；别人什么都看不到。
 * - {@link CompanyWizard}：开公司模式三步——公司全称（带出「主体信息」里填过的）、谁是老板（默认自己）、
 *   管理员（可不选）。
 * - {@link CloseDialog}：回到同事互联的确认（只有老板；离职交接没做完时按钮不能点）。
 * - {@link ModeNotice}：降回 ② 之后同事首页那一行通知（不是卡）；点「知道了」就不再出（只记在这台浏览器）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { ApiClientError, ensureSession, getPositions, listOrganizations } from '@/lib/api'
import { type CompanyModeView, getCompanyMode, setCompanyMode } from '@/lib/api-company'
import { exportMyWork } from '@/lib/api-peers'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 这一摊共用的数：哪家公司、我是谁、用哪条分配去改（所有者那条）、能不能开 / 降。 */
function useCompanySetup(): {
  orgId: string | undefined
  me: string | undefined
  assignment: string | undefined
  setup: CompanyModeView | undefined
} {
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: () => listOrganizations(), retry: false })
  const session = useQuery({ queryKey: ['session'], queryFn: ensureSession })
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const orgId = orgs.data?.[0]?.id
  const assignment = positions.data?.positions.find(
    (p) => p.role_id === 'common.owner',
  )?.position_id
  const setup = useQuery({
    queryKey: ['company-mode', orgId, assignment],
    queryFn: () => getCompanyMode(orgId ?? '', assignment),
    enabled: orgId !== undefined,
    retry: false,
  })
  return { orgId, me: session.data?.person.id, assignment, setup: setup.data }
}

const errorText = (err: unknown, fallback: string): string =>
  err instanceof ApiClientError ? err.message : fallback

/** 一行小字入口。没得开、也没得降（不是发起人 / 老板）就什么都不出。 */
export function CompanyModeEntry({ className }: { className?: string }): React.ReactNode {
  const { t } = useApp()
  const { orgId, me, assignment, setup } = useCompanySetup()
  const [open, setOpen] = useState(false)
  if (setup === undefined || orgId === undefined) return null
  if (!setup.can_open && !(setup.mode === 'company' && setup.owner_id === me)) return null
  const closing = setup.mode === 'company'
  return (
    <div
      className={cn('flex items-center gap-1 text-xs text-muted-foreground', className)}
      data-testid="company-entry"
      data-mode={setup.mode}
    >
      <button
        type="button"
        className="underline-offset-2 hover:text-foreground hover:underline"
        data-testid={closing ? 'company-close-entry' : 'company-open-entry'}
        onClick={() => {
          setOpen(true)
        }}
      >
        {closing ? t('company.close') : t('company.entry')}
      </button>
      {closing ? null : <Hint text={t('company.entry.hint')} />}
      {closing ? (
        <CloseDialog
          open={open}
          onOpenChange={setOpen}
          orgId={orgId}
          setup={setup}
          {...(assignment === undefined ? {} : { assignment })}
        />
      ) : (
        <CompanyWizard
          open={open}
          onOpenChange={setOpen}
          orgId={orgId}
          setup={setup}
          {...(me === undefined ? {} : { me })}
          {...(assignment === undefined ? {} : { assignment })}
        />
      )}
    </div>
  )
}

/** 开公司模式三步。 */
export function CompanyWizard({
  open,
  onOpenChange,
  orgId,
  setup,
  me,
  assignment,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string
  setup: CompanyModeView
  me?: string
  assignment?: string
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [step, setStep] = useState(1)
  const [legal, setLegal] = useState(setup.legal_name)
  const [boss, setBoss] = useState(me ?? setup.owner_id)
  // 再开时带出以前的管理员（降回 ② 时没删，docs/95 §3.6）
  const [admins, setAdmins] = useState<string[]>(
    setup.people.filter((p) => p.role === 'admin').map((p) => p.person_id),
  )
  const save = useMutation({
    mutationFn: () =>
      setCompanyMode(
        orgId,
        {
          mode: 'company',
          legal_name: legal.trim(),
          boss,
          admins: admins.filter((p) => p !== boss),
        },
        assignment,
      ),
    onSuccess: async () => {
      onOpenChange(false)
      setStep(1)
      // 模式一变，左栏、公司页、卡片的说法全变——整个缓存作废最省心
      await client.invalidateQueries()
    },
  })
  const nameOf = (p: CompanyModeView['people'][number]): string =>
    p.person_id === me ? t('company.wizard.you', { name: p.name }) : p.name
  const others = setup.people.filter((p) => p.person_id !== boss)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="company-wizard"
        data-step={step}
        className="sm:max-w-md"
        // 一打开先落在全称那一格（不然焦点落在问号上，tooltip 把标题挡住）
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          document.getElementById('company-legal-name')?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t('company.wizard.title')}
            <span className="text-xs font-normal text-muted-foreground">
              {t('company.wizard.step', { n: step })}
            </span>
          </DialogTitle>
        </DialogHeader>

        {step === 1 ? (
          <div className="flex flex-col gap-1.5 text-sm">
            <span className="flex items-center gap-1 font-medium">
              <label htmlFor="company-legal-name">{t('company.wizard.legal_name')}</label>
              <Hint text={t('company.wizard.legal_name.hint')} />
            </span>
            <Input
              id="company-legal-name"
              data-testid="company-legal-name"
              value={legal}
              maxLength={200}
              onChange={(e) => {
                setLegal(e.target.value)
              }}
            />
          </div>
        ) : null}

        {step === 2 ? (
          <fieldset className="flex flex-col gap-1.5 text-sm">
            <legend className="mb-1.5 flex items-center gap-1 font-medium">
              {t('company.wizard.boss')}
              <Hint text={t('company.wizard.boss.hint')} />
            </legend>
            {setup.people.map((p) => (
              <button
                key={p.person_id}
                type="button"
                aria-pressed={boss === p.person_id}
                data-testid="company-boss"
                data-person={p.person_id}
                onClick={() => {
                  setBoss(p.person_id)
                }}
                className={cn(
                  'flex h-9 items-center rounded-lg border px-3 text-left',
                  boss === p.person_id ? 'border-ws-brand bg-ws-surface' : 'hover:bg-muted',
                )}
              >
                {nameOf(p)}
              </button>
            ))}
          </fieldset>
        ) : null}

        {step === 3 ? (
          <fieldset className="flex flex-col gap-1.5 text-sm">
            <legend className="mb-1.5 flex items-center gap-1 font-medium">
              {t('company.wizard.admins')}
              <Hint text={t('company.wizard.admins.hint')} />
            </legend>
            {others.length === 0 ? (
              <p className="text-muted-foreground">{t('company.wizard.none')}</p>
            ) : (
              others.map((p) => {
                const on = admins.includes(p.person_id)
                return (
                  <button
                    key={p.person_id}
                    type="button"
                    aria-pressed={on}
                    data-testid="company-admin"
                    data-person={p.person_id}
                    onClick={() => {
                      setAdmins((xs) =>
                        on ? xs.filter((x) => x !== p.person_id) : [...xs, p.person_id],
                      )
                    }}
                    className={cn(
                      'flex h-9 items-center rounded-lg border px-3 text-left',
                      on ? 'border-ws-brand bg-ws-surface' : 'hover:bg-muted',
                    )}
                  >
                    {nameOf(p)}
                  </button>
                )
              })
            )}
          </fieldset>
        ) : null}

        {save.error === null ? null : (
          <p role="alert" className="text-xs text-destructive">
            {errorText(save.error, t('error.generic'))}
          </p>
        )}
        <div className="flex items-center justify-between">
          {step > 1 ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="company-back"
              onClick={() => {
                setStep((n) => n - 1)
              }}
            >
              {t('company.wizard.back')}
            </Button>
          ) : (
            <span />
          )}
          {step < 3 ? (
            <Button
              size="sm"
              data-testid="company-next"
              disabled={step === 1 && legal.trim() === ''}
              onClick={() => {
                setStep((n) => n + 1)
              }}
            >
              {t('company.wizard.next')}
            </Button>
          ) : (
            <Button
              size="sm"
              data-testid="company-open"
              disabled={save.isPending || legal.trim() === ''}
              onClick={() => {
                save.mutate()
              }}
            >
              {t('company.wizard.open')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 回到同事互联的确认（只有老板看得到入口）。 */
export function CloseDialog({
  open,
  onOpenChange,
  orgId,
  setup,
  assignment,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string
  setup: CompanyModeView
  assignment?: string
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const save = useMutation({
    mutationFn: () => setCompanyMode(orgId, { mode: 'peers' }, assignment),
    onSuccess: async () => {
      onOpenChange(false)
      await client.invalidateQueries()
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="company-close-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('company.close.title')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t('company.close.body')}</p>
        {setup.close_blocked === undefined && save.error === null ? null : (
          <p role="alert" className="text-xs text-destructive" data-testid="company-close-blocked">
            {setup.close_blocked ?? errorText(save.error, t('error.generic'))}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onOpenChange(false)
            }}
          >
            {t('company.close.cancel')}
          </Button>
          <Button
            size="sm"
            data-testid="company-close-confirm"
            disabled={!setup.can_close || save.isPending}
            onClick={() => {
              save.mutate()
            }}
          >
            {t('company.close.confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

const SEEN_KEY = 'agentsws.mode-notice.seen'

function seenAt(): string | null {
  try {
    return globalThis.localStorage?.getItem(SEEN_KEY) ?? null
  } catch {
    return null
  }
}

/**
 * 决策 240：老板改回同事互联之后，别的同事首页一行通知（不是卡）。点「知道了」记在这台浏览器上
 * ——读不到本地存储（隐私窗口）就每次都出，不影响别的。
 */
export function ModeNotice(): React.ReactNode {
  const { t } = useApp()
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: () => listOrganizations(), retry: false })
  const session = useQuery({ queryKey: ['session'], queryFn: ensureSession })
  const [dismissed, setDismissed] = useState<string | null>(seenAt)
  const org = orgs.data?.[0]
  const me = session.data?.person.id
  if (
    org === undefined ||
    me === undefined ||
    org.mode !== 'peers' ||
    org.mode_changed_by === undefined ||
    org.mode_changed_by === me ||
    org.mode_changed_at === undefined ||
    dismissed === org.mode_changed_at
  )
    return null
  const at = org.mode_changed_at
  return (
    <p
      className="flex items-center gap-2 rounded-lg bg-ws-surface px-3 py-1.5 text-[13px]"
      data-testid="mode-notice"
    >
      <span className="min-w-0 flex-1 truncate">
        {t('mode.notice.peers', { name: org.mode_changed_by_name ?? '' })}
      </span>
      <button
        type="button"
        aria-label={t('mode.notice.ok')}
        title={t('mode.notice.ok')}
        className="text-ws-muted-fg hover:text-foreground"
        data-testid="mode-notice-ok"
        onClick={() => {
          try {
            globalThis.localStorage?.setItem(SEEN_KEY, at)
          } catch {
            // 存不住就只在这一次收起
          }
          setDismissed(at)
        }}
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </p>
  )
}

/** 「X 把这里改成了公司模式」那张卡（`policy_change`、`form: 'company_notice'`）。 */
export function isCompanyNoticeCard(card: {
  kind: string
  detail: { payload?: unknown }
}): boolean {
  const p = card.detail.payload
  return (
    card.kind === 'policy_change' &&
    typeof p === 'object' &&
    p !== null &&
    (p as { form?: unknown }).form === 'company_notice'
  )
}

/**
 * 决策 239：那张卡上「我要退出」之前，可以先导出一份自己建的（与团队页「导出我的副本」同一条接口）。
 * 退出会怎样进问号，卡面只多这一个小按钮。
 */
export function CompanyNoticeExtras(): React.ReactNode {
  const { t } = useApp()
  const exported = useMutation({
    mutationFn: exportMyWork,
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'my-work.json'
      a.click()
      URL.revokeObjectURL(url)
    },
  })
  return (
    <p
      className="flex items-center gap-1.5 text-xs text-ws-muted-fg"
      data-testid="company-notice-extras"
    >
      <button
        type="button"
        className="underline-offset-2 hover:text-foreground hover:underline"
        data-testid="company-notice-export"
        disabled={exported.isPending}
        onClick={() => {
          exported.mutate()
        }}
      >
        {exported.isSuccess ? t('company.notice.exported') : t('company.notice.export')}
      </button>
      <Hint text={t('company.notice.leave.hint')} />
    </p>
  )
}
