/**
 * WP173（docs/84 §2 / §11.1）：「主动开发」岗位页上那一块**能动手的**——开发信。
 *
 * 面板那四块（今天待发 · 序列漏斗 · 回复待分 · 名单来源）是只读表格；这里补"动手"那一半：
 * 发信邮箱与体检、公司地址（页脚要）、德国 / 奥地利的勾选确认、开一轮。
 *
 * 界面纪律（36 §7「界面少字」）：
 *
 * 1. 一行一件事；原因进问号，长说明进教程（`b2b-sending-domain`）。
 * 2. **发不了的原因看得见**：没选邮箱、体检没过、没填地址、德奥默认不发，都是可见的一句，不是灰掉的按钮。
 * 3. 德奥要**勾选 + 再点一次确认**才发（docs/84 §11.1 第 6 条），那句原因常驻。
 *
 * WP176：公司地址搬进公司档案（这里只读显示、链过去）；「这只邮箱已经正常发信很久」可勾（不预热）；
 * DKIM 按 DNS 判的写明「未经实信验证」；说过不感兴趣、还在冷却里的人一行，名单与到期日进问号。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail, RefreshCw, Send } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { StatusPill } from '@/components/design/primitives'
import type { Tone } from '@/components/design/tone'
import { TutorialLink } from '@/components/help/tutorial-link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import {
  type B2bAuthResultData,
  type B2bOutboundData,
  type B2bSequenceStartData,
  checkB2bSender,
  getB2bOutbound,
  saveB2bOutboundSettings,
  startB2bSequence,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

const AUTH_TONE: Readonly<Record<B2bAuthResultData, Tone>> = {
  pass: 'good',
  fail: 'bad',
  missing: 'bad',
  pending: 'warn',
  unknown: 'neutral',
}

function AuthPill({
  label,
  result,
  soft,
  viaDns,
}: {
  label: string
  result: B2bAuthResultData
  /** DMARC 缺了只提示：没过也是黄的，不是红的。 */
  soft?: boolean
  /** WP176：DKIM 按 DNS 记录判的（测试信没收回来）——能发，但黄色、写明未经实信验证。 */
  viaDns?: boolean
}): React.ReactNode {
  const { t } = useApp()
  const tone =
    viaDns === true && result === 'pass'
      ? 'warn'
      : soft === true && AUTH_TONE[result] === 'bad'
        ? 'warn'
        : AUTH_TONE[result]
  return (
    <StatusPill
      tone={tone}
      data-auth={label.toLowerCase()}
      data-result={result}
      {...(viaDns === true ? { 'data-via': 'dns' } : {})}
    >
      {label}{' '}
      {viaDns === true && result === 'pass' ? t('b2b.out.auth.dns') : t(`b2b.out.auth.${result}`)}
    </StatusPill>
  )
}

export function B2bOutboundPanel({ assignment }: { assignment: string }): React.ReactNode {
  const { t } = useApp()
  const qc = useQueryClient()
  const key = ['b2b-outbound', assignment]
  const q = useQuery({ queryKey: key, queryFn: () => getB2bOutbound(assignment) })
  const [product, setProduct] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<B2bSequenceStartData | undefined>(undefined)
  const refresh = (data: B2bOutboundData): void => {
    qc.setQueryData(key, data)
  }
  const save = useMutation({
    mutationFn: (input: Parameters<typeof saveB2bOutboundSettings>[0]) =>
      saveB2bOutboundSettings(input, assignment),
    onSuccess: refresh,
  })
  const check = useMutation({ mutationFn: () => checkB2bSender(assignment), onSuccess: refresh })
  const start = useMutation({
    mutationFn: () =>
      startB2bSequence(product.trim() === '' ? {} : { product: product.trim() }, assignment),
    onSuccess: async (data) => {
      setResult(data)
      await qc.invalidateQueries({ queryKey: key })
      await qc.invalidateQueries({ queryKey: ['view'] })
    },
  })
  const v = q.data
  if (v === undefined) return null
  const deAt = v.excluded.find((x) => x.reason === 'de_at')
  const sender = v.sender
  const postal = v.settings.postal_address
  const cooling = v.cooling ?? []

  return (
    <Card data-testid="b2b-outbound-panel">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="size-4" aria-hidden />
          {t('b2b.out.title')}
        </CardTitle>
        <TutorialLink slug="b2b-sending-domain" />
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {/* ① 发信邮箱与体检 */}
        <section data-testid="b2b-sender" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ws-muted-fg">{t('b2b.out.sender')}</span>
            {sender === undefined ? (
              <span data-testid="b2b-sender-none">
                {v.settings.sender_choice === 'separate_pending'
                  ? t('b2b.out.sender.pending')
                  : t('b2b.out.sender.none')}
              </span>
            ) : (
              <>
                <span className="font-medium">{sender.address}</span>
                {sender.separate_domain ? (
                  <StatusPill tone="good">{t('b2b.out.separate')}</StatusPill>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <StatusPill tone="warn">{t('b2b.out.primary')}</StatusPill>
                    <Hint text={t('b2b.out.primary.risk')} />
                  </span>
                )}
              </>
            )}
          </div>
          {sender === undefined ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <AuthPill label="SPF" result={sender.auth.spf} />
              <AuthPill
                label="DKIM"
                result={sender.auth.dkim}
                viaDns={sender.auth.dkim_via === 'dns'}
              />
              <AuthPill label="DMARC" result={sender.auth.dmarc} soft />
              {sender.auth.notes.length === 0 ? null : (
                <Hint text={sender.auth.notes.join('\n')} testId="b2b-auth-notes" />
              )}
              <Button
                size="xs"
                variant="ghost"
                disabled={check.isPending}
                onClick={() => check.mutate()}
              >
                <RefreshCw className="size-3.5" aria-hidden />
                {t('b2b.out.check')}
              </Button>
            </div>
          )}
          {sender !== undefined && v.needs.includes('sender_auth') ? (
            <p className="text-ws-bad" data-testid="b2b-auth-block">
              {t('b2b.out.auth.block')}
            </p>
          ) : null}
          {sender === undefined ? null : (
            <label className="flex items-center gap-2 text-ws-muted-fg">
              <input
                type="checkbox"
                data-testid="b2b-established"
                checked={sender.established === true}
                disabled={save.isPending}
                onChange={(e) => save.mutate({ sender_established: e.target.checked })}
              />
              {t('b2b.out.established')}
              <Hint text={t('b2b.out.established.hint')} testId="b2b-established-hint" />
            </label>
          )}
          {sender === undefined ? null : (
            <p className="text-ws-muted-fg" data-testid="b2b-quota">
              {t('b2b.out.quota', { remaining: sender.quota.remaining })} ·{' '}
              {sender.quota.warming && sender.quota.warm_from !== undefined
                ? t('b2b.out.quota.warming', {
                    cap: sender.quota.cap,
                    date: sender.quota.warm_from.slice(5, 10),
                  })
                : t('b2b.out.quota.cap', { cap: sender.quota.cap })}
            </p>
          )}
        </section>

        {/* ② 公司地址：真源是公司档案（开发信页脚、报价单、单证同一份），这里只读显示、链过去 */}
        <section className="flex flex-col gap-1" data-testid="b2b-address">
          <span className="flex items-center gap-1 text-ws-muted-fg">
            {t('b2b.out.address')}
            <Hint text={`${t('b2b.out.address.hint')}。${t('b2b.out.address.from')}`} />
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {postal === undefined ? (
              <span className="text-ws-bad" data-testid="b2b-address-none">
                {t('b2b.out.address.none')}
              </span>
            ) : (
              <span className="whitespace-pre-line" data-testid="b2b-address-value">
                {postal}
              </span>
            )}
            <Link
              to="/settings#company"
              className="text-primary underline-offset-4 hover:underline"
              data-testid="b2b-address-edit"
            >
              {t('b2b.out.address.edit')}
            </Link>
          </div>
        </section>

        {/* ③ 德国 / 奥地利：默认不发，原因常驻；勾选 + 再点一次才发 */}
        <section className="flex flex-col gap-1.5" data-testid="b2b-de-at">
          {v.settings.de_at_confirmed ? (
            <p className="flex items-center gap-2 text-ws-warn">
              {t('b2b.out.deat.on')}
              <Button
                size="xs"
                variant="ghost"
                onClick={() => save.mutate({ de_at_confirm: false })}
              >
                {t('b2b.out.deat.off')}
              </Button>
            </p>
          ) : (
            <>
              {deAt === undefined ? null : (
                <p data-testid="b2b-de-at-excluded">
                  {t('b2b.out.deat.excluded', { count: deAt.count })}：{t('b2b.out.deat.reason')}
                </p>
              )}
              {confirming ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-ws-warn">{t('b2b.out.deat.reason')}</span>
                  <Button
                    size="xs"
                    variant="destructive"
                    onClick={() => {
                      setConfirming(false)
                      save.mutate({ de_at_confirm: true })
                    }}
                  >
                    {t('b2b.out.deat.confirm')}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
                    {t('b2b.out.deat.cancel')}
                  </Button>
                </div>
              ) : (
                <label className="flex items-center gap-2 text-ws-muted-fg">
                  <input
                    type="checkbox"
                    data-testid="b2b-de-at-check"
                    checked={false}
                    onChange={() => setConfirming(true)}
                  />
                  {t('b2b.out.deat')}
                </label>
              )}
            </>
          )}
        </section>

        {/* ④ 开一轮 */}
        <section className="flex flex-col gap-2" data-testid="b2b-start">
          <div className="flex gap-2">
            <Input
              value={product}
              placeholder={t('b2b.out.product.placeholder')}
              onChange={(e) => setProduct(e.target.value)}
            />
            <Button
              size="sm"
              disabled={start.isPending || v.eligible === 0}
              onClick={() => start.mutate()}
            >
              <Send className="size-3.5" aria-hidden />
              {v.eligible === 0
                ? t('b2b.out.start.none')
                : t('b2b.out.start', { count: v.eligible })}
            </Button>
          </div>
          {cooling.length === 0 ? null : (
            <p className="flex items-center gap-1 text-ws-muted-fg" data-testid="b2b-cooling">
              {t('b2b.out.cooling', { count: cooling.length })}
              <Hint
                testId="b2b-cooling-hint"
                text={[
                  t('b2b.out.cooling.hint'),
                  ...cooling.slice(0, 10).map((c) =>
                    t('b2b.out.cooling.row', {
                      who:
                        c.company === undefined
                          ? (c.name ?? c.masked)
                          : `${c.company}（${c.name ?? c.masked}）`,
                      date: c.until.slice(0, 10),
                    }),
                  ),
                ].join('\n')}
              />
            </p>
          )}
          {Object.entries(v.queued).map(([reason, count]) => (
            <p
              key={reason}
              className="text-ws-muted-fg"
              data-testid="b2b-queued"
              data-reason={reason}
            >
              {t('b2b.out.queued', { reason: t(`b2b.out.reason.${reason}`), count: count ?? 0 })}
            </p>
          ))}
          {result === undefined ? null : (
            <div
              data-testid="b2b-start-result"
              data-status={result.status}
              className="flex flex-col gap-1"
            >
              <p className={result.status === 'blocked' ? 'text-ws-bad' : ''}>{result.message}</p>
              {result.excluded.length === 0 ? null : (
                <ul className="flex flex-col gap-0.5 text-ws-muted-fg">
                  {result.excluded.slice(0, 5).map((x) => (
                    <li key={x.contact_id} data-reason={x.reason}>
                      {x.company}（{x.name}）：{x.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  )
}
