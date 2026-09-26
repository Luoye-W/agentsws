/**
 * 设置 → 账号与积分里的**红人营销增值服务**那一张（67 §3，WP118）。
 *
 * 它卖的不是备份，是"红人营销以后不依赖本地这台机器也能跑起来"的地基：本地一份、
 * 云端一份，双向同步。所以这一张上要说清楚四件事，一件都不能含糊：
 *
 * 1. **现在是什么状态**（没开通 / 生效中 / 欠费暂停 / 已点取消）——欠费那一档必须
 *    同时说"数据一条没动"，否则用户第一反应是"我的红人库没了"；
 * 2. **同步到哪儿了**（云端多少条、本地还攒着几条、最近一次什么时候）；
 * 3. **有没有撞车**（两头都改过同一条）。撞了不静默挑一个：两个版本都摊开，
 *    让用户自己挑，输的那一份也不删；
 * 4. **数据是他的**（导出云端这一份 / 删掉云端这一份）。删除那一步要再问一次，
 *    并且当场说清"本地这一份不动"。
 *
 * 两条纪律（与红人岗位那一组逐字相同，WP117 断点 #5–#8）：
 * - **不吞错**：每一个动作都有回执或 `role="alert"`，失败了说人话；
 * - **失败不清空输入**：这一张上没有输入框，但"删掉云端这一份"的二次确认
 *   在失败之后留在原地，不弹回去让用户重点一遍。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CloudOff, Download, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import type { KolCloudStatusView } from '@/lib/api'
import {
  cancelKolCloud,
  deleteKolCloud,
  exportKolCloud,
  getKolCloudStatus,
  resolveKolCloudConflict,
  subscribeKolCloud,
  syncKolCloud,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 一句人话：动作失败时界面上显示的那一行。 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function KolCloudCard({
  assignment,
  onLinkFirst,
}: {
  /** 本页可能没有绑分配（设置页在个人档下），那就用 api 层的 currentAssignment 兑底。 */
  assignment?: string | undefined
  /** WP142：没关联时「订阅」换成「先关联」，点了去关联那张卡。不给就只说一句。 */
  onLinkFirst?: (() => void) | undefined
}): React.ReactNode {
  const { t } = useApp()
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [openConflicts, setOpenConflicts] = useState(false)

  const status = useQuery({
    queryKey: ['kol-cloud-status', assignment],
    queryFn: () => getKolCloudStatus(assignment),
    retry: false,
  })
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['kol-cloud-status', assignment] })
  }

  const subscribe = useMutation({
    mutationFn: () => subscribeKolCloud(assignment),
    onSuccess: () => {
      setNote(t('kol_cloud.subscribed'))
      refresh()
    },
  })
  const cancel = useMutation({
    mutationFn: () => cancelKolCloud(assignment),
    onSuccess: () => {
      setNote(t('kol_cloud.cancelled'))
      refresh()
    },
  })
  const sync = useMutation({
    mutationFn: () => syncKolCloud(assignment),
    /*
     * 同步这一趟**失败也是 200**：回执里 `ok: false` + 一句人话（没订阅 / 欠费 /
     * 云连不上）。所以"成功回调"里还要再分一次叉——那不是我们的错，但用户要看得见。
     */
    onSuccess: (run) => {
      const skipped =
        run.skipped > 0 ? ` ${t('kol_cloud.run_skipped', { n: String(run.skipped) })}` : ''
      setNote(
        run.ok
          ? `${t('kol_cloud.run_ok', { pushed: String(run.pushed), pulled: String(run.pulled) })}${skipped}`
          : (run.message ?? t('kol_cloud.run_failed')),
      )
      refresh()
    },
  })
  const resolve = useMutation({
    mutationFn: (input: { kind: string; id: string; pick: 'winner' | 'loser' }) =>
      resolveKolCloudConflict(input, assignment),
    onSuccess: () => {
      setNote(t('kol_cloud.conflict_resolved'))
      refresh()
    },
  })
  const dump = useMutation({
    mutationFn: async () => {
      const got = await exportKolCloud(assignment)
      const blob = new Blob([JSON.stringify(got, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `agentsws-kol-cloud-${got.at.slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      return got
    },
    onSuccess: (got) => {
      setNote(t('kol_cloud.exported', { n: String(got.objects.length) }))
    },
  })
  const wipe = useMutation({
    mutationFn: () => deleteKolCloud(assignment),
    onSuccess: (got) => {
      setConfirming(false)
      setNote(t('kol_cloud.deleted', { n: String(got.deleted) }))
      refresh()
    },
  })

  if (status.isPending) return <Skeleton className="h-32 w-full" />

  const view: KolCloudStatusView | undefined = status.data
  const sub = view?.subscription
  const state = sub?.status ?? 'none'
  const conflicts = view?.conflicts ?? []
  const busy =
    subscribe.isPending || cancel.isPending || sync.isPending || wipe.isPending || dump.isPending
  /** 每一个动作的失败都在这里汇成一行（不吞错）。 */
  const failed =
    [subscribe, cancel, sync, resolve, dump, wipe].find((m) => m.isError)?.error ?? undefined

  return (
    <section
      className="flex flex-col gap-2 rounded-lg border p-2.5"
      data-slot="card"
      data-testid="kol-cloud-card"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="flex items-center gap-1 text-xs font-medium">
            {t('kol_cloud.title')}
            <Hint text={t('kol_cloud.hint')} />
          </h4>
          <p className="text-[11px] text-muted-foreground" data-slot="status">
            {t('kol_cloud.price')}
          </p>
        </div>
        <span
          data-slot="status"
          data-testid="kol-cloud-state"
          data-state={state}
          // 欠费与暂停是"要用户做点什么"，所以给颜色；生效中不用喊
          className={
            state === 'grace' || state === 'suspended'
              ? 'rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-400'
              : 'rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'
          }
        >
          {t(`kol_cloud.state.${state}`)}
        </span>
      </div>

      {/* 还没关联账号：这一项根本谈不上，一句人话 + 一个去处 */}
      {view?.linked === false ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p
            className="text-xs text-muted-foreground"
            data-slot="status"
            data-testid="kol-cloud-not-linked"
          >
            {view.reason ?? t('kol_cloud.not_linked')}
          </p>
          {onLinkFirst === undefined ? null : (
            <Button
              size="xs"
              variant="outline"
              data-testid="kol-cloud-link-first"
              onClick={onLinkFirst}
            >
              {t('credits.link_first')}
            </Button>
          )}
        </div>
      ) : (
        <>
          {/* 状态那一句：当期到哪天 / 宽限到哪天 / 数据一条没动 */}
          <p
            className="text-xs text-muted-foreground"
            data-slot="status"
            data-testid="kol-cloud-note"
          >
            {state === 'none'
              ? t('kol_cloud.none_note')
              : state === 'grace' || state === 'suspended'
                ? t('kol_cloud.unpaid_note', {
                    date: (sub?.grace_until ?? '').slice(0, 10),
                  })
                : state === 'cancelling'
                  ? t('kol_cloud.cancelling_note', {
                      date: (sub?.current_cycle_end ?? '').slice(0, 10),
                    })
                  : t('kol_cloud.active_note', {
                      date: (sub?.current_cycle_end ?? '').slice(0, 10),
                    })}
          </p>

          {/* 同步到哪儿了 */}
          {view?.cloud_reachable === false ? (
            <p
              className="flex items-center gap-1 text-xs text-muted-foreground"
              data-slot="status"
              data-testid="kol-cloud-unreachable"
            >
              <CloudOff className="size-3.5" aria-hidden />
              {view.reason ?? t('kol_cloud.unreachable')}
            </p>
          ) : (
            <p
              className="text-xs tabular-nums text-muted-foreground"
              data-slot="status"
              data-testid="kol-cloud-counts"
            >
              {t('kol_cloud.counts', {
                cloud: String(view?.object_count ?? 0),
                pending: String(view?.pending ?? 0),
              })}
              {' · '}
              {view?.last_sync_at === undefined
                ? t('kol_cloud.never_synced')
                : t('kol_cloud.last_sync', {
                    when: view.last_sync_at.slice(0, 16).replace('T', ' '),
                  })}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            {state === 'none' ? (
              <Button
                size="xs"
                disabled={busy}
                data-testid="kol-cloud-subscribe"
                onClick={() => {
                  setNote(undefined)
                  subscribe.mutate()
                }}
              >
                {t('kol_cloud.subscribe')}
              </Button>
            ) : (
              <>
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={busy}
                  data-testid="kol-cloud-sync"
                  onClick={() => {
                    setNote(undefined)
                    sync.mutate()
                  }}
                >
                  <RefreshCw className="size-3.5" aria-hidden />
                  {t('kol_cloud.sync_now')}
                </Button>
                {state === 'cancelling' ? null : (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    data-testid="kol-cloud-cancel"
                    onClick={() => {
                      setNote(undefined)
                      cancel.mutate()
                    }}
                  >
                    {t('kol_cloud.cancel')}
                  </Button>
                )}
              </>
            )}
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              data-testid="kol-cloud-export"
              onClick={() => {
                setNote(undefined)
                void dump.mutate()
              }}
            >
              <Download className="size-3.5" aria-hidden />
              {t('kol_cloud.export')}
            </Button>
            {confirming ? (
              <span className="flex items-center gap-1" data-testid="kol-cloud-delete-confirm">
                <span className="text-[11px] text-destructive">
                  {t('kol_cloud.delete_confirm', { n: String(view?.object_count ?? 0) })}
                </span>
                <Button
                  size="xs"
                  variant="destructive"
                  disabled={busy}
                  data-testid="kol-cloud-delete-yes"
                  onClick={() => {
                    wipe.mutate()
                  }}
                >
                  {t('kol_cloud.delete_yes')}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(false)
                  }}
                >
                  {t('kol_cloud.delete_no')}
                </Button>
              </span>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                data-testid="kol-cloud-delete"
                onClick={() => {
                  setNote(undefined)
                  setConfirming(true)
                }}
              >
                <Trash2 className="size-3.5" aria-hidden />
                {t('kol_cloud.delete')}
              </Button>
            )}
          </div>

          {/* 撞车了：两个版本都摊开，用户自己挑（输的那一份不删） */}
          {conflicts.length === 0 ? null : (
            <div className="flex flex-col gap-1" data-testid="kol-cloud-conflicts">
              <Button
                size="xs"
                variant="ghost"
                className="self-start text-amber-700 dark:text-amber-400"
                aria-expanded={openConflicts}
                data-testid="kol-cloud-conflicts-toggle"
                onClick={() => {
                  setOpenConflicts((v) => !v)
                }}
              >
                <TriangleAlert className="size-3.5" aria-hidden />
                {t('kol_cloud.conflicts', { n: String(conflicts.length) })}
              </Button>
              {openConflicts ? (
                <>
                  <p className="text-[11px] text-muted-foreground">
                    {t('kol_cloud.conflict_note')}
                  </p>
                  <ul className="flex flex-col gap-1">
                    {conflicts.map((c) => (
                      <li
                        key={`${c.kind}:${c.id}:${c.at}`}
                        className="flex flex-wrap items-center gap-1.5 rounded border p-1.5 text-xs"
                        data-testid="kol-cloud-conflict"
                        data-kind={c.kind}
                      >
                        <span className="font-medium">{c.label}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {t(`kol_cloud.kind.${c.kind}`)}
                        </span>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            resolve.mutate({ kind: c.kind, id: c.id, pick: 'winner' })
                          }}
                        >
                          {t('kol_cloud.conflict_keep')}
                        </Button>
                        <Button
                          size="xs"
                          variant="secondary"
                          disabled={busy}
                          data-testid="kol-cloud-conflict-pick"
                          onClick={() => {
                            resolve.mutate({ kind: c.kind, id: c.id, pick: 'loser' })
                          }}
                        >
                          {t('kol_cloud.conflict_pick')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          )}
        </>
      )}

      {/* 回执与错误：一个动作只出其中一行 */}
      {failed !== undefined ? (
        <p className="text-xs text-destructive" role="alert" data-testid="kol-cloud-error">
          {messageOf(failed)}
        </p>
      ) : note !== undefined ? (
        <p
          className="text-xs text-muted-foreground"
          role="status"
          data-testid="kol-cloud-note-line"
        >
          {note}
        </p>
      ) : null}
    </section>
  )
}
