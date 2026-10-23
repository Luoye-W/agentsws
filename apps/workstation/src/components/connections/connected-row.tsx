/**
 * 已连接的一条（WP20 起；WP210 按 Luoye 09-30 收拾）。
 *
 * - **大标题是账号本身**（`accountLabel`：邮箱地址、店名…），类型名（「任意邮箱（IMAP / SMTP）」、
 *   「Shopify」）降成标题下一行小字；
 * - 「凭据存在哪」「上次测试」这类基础信息进标题旁的问号，卡面上不铺；
 * - 留下的只有：状态、测试、断开、试连失败的原因、老办法接的提醒，以及邮箱那几个开关
 *   （客服信怎么动邮箱）；
 * - **没进来的信不在这里**：系统按退避自己重投，彻底投不进的只进后台日志（设置 → 诊断），
 *   客户来信才出卡（WP210 ④）。
 *
 * 这里显示的每一样都来自 `GET /v1/connections`——那个响应里**没有凭据**，
 * 所以这个组件不可能把凭据画出来。
 */

import { AlertTriangle, Link2Off, Plug, RefreshCw } from 'lucide-react'
import { BrandIcon } from '@/components/brand-icons'
import { StatusIcons, StatusPill, type StatusState } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Switch } from '@/components/ui/switch'
import type { ConnectionView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDate } from '@/lib/format'
import { accountLabel } from './account-label'
import { MailboxSwitches } from './mailbox-switches'
import { TestResultLine } from './test-result'

export function ConnectedRow({
  connection,
  busy,
  onTest,
  onDisconnect,
  assignment,
  onPersonal,
}: {
  connection: ConnectionView
  busy: 'test' | 'remove' | undefined
  onTest: () => void
  onDisconnect: () => void
  /** WP167：邮箱卡上的开关要按哪条岗位去读写（连接页的 owner 岗位）。 */
  assignment?: string | undefined
  /**
   * WP278（决策 278）：② 里自己接的那条可以标「个人」（退出时一起断开、凭据删掉）。
   * 不给 / 不是他接的 = 不出这个开关。
   */
  onPersonal?: ((personal: boolean) => void) | undefined
}): React.ReactNode {
  const { t, lang } = useApp()
  const title = accountLabel(connection)
  const reconnect = connection.brand_conflict?.kind === 'reconnect'
  // 问号里：这是哪一类连接、凭据存在哪、上次什么时候测的（基础信息，不上卡面）
  const meta = [
    t(`connections.store.${connection.credential_store}`),
    connection.last_tested_at === undefined
      ? t('connections.never_tested')
      : t('connections.last_tested', { at: formatDate(connection.last_tested_at, lang) }),
  ].join(' · ')
  return (
    <li
      data-testid="connection-row"
      data-service={connection.service}
      data-status={connection.status}
      // WP456-T6（§3.8）：列表组里的一行（原来是一张带边框的卡）
      className="ws-row flex-col items-stretch gap-2 py-2.5"
    >
      <div className="flex min-h-9 flex-wrap items-center gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-ws-surface">
          <BrandIcon provider={connection.service} size={18} />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className="truncate text-ws-read font-medium text-ws-ink"
              data-testid="connection-title"
            >
              {title}
            </span>
            <Hint text={meta} testId="connection-meta" />
          </span>
          {title === connection.service_label ? null : (
            <span className="text-xs text-ws-muted-fg" data-testid="connection-kind">
              {connection.service_label}
            </span>
          )}
        </div>
        {/*
          WP214（36 §7 第四档）：「正常」那枚徽章换成一个状态小图标（上次测试在 tooltip 里）；
          要人动手的（要重新授权 / 已停用）徽章照旧常显那句
        */}
        <StatusIcons
          testId="connection-status"
          items={[
            {
              key: 'connection',
              label: t('models.cap.connect'),
              state: connectionState(connection, busy === 'test'),
              stateText: t(`connections.status.${connection.status}`),
              icon: Plug,
              detail:
                connection.last_tested_at === undefined
                  ? t('connections.never_tested')
                  : t('connections.last_tested', {
                      at: formatDate(connection.last_tested_at, lang),
                    }),
            },
          ]}
        />
        {connection.status === 'active' ? null : (
          <StatusPill tone="bad">{t(`connections.status.${connection.status}`)}</StatusPill>
        )}
        <div className="ml-auto flex items-center gap-1">
          {onPersonal === undefined || connection.mine !== true || reconnect ? null : (
            <span
              className="mr-1 flex items-center gap-1 text-xs text-ws-muted-fg"
              data-testid="connection-personal"
            >
              <Switch
                size="sm"
                checked={connection.ownership === 'person'}
                disabled={busy !== undefined}
                aria-label={t('connections.personal')}
                onCheckedChange={(v) => {
                  onPersonal(v)
                }}
              />
              {t('connections.personal')}
              <Hint text={t('connections.personal.hint')} />
            </span>
          )}
          {/* WP252：「请重新连接」那一行没有可测的东西，「断开」也只是收起提醒 */}
          {reconnect ? null : (
            <Button size="sm" variant="secondary" onClick={onTest} disabled={busy !== undefined}>
              <RefreshCw aria-hidden />
              {busy === 'test' ? t('connections.testing') : t('connections.test')}
            </Button>
          )}
          {/* 断开是危险操作：红字弱按钮（点了要确认）；「请重新连接」那一行只是收起提醒，次按钮 */}
          <Button
            size="sm"
            variant={reconnect ? 'secondary' : 'ghost'}
            className={reconnect ? undefined : 'text-ws-bad hover:text-ws-bad'}
            onClick={onDisconnect}
            disabled={busy !== undefined}
          >
            {reconnect ? null : <Link2Off aria-hidden />}
            {reconnect ? t('connections.brand_conflict.dismiss') : t('connections.disconnect')}
          </Button>
        </div>
      </div>
      {connection.legacy === undefined ? null : (
        <p
          className="ws-notice items-start text-xs"
          data-wrap="true"
          data-tone="warn"
          data-testid="connection-legacy"
          data-legacy-kind={connection.legacy.kind}
          data-slot="warning"
        >
          <AlertTriangle className="ws-notice-icon mt-0.5" aria-hidden />
          <span className="ws-notice-text">
            <strong className="font-medium">{t('connections.legacy')}</strong>
            <span aria-hidden>：</span>
            {connection.legacy.hint}
          </span>
        </p>
      )}
      {connection.brand_conflict === undefined ? null : (
        <p
          className="ws-notice items-start text-xs"
          data-wrap="true"
          data-tone="warn"
          data-testid="connection-brand-conflict"
          data-kind={connection.brand_conflict.kind}
          data-slot="warning"
        >
          <AlertTriangle className="ws-notice-icon mt-0.5" aria-hidden />
          <span className="ws-notice-text">
            <strong className="font-medium">
              {t(`connections.brand_conflict.${connection.brand_conflict.kind}`)}
            </strong>
            <span aria-hidden>：</span>
            {connection.brand_conflict.hint}
          </span>
        </p>
      )}
      {/*
        没通：原因一直摆着（要人动手）。通了：只在刚按过「测试」的两分钟里给一句回音，
        之后不再占一行（状态徽章已经说了）。
      */}
      {connection.last_test === undefined ||
      (connection.last_test.ok && !justTested(connection.last_tested_at)) ? null : (
        <TestResultLine result={connection.last_test} />
      )}
      {/* WP167：邮箱卡上的三个开关（影子模式 / 挪进 KefuAgents / 标已读）+ 只读的「接管」 */}
      {connection.service === 'imap_smtp' ? (
        <MailboxSwitches connectionId={connection.id} assignment={assignment} />
      ) : null}
    </li>
  )
}

/** WP214：这条连接的四态——在测 = 测试中；不正常或上次没测通 = 不通；测试不支持 = 没测；否则通。 */
function connectionState(connection: ConnectionView, testing: boolean): StatusState {
  if (testing) return 'pending'
  if (connection.status !== 'active') return 'fail'
  const last = connection.last_test
  if (last === undefined) return 'ok'
  if (last.ok) return 'ok'
  return last.reason === 'test_unavailable' ? 'unknown' : 'fail'
}

/** 刚测过（两分钟内）：按完「测试」要有一句回音。 */
function justTested(at: string | undefined): boolean {
  if (at === undefined) return false
  const ms = Date.parse(at)
  return Number.isFinite(ms) && Date.now() - ms < 120_000
}
