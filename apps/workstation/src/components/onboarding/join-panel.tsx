/**
 * 加入 / 邀请（46 §2 I2 I3）。
 *
 * 三块，按用的地方取舍：
 *
 * - **加入**：贴一个邀请码，或从局域网上看见的同伴里挑一位 → 申请加入。
 *   向导第 ① 步与公司页都用这一块。
 * - **邀请**：owner 发一个 8 位码（24h、默认 5 次）。只在公司页出。
 * - **谁申请过**：owner 同意 / 拒绝。同一条也在首页队列里等着（14 的 membership 卡），
 *   这里只是让它离"公司"这个语境近一点。
 *
 * 界面上一个内部 id 都不出：同伴报的是"王岚的工作区 · 3 人"，申请人只有名字与邮箱。
 */
import { useState } from 'react'
import { PickToggle } from '@/components/onboarding/pick-toggle'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import type { DiscoveryStateView, InviteView, MembershipRequestView } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export interface JoinSubmit {
  code?: string
  peer_id?: string
}

export function JoinPanel({
  discovery,
  configured,
  me,
  invites,
  requests,
  busy,
  sent,
  error,
  onJoin,
  onCreateInvite,
  onDecide,
}: {
  discovery?: DiscoveryStateView
  /**
   * 公司档案设过没有。没设过的话开关那一栏还只是一份草稿——服务端那边既没有公司名
   * 也就没有钥匙，不广播也不监听。这时候说"开关关着"是误导（界面上它明明开着），
   * 该说的是"先把公司全称存下来"。
   */
  configured?: boolean
  me: { name: string; email: string }
  /** 不给 = 不显示"邀请同事"那一块（向导第 ① 步就不给）。 */
  invites?: InviteView[]
  /** 不给 = 不显示"谁申请过加入"。 */
  requests?: MembershipRequestView[]
  busy: boolean
  sent: boolean
  error?: string
  onJoin(input: JoinSubmit): void
  onCreateInvite?(): void
  onDecide?(id: string, approve: boolean): void
}): React.ReactNode {
  const { t, lang } = useApp()
  const [code, setCode] = useState('')
  const [peer, setPeer] = useState<string | null>(null)
  const peers = discovery?.peers ?? []

  const when = (iso: string): string =>
    new Date(iso).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')

  const statusText = (r: MembershipRequestView): string => t(`onboarding.requests.${r.status}`)

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="join-panel">
      <section className="flex flex-col gap-2">
        <p className="font-medium">{t('onboarding.join.title')}</p>
        <p className="text-xs text-muted-foreground">{t('onboarding.join.subtitle')}</p>

        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="join-code" className="flex items-center gap-1 text-xs">
              {t('onboarding.join.code')}
              <Hint text={t('onboarding.join.code.hint')} />
            </Label>
            <Input
              id="join-code"
              data-testid="join-code"
              value={code}
              placeholder={t('onboarding.join.code.placeholder')}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase())
                setPeer(null)
              }}
            />
          </div>
          <Button
            size="sm"
            data-testid="join-submit"
            disabled={busy || (code.trim() === '' && peer === null)}
            onClick={() => {
              onJoin(peer === null ? { code: code.trim() } : { peer_id: peer })
            }}
          >
            {t('onboarding.join.submit')}
          </Button>
        </div>

        {/* 局域网上看见的同伴（46 §2 I3：看见之后按钮就是"申请加入他们"） */}
        <div className="flex flex-col gap-1" data-testid="join-peers">
          {discovery === undefined ? null : configured === false ? (
            <p className="text-xs text-muted-foreground">{t('onboarding.join.peers.no_profile')}</p>
          ) : !discovery.available ? (
            <p className="text-xs text-muted-foreground">
              {t('onboarding.join.peers.unavailable', {
                reason: discovery.reason ?? '',
              })}
            </p>
          ) : !discovery.enabled ? (
            <p className="text-xs text-muted-foreground">{t('onboarding.join.peers.off')}</p>
          ) : peers.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('onboarding.join.peers.empty')}</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {t('onboarding.join.peers', { n: String(peers.length) })}
              </p>
              <div className="flex flex-wrap gap-2">
                {peers.map((p) => (
                  <PickToggle
                    key={p.peer_id}
                    checked={peer === p.peer_id}
                    testId="join-peer"
                    onToggle={() => {
                      setPeer(peer === p.peer_id ? null : p.peer_id)
                      setCode('')
                    }}
                  >
                    {p.workspace_label}
                  </PickToggle>
                ))}
              </div>
            </>
          )}
        </div>

        {sent ? (
          <p className="text-xs text-muted-foreground" data-testid="join-sent">
            {t('onboarding.join.sent')}
          </p>
        ) : null}
        {error === undefined ? null : (
          <p role="alert" className="text-destructive" data-testid="join-error">
            {error}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {me.name === '' ? me.email : `${me.name}（${me.email}）`}
        </p>
      </section>

      {invites === undefined ? null : (
        <>
          <Separator />
          <section className="flex flex-col gap-2" data-testid="invite-section">
            <p className="flex items-center gap-1 font-medium">
              {t('onboarding.invite.title')}
              <Hint text={t('onboarding.invite.hint')} />
            </p>
            {invites.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('onboarding.invite.empty')}</p>
            ) : (
              invites.map((i) => (
                <div
                  key={i.code}
                  className="flex items-center justify-between rounded-md border p-2"
                  data-testid="invite-row"
                >
                  <span className="font-mono text-base tracking-widest">{i.code}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('onboarding.invite.uses', { n: String(i.uses_left) })} ·{' '}
                    {t('onboarding.invite.expires', { at: when(i.expires_at) })}
                  </span>
                </div>
              ))
            )}
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                data-testid="invite-create"
                disabled={busy || onCreateInvite === undefined}
                onClick={() => {
                  onCreateInvite?.()
                }}
              >
                {t('onboarding.invite.create')}
              </Button>
            </div>
          </section>
        </>
      )}

      {requests === undefined ? null : (
        <>
          <Separator />
          <section className="flex flex-col gap-2" data-testid="requests-section">
            <p className="font-medium">{t('onboarding.requests.title')}</p>
            {requests.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('onboarding.requests.empty')}</p>
            ) : (
              requests.map((r) => (
                <div key={r.id} className="rounded-md border p-2" data-testid="request-row">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p>
                        {r.person.name}
                        <span className="ml-2 text-xs text-muted-foreground">{r.person.email}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t(`onboarding.requests.via.${r.via}`)} · {statusText(r)}
                      </p>
                      {r.superseded_reason === undefined ? null : (
                        <p className="text-xs text-muted-foreground">{r.superseded_reason}</p>
                      )}
                    </div>
                    {r.status !== 'pending' || onDecide === undefined ? null : (
                      <div className="flex gap-2">
                        <Button
                          size="xs"
                          variant="outline"
                          data-testid="request-reject"
                          disabled={busy}
                          onClick={() => {
                            onDecide(r.id, false)
                          }}
                        >
                          {t('onboarding.requests.reject')}
                        </Button>
                        <Button
                          size="xs"
                          data-testid="request-approve"
                          disabled={busy}
                          onClick={() => {
                            onDecide(r.id, true)
                          }}
                        >
                          {t('onboarding.requests.approve')}
                        </Button>
                      </div>
                    )}
                  </div>
                  {r.status === 'pending' ? (
                    <p className="pt-1 text-xs text-muted-foreground">
                      {t('onboarding.requests.card')}
                    </p>
                  ) : null}
                </div>
              ))
            )}
          </section>
        </>
      )}
    </div>
  )
}
