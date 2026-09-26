/**
 * 连接页「数据后端」三档底下那一格：**在线值守（agentsws 托管）**（48 L7、41 §2.4）。
 *
 * 五步，按顺序亮，做完一步下一步才可点——不是因为技术上做不到跳步，
 * 而是因为**每一步都不可撤销一半**：账号没关联就没有余额可看，余额没看就不知道
 * 这个月要花多少，包没导出来就没有东西传，传完才谈得上把桌面切过去。
 *
 * | 步 | 干什么 | 打哪一条 |
 * |---|---|---|
 * | ① 关联账号 | 没关联就跳"账号与积分"那个 tab | `GET /v1/standby` 的 `linked` |
 * | ② 看余额与月费 | 座位数 × 座位单价 = 这个月多少积分 | `GET /v1/cloud/credits` + `seat_price` |
 * | ③④ 搬上去 | 本地导出 → 上传 → 开通 → 云上起进程 | `POST /v1/standby/switch` |
 * | ⑤ 切远程 | 桌面壳指到 `https://<云>/w/<ws>` | 回执里的 `remote_url` |
 *
 * 反向"接回本机"在同一格底下，不藏在别处：41 §2.3 三条纪律第一条是
 * **随时搬家**——一个只能进不能出的入口，说多少遍"不锁定"都没用。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CloudUpload, Copy, Loader2, Server, Wifi } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  bringStandbyHome,
  getCloudCredits,
  getStandby,
  type StandbyView,
  switchToStandby,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 值守跑起来之后每 10 秒问一次状态（`starting` → `running` 要几秒）。 */
const POLL_MS = 10_000

function statusKey(status: string | undefined): string {
  switch (status) {
    case 'running':
      return 'standby.status.running'
    case 'starting':
      return 'standby.status.starting'
    case 'expired':
      return 'standby.status.expired'
    case 'stopped':
      return 'standby.status.stopped'
    default:
      return 'standby.status.off'
  }
}

export function StandbyWizard({
  assignment,
  onGoToAccount,
}: {
  assignment?: string
  /** 没关联账号时点"去关联"跳哪儿（WP58 的账号 tab）。 */
  onGoToAccount?: () => void
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [seats, setSeats] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [broughtHome, setBroughtHome] = useState<string | null>(null)

  const standby = useQuery({
    queryKey: ['standby', assignment],
    enabled: assignment !== undefined,
    queryFn: () => getStandby(assignment),
    // 正在起的时候多问几次；跑起来了就不用了
    refetchInterval: (query) =>
      (query.state.data as StandbyView | undefined)?.cloud?.status === 'starting' ? POLL_MS : false,
  })

  const credits = useQuery({
    queryKey: ['cloud-credits', assignment],
    enabled: assignment !== undefined && standby.data?.linked === true,
    queryFn: () => getCloudCredits(assignment),
  })

  const invalidate = (): void => {
    void client.invalidateQueries({ queryKey: ['standby'] })
    void client.invalidateQueries({ queryKey: ['cloud-credits'] })
  }

  const start = useMutation({
    mutationFn: () => switchToStandby({ seats }, assignment),
    onSuccess: () => {
      setError(null)
      invalidate()
    },
    onError: (e: Error) => {
      setError(e.message)
    },
  })

  const home = useMutation({
    mutationFn: () => bringStandbyHome(assignment),
    onSuccess: (out) => {
      setError(null)
      setBroughtHome(out.next)
      invalidate()
    },
    onError: (e: Error) => {
      setError(e.message)
    },
  })

  if (standby.isLoading) return <Skeleton className="mt-3 h-24 w-full" />

  const view = standby.data
  const linked = view?.linked === true
  const cloud = view?.cloud
  const live = cloud !== undefined && cloud.status !== 'expired' && cloud.status !== 'stopped'
  const price = view?.seat_price
  const monthly = price === undefined ? undefined : Math.round(price * seats * 10_000) / 10_000
  const available = credits.data?.balance?.available

  return (
    <div className="mt-3 rounded-lg border bg-muted/20 p-3 text-xs" data-testid="storage-standby">
      <p className="flex items-center gap-1 font-medium">
        <Wifi className="size-3.5" aria-hidden />
        {t('standby.title')}
        <Hint text={`${t('standby.note.hint')} ${t('standby.more.hint')}`} />
      </p>
      <p className="mt-1 text-muted-foreground">{t('standby.note')}</p>

      {/* ① 关联账号 */}
      {linked ? null : (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="standby-step-link">
          <span className="text-muted-foreground">{view?.reason ?? t('standby.not_linked')}</span>
          <Button type="button" size="sm" variant="outline" onClick={onGoToAccount}>
            {t('standby.go_link')}
          </Button>
        </div>
      )}

      {/* ②③④ 座位、月费、开通 */}
      {linked && !live ? (
        <div className="mt-3 space-y-2" data-testid="standby-step-open">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label htmlFor="standby-seats" className="text-[11px] text-muted-foreground">
                {t('standby.seats')}
              </Label>
              <Input
                id="standby-seats"
                type="number"
                min={1}
                max={500}
                value={seats}
                className="mt-1 h-8 w-20"
                onChange={(e) => {
                  const next = Number(e.target.value)
                  setSeats(Number.isFinite(next) && next >= 1 ? Math.trunc(next) : 1)
                }}
              />
            </div>
            <dl className="text-[11px]" data-slot="data">
              <dt className="text-muted-foreground">{t('standby.monthly')}</dt>
              <dd className="font-medium" data-testid="standby-monthly">
                {monthly === undefined ? '—' : t('standby.credits', { n: monthly })}
              </dd>
            </dl>
            <dl className="text-[11px]" data-slot="data">
              <dt className="text-muted-foreground">{t('standby.balance')}</dt>
              <dd className="font-medium" data-testid="standby-balance">
                {available === undefined ? '—' : t('standby.credits', { n: available })}
              </dd>
            </dl>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              data-testid="standby-start"
              disabled={start.isPending}
              onClick={() => {
                start.mutate()
              }}
            >
              {start.isPending ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />
              ) : (
                <CloudUpload className="mr-1.5 size-3.5" aria-hidden />
              )}
              {start.isPending ? t('standby.starting') : t('standby.start')}
            </Button>
            {/* WP157：「点一下会做哪三件事」进问号 */}
            <Hint text={t('standby.steps')} testId="standby-steps" />
          </div>
        </div>
      ) : null}

      {/* 跑起来之后：状态、嵌入脚本、接回本机 */}
      {cloud === undefined ? null : (
        <div className="mt-3 space-y-2" data-testid="standby-running">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">{t('standby.status')}</dt>
              <dd className="mt-0.5 font-medium" data-testid="standby-status">
                {t(statusKey(cloud.status))}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('standby.seats')}</dt>
              <dd className="mt-0.5 font-medium">{cloud.seats}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('standby.period_end')}</dt>
              <dd className="mt-0.5 font-medium">{cloud.period_end.slice(0, 10)}</dd>
            </div>
          </dl>

          {view?.embed_snippet === undefined ? null : (
            <div>
              <p className="text-muted-foreground">
                {t('standby.embed')}
                <Hint text={t('standby.embed.hint')} />
              </p>
              <div className="mt-1 flex items-center gap-2">
                <code
                  className="flex-1 overflow-x-auto rounded border bg-background px-2 py-1 font-mono text-[11px]"
                  data-testid="standby-embed"
                >
                  {view.embed_snippet}
                </code>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard?.writeText(view.embed_snippet ?? '')
                    setCopied(true)
                  }}
                >
                  <Copy className="mr-1.5 size-3.5" aria-hidden />
                  {copied ? t('standby.copied') : t('standby.copy')}
                </Button>
              </div>
            </div>
          )}

          <p className="flex items-center gap-1 text-muted-foreground">
            <Server className="size-3.5" aria-hidden />
            {view?.remote === true
              ? t('standby.desktop.remote', { url: view.remote_url ?? '' })
              : t('standby.desktop.todo', { url: view?.remote_url ?? '' })}
          </p>

          {/* 41 §2.3 第一条纪律：随时搬家。出口与入口放在同一格里 */}
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="standby-bring-home"
            disabled={home.isPending}
            onClick={() => {
              home.mutate()
            }}
          >
            {home.isPending ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />
            ) : null}
            {t('standby.bring_home')}
          </Button>
          {broughtHome === null ? null : (
            <p className="text-muted-foreground" data-testid="standby-brought-home">
              {broughtHome}
            </p>
          )}
        </div>
      )}

      {error === null ? null : (
        <p className="mt-2 text-destructive" data-testid="standby-error">
          {error}
        </p>
      )}
    </div>
  )
}
