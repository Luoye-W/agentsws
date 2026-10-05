/**
 * WP219（docs/90 §6.1）：「设置 → 通用」里的一行——**已审的内容更新：自动 / 每次问我**（默认每次问我），
 * 下面列这个品牌更新过或有新版的条目：状态图标 + 名字 + 版本，按钮「更新 / 查看改动 / 退回」。
 *
 * 说明进问号（36 §7 少字）；状态用图标（36 §7 第四档）：通道通 / 关着 / 出错，条目已更新 / 有新版 / 有冲突。
 * 失败的原因常显一句人话（那是状态，不是说明）。取不到（老服务进程没有这条路）就整行不出。
 */
import type { ContentItemStatus, ContentUpdateMode } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Package, RefreshCw, ShieldCheck } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { ContentDiffDialog } from '@/components/content-updates/content-diff-dialog'
import { StatusIcons, type StatusState } from '@/components/design/status-icons'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import {
  applyContentUpdate,
  CONTENT_UPDATES_KEY,
  type ContentUpdatesView,
  checkContentUpdates,
  getContentUpdates,
  rollbackContentUpdate,
  setContentUpdateMode,
} from '@/lib/content-updates'

const MODES: readonly ContentUpdateMode[] = ['ask', 'auto']

const CHANNEL_STATE: Record<ContentUpdatesView['state'], StatusState> = {
  ok: 'ok',
  error: 'fail',
  off: 'unknown',
  unknown: 'unknown',
}

const ITEM_STATE: Record<ContentItemStatus['state'], StatusState> = {
  current: 'ok',
  available: 'unknown',
  conflict: 'fail',
  needs_app_update: 'unknown',
}

export function ContentUpdatesSetting(): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const current = useQuery({
    queryKey: CONTENT_UPDATES_KEY,
    queryFn: getContentUpdates,
    retry: false,
  })
  const [diffOf, setDiffOf] = useState<string | undefined>(undefined)
  const done = (next: ContentUpdatesView): void => {
    client.setQueryData(CONTENT_UPDATES_KEY, next)
    void client.invalidateQueries({ queryKey: ['deck'] })
    void client.invalidateQueries({ queryKey: ['home'] })
  }
  const mode = useMutation({ mutationFn: setContentUpdateMode, onSuccess: done })
  const check = useMutation({ mutationFn: checkContentUpdates, onSuccess: done })
  const apply = useMutation({ mutationFn: applyContentUpdate, onSuccess: done })
  const rollback = useMutation({ mutationFn: rollbackContentUpdate, onSuccess: done })
  const v = current.data
  if (v === undefined) return null
  const busy = mode.isPending || check.isPending || apply.isPending || rollback.isPending
  const failure = [apply.error, rollback.error, check.error].find((e) => e != null)
  const checkedAt =
    v.last_checked_at === undefined
      ? t('content_updates.never_checked')
      : t('content_updates.checked_at', { at: new Date(v.last_checked_at).toLocaleString() })
  return (
    <div className="flex flex-col gap-2" data-testid="settings-content-updates">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1">
          {t('content_updates.title')}
          <Hint text={t('content_updates.hint')} />
          <StatusIcons
            testId="content-updates-channel"
            label={t('content_updates.title')}
            items={[
              {
                key: 'channel',
                label: t('content_updates.channel'),
                icon: ShieldCheck,
                state: CHANNEL_STATE[v.state],
                stateText: t(`content_updates.state.${v.state}`),
                detail: checkedAt,
              },
            ]}
          />
          {v.state === 'off' ? null : (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={t('content_updates.check')}
              data-testid="content-updates-check"
              disabled={busy}
              onClick={() => {
                check.mutate()
              }}
            >
              <RefreshCw className={check.isPending ? 'size-3.5 animate-spin' : 'size-3.5'} />
            </Button>
          )}
        </span>
        <fieldset
          className="inline-flex rounded-full border p-0.5 text-xs"
          aria-label={t('content_updates.title')}
          data-testid="content-updates-mode"
        >
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={m === v.mode}
              data-value={m}
              disabled={busy}
              className={
                m === v.mode
                  ? 'rounded-full bg-primary px-2.5 py-0.5 text-primary-foreground'
                  : 'rounded-full px-2.5 py-0.5 text-muted-foreground hover:text-foreground'
              }
              onClick={() => {
                if (m !== v.mode) mode.mutate(m)
              }}
            >
              {t(`content_updates.mode.${m}`)}
            </button>
          ))}
        </fieldset>
      </div>
      {v.state === 'error' && v.reason !== undefined ? (
        <p className="text-xs text-ws-bad" data-testid="content-updates-reason">
          {v.reason}
        </p>
      ) : null}
      {failure instanceof Error ? (
        <p className="text-xs text-ws-bad" data-testid="content-updates-failure">
          {failure.message}
        </p>
      ) : null}
      {v.items.length === 0 ? null : (
        <ul
          className="flex flex-col gap-1.5 rounded-lg border p-2"
          data-testid="content-updates-items"
        >
          {v.items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-2"
              data-testid="content-update-item"
              data-item={item.id}
              data-state={item.state}
            >
              <span className="flex min-w-0 items-center gap-2">
                <StatusIcons
                  testId="content-update-item-state"
                  items={[
                    {
                      key: item.id,
                      label: item.title[lang],
                      icon: Package,
                      state: ITEM_STATE[item.state],
                      stateText: t(`content_updates.item.${item.state}`),
                      ...(item.upstream_published_at === undefined
                        ? {}
                        : {
                            detail: t('content_updates.published', {
                              at: item.upstream_published_at,
                            }),
                          }),
                    },
                  ]}
                />
                <span className="truncate">{item.title[lang]}</span>
                <span
                  className="text-xs tabular-nums text-ws-muted-fg"
                  data-testid="content-update-version"
                >
                  {item.available_version === undefined
                    ? item.current_version
                    : `${item.current_version ?? '—'} → ${item.available_version}`}
                </span>
              </span>
              <span className="flex items-center gap-1">
                {item.state === 'available' ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    data-testid="content-update-apply"
                    onClick={() => {
                      apply.mutate(item.id)
                    }}
                  >
                    {t('content_updates.apply')}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="content-update-diff"
                  onClick={() => {
                    setDiffOf(item.id)
                  }}
                >
                  {t('content_updates.diff')}
                </Button>
                {item.updated_at === undefined ? null : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    data-testid="content-update-rollback"
                    title={t('content_updates.rollback.hint', {
                      version: item.previous_version ?? '',
                    })}
                    onClick={() => {
                      rollback.mutate(item.id)
                    }}
                  >
                    {t('content_updates.rollback')}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {diffOf === undefined ? null : (
        <ContentDiffDialog
          itemId={diffOf}
          open
          onOpenChange={(open) => {
            if (!open) setDiffOf(undefined)
          }}
        />
      )}
    </div>
  )
}
