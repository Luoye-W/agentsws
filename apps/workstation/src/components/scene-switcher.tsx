/**
 * WP136（docs/79）：左下角账户块**上方**那一行「场景」。
 *
 * Luoye 09-24 定：dsh 的 Profile 就是「不同的工作场景」。Agents 工坊只做跨境电商 / 出海营销，
 * 是 dsh 里的**一个**场景；想编程、做别的事，切到 dsh 官方的场景（或自己建的）——不用另装 dsh。
 * 其他场景不是我们做的，我们只给入口：每一行下面那句「由 DeepSeek 官方维护，Agents 工坊不对它负责」
 * 就是这条边界说给人听的样子。
 *
 * 36 §10 减字：左栏这一行只有一个图标 + 两个字；点开是一张朝上的小面板（和账户块同一种朴素下拉）。
 * 只有所有者看得到它——起停场景是「这台电脑怎么配」，与浏览器设置同一档权限。
 * 托盘「管理场景…」打开的是 `/?scenes=1`，这里看到那个参数就自己展开一次。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AppWindow,
  Check,
  ExternalLink,
  Layers,
  Plus,
  RotateCw,
  Square,
  Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { InfoTip, StatusIcons, type StatusState, WsTag } from '@/components/design'
import { TutorialLink } from '@/components/help/tutorial-link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import {
  createDshScene,
  type DshSceneRow,
  deleteDshScene,
  getDshScenes,
  getPositions,
  launchOfficialDesktop,
  openDshScene,
  restartDshScene,
  stopDshScene,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** WP214：场景运行状态 → 四态。 */
const SCENE_STATE: Record<DshSceneRow['state'], StatusState> = {
  running: 'ok',
  starting: 'pending',
  failed: 'fail',
  stopped: 'unknown',
}

/** 桌面壳的桥里场景用得着的那几样（形状同 `@agentsws/desktop/bridge` 的 `DesktopBridge`）。 */
interface SceneBridge {
  openExternal(url: string): Promise<boolean>
  /** WP184：新一点的壳才有——壳自己去拿网址、开在它自己的窗口里（网址不进页面）。 */
  openScene?(
    name: string,
    options?: { restart?: boolean },
  ): Promise<{ ok: true; where: 'window' | 'browser' } | { ok: false; reason: string }>
}

/** 桌面壳的桥（只在运行时看一眼 `window.agentsws` 在不在；工作台不依赖桌面壳这个包）。 */
function bridge(): SceneBridge | undefined {
  const w = globalThis.window as unknown as { agentsws?: SceneBridge } | undefined
  return w?.agentsws
}

/**
 * 把带 token 的网址交出去。桌面壳里走桥（系统浏览器）；普通浏览器里用**点击那一刻**先开好的空标签页
 * （等接口回来再 `window.open` 会被弹窗拦截挡掉）。
 */
function handOff(url: string, pending: Window | null): void {
  const native = bridge()
  if (native !== undefined) {
    pending?.close()
    void native.openExternal(url)
    return
  }
  if (pending !== null) {
    pending.opener = null
    pending.location.href = url
  } else globalThis.window?.open(url, '_blank', 'noopener')
}

/** 桌面壳里不预开标签页（`setWindowOpenHandler` 会拒 `about:blank`），普通浏览器里预开一个。 */
function preOpen(): Window | null {
  if (bridge() !== undefined) return null
  return globalThis.window?.open('about:blank', '_blank') ?? null
}

export function SceneSwitcher(): React.ReactNode {
  const { t } = useApp()
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newTemplate, setNewTemplate] = useState('web')
  const [deleting, setDeleting] = useState<string | undefined>()
  const [confirmText, setConfirmText] = useState('')
  const [message, setMessage] = useState<string | undefined>()

  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions, retry: false })
  const owner = (positions.data?.positions ?? []).find((p) => p.role_id === 'common.owner')
  const assignment = owner?.position_id

  const scenes = useQuery({
    queryKey: ['dsh-scenes', assignment],
    enabled: assignment !== undefined,
    queryFn: () => getDshScenes(assignment),
    retry: false,
    // 面板开着时跟一下「启动中 → 运行中」
    refetchInterval: open ? 3000 : false,
  })

  // 托盘「管理场景…」→ `/?scenes=1`：展开一次，再把参数拿掉（刷新不会一直弹）
  useEffect(() => {
    if (params.get('scenes') !== '1') return
    setOpen(true)
    const next = new URLSearchParams(params)
    next.delete('scenes')
    setParams(next, { replace: true })
  }, [params, setParams])

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['dsh-scenes'] })
  }
  const fail = (err: unknown): void => {
    setMessage(t('scenes.error', { message: err instanceof Error ? err.message : String(err) }))
    refresh()
  }

  const openScene = useMutation({
    mutationFn: async (input: {
      name: string
      restart: boolean
      pending: Window | null
    }): Promise<{ name: string; where: 'window' | 'browser' }> => {
      // WP184：新壳自己开窗（体验接近官方桌面端），网址不经过这个页面
      const native = bridge()?.openScene
      if (native !== undefined) {
        const out = await native(input.name, { restart: input.restart })
        if (!out.ok) throw new Error(out.reason)
        return { name: input.name, where: out.where }
      }
      try {
        const res = input.restart
          ? await restartDshScene(input.name, assignment)
          : await openDshScene(input.name, assignment)
        handOff(res.url, input.pending)
        return { name: res.scene.name, where: 'browser' }
      } catch (err) {
        input.pending?.close()
        throw err
      }
    },
    onSuccess: (res) => {
      setMessage(
        t(res.where === 'window' ? 'scenes.opened.window' : 'scenes.opened', { name: res.name }),
      )
      refresh()
    },
    onError: fail,
  })
  const launchDesktop = useMutation({
    mutationFn: () => launchOfficialDesktop(assignment),
    onSuccess: () => {
      setMessage(t('scenes.officialDesktop.opened'))
    },
    onError: fail,
  })
  const stopScene = useMutation({
    mutationFn: (name: string) => stopDshScene(name, assignment),
    onSuccess: refresh,
    onError: fail,
  })
  const create = useMutation({
    mutationFn: () => createDshScene({ name: newName.trim(), template: newTemplate }, assignment),
    onSuccess: () => {
      setCreating(false)
      setNewName('')
      setMessage(undefined)
      refresh()
    },
    onError: fail,
  })
  const remove = useMutation({
    mutationFn: (name: string) => deleteDshScene(name, confirmText.trim(), assignment),
    onSuccess: () => {
      setDeleting(undefined)
      setConfirmText('')
      setMessage(undefined)
      refresh()
    },
    onError: fail,
  })

  // 只有所有者看得到；服务说这台部署切不了场景（托管 / 公司服务器）也不占左栏那一行
  // 问不到（旧服务进程没有这条路由、没权限）同样不出——不摆一个点开是空的入口
  if (assignment === undefined) return null
  const data = scenes.data
  if (data?.available !== true) return null

  const rows = data?.scenes ?? []
  const launchable = rows.filter((s) => s.launchable)
  const cli = rows.filter((s) => !s.launchable)
  const running = launchable.filter((s) => s.origin !== 'agentsws' && s.state === 'running').length
  const desktop = data?.official_desktop

  return (
    <div className="relative" data-testid="scene-switcher">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t('scenes.title')}
        data-testid="scene-toggle"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ws-muted-fg hover:bg-sidebar-accent/60"
        onClick={() => {
          setOpen(!open)
        }}
      >
        <Layers aria-hidden className="size-4 shrink-0" />
        <span className="flex-1 truncate">{t('scenes.entry')}</span>
        {running > 0 ? (
          <span className="ws-num text-[11px] text-ws-good" data-testid="scene-running-count">
            {running}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t('scenes.title')}
          data-testid="scene-panel"
          className="absolute bottom-full left-0 z-50 mb-1 w-80 rounded-md border bg-popover p-2 shadow-md"
        >
          <p className="px-1 text-sm font-medium">{t('scenes.title')}</p>
          <p className="px-1 pb-2 text-xs text-muted-foreground">
            {t('scenes.hint')} <TutorialLink slug="dsh-scenes" className="align-middle" />
          </p>
          {/*
            WP214：「这个场景不归 Agents 工坊负责」原来每一行底下说一遍；同一信息只出现一次——
            列表上面说一句，每行「官方 / 自建」标签的 tooltip 里是那一行的原话
          */}
          {launchable.some((s) => s.origin !== 'agentsws') ? (
            <p className="px-1 pb-1.5 text-[11px] text-muted-foreground" data-testid="scene-notice">
              {t('scenes.notice.once')}
            </p>
          ) : null}
          <ul className="flex flex-col gap-1">
            {launchable.map((s) => (
              <SceneRow
                key={s.name}
                scene={s}
                busy={openScene.isPending || stopScene.isPending}
                onOpen={(restart) => {
                  setMessage(undefined)
                  openScene.mutate({ name: s.name, restart, pending: preOpen() })
                }}
                onStop={() => {
                  stopScene.mutate(s.name)
                }}
                onDelete={() => {
                  setDeleting(deleting === s.name ? undefined : s.name)
                  setConfirmText('')
                }}
              />
            ))}
            {desktop === undefined ? null : (
              <li
                className="flex flex-col gap-1 rounded-md px-1 py-1.5 hover:bg-accent/50"
                data-testid="scene-official-desktop"
                title={desktop.app_path}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {t('scenes.officialDesktop')}
                  </span>
                  <WsTag>{t('scenes.officialDesktop.tag')}</WsTag>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t('scenes.officialDesktop.note')}
                </p>
                <div className="flex flex-wrap gap-1">
                  <SmallAction
                    icon={AppWindow}
                    label={t('scenes.open')}
                    disabled={launchDesktop.isPending}
                    onClick={() => {
                      setMessage(undefined)
                      launchDesktop.mutate()
                    }}
                    testid="scene-open-official-desktop"
                  />
                </div>
              </li>
            )}
          </ul>
          {deleting === undefined ? null : (
            <div
              className="mt-2 flex flex-col gap-1.5 rounded-md bg-ws-bad-bg p-2"
              data-testid="scene-delete"
            >
              <p className="text-xs text-ws-bad">
                {t('scenes.delete.confirm', { name: deleting })}
              </p>
              <Input
                aria-label={t('scenes.delete.confirm', { name: deleting })}
                value={confirmText}
                onChange={(e) => {
                  setConfirmText(e.target.value)
                }}
                className="h-8"
              />
              <p className="text-[11px] text-muted-foreground">{t('scenes.delete.note')}</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={confirmText.trim() !== deleting || remove.isPending}
                  onClick={() => {
                    remove.mutate(deleting)
                  }}
                >
                  {t('scenes.delete.go')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDeleting(undefined)
                  }}
                >
                  {t('scenes.cancel')}
                </Button>
              </div>
            </div>
          )}
          {cli.length === 0 ? null : (
            <p className="mt-2 px-1 text-[11px] text-muted-foreground" data-testid="scene-cli">
              {t('scenes.cli', { names: cli.map((s) => s.name).join('、') })}
            </p>
          )}
          <Separator className="my-2" />
          {creating ? (
            <form
              className="flex flex-col gap-1.5"
              data-testid="scene-new-form"
              onSubmit={(e) => {
                e.preventDefault()
                create.mutate()
              }}
            >
              <Input
                aria-label={t('scenes.new.name')}
                placeholder={t('scenes.new.name')}
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value)
                }}
                className="h-8"
              />
              <select
                aria-label={t('scenes.new.template')}
                value={newTemplate}
                onChange={(e) => {
                  setNewTemplate(e.target.value)
                }}
                className="h-8 rounded-md border bg-transparent px-2 text-sm"
              >
                {(data?.templates ?? []).map((tpl) => (
                  <option key={tpl.name} value={tpl.name}>
                    {tpl.name}
                    {tpl.surface === 'cli' ? t('scenes.new.cli') : ''}
                  </option>
                ))}
              </select>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  type="submit"
                  disabled={newName.trim() === '' || create.isPending}
                >
                  {t('scenes.new.go')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    setCreating(false)
                  }}
                >
                  {t('scenes.cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              data-testid="scene-new"
              className="flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left text-sm hover:bg-accent"
              onClick={() => {
                setCreating(true)
              }}
            >
              <Plus aria-hidden className="size-4" />
              {t('scenes.new')}
            </button>
          )}
          {message === undefined ? null : (
            <p className="mt-2 px-1 text-xs text-muted-foreground" data-testid="scene-message">
              {message}
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}

function SceneRow({
  scene,
  busy,
  onOpen,
  onStop,
  onDelete,
}: {
  scene: DshSceneRow
  busy: boolean
  onOpen: (restart: boolean) => void
  onStop: () => void
  onDelete: () => void
}): React.ReactNode {
  const { t } = useApp()
  const ours = scene.origin === 'agentsws'
  const live = scene.state === 'running' || scene.state === 'starting'
  return (
    <li
      className="flex flex-col gap-1 rounded-md px-1 py-1.5 hover:bg-accent/50"
      data-testid={`scene-row-${scene.name}`}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {ours ? t('scenes.agentsws') : scene.name}
        </span>
        {ours ? (
          <span className="flex items-center gap-1 text-xs text-ws-brand">
            <Check aria-hidden className="size-3.5" />
            {t('scenes.current')}
          </span>
        ) : (
          <>
            {/*
              WP214（36 §7 第四档）：「官方 / 自建」标签的 tooltip 里是那句边界（谁维护、我们不负责）；
              运行状态是一个小图标（运行中 = 通、启动中 = 进行中、没起来 = 不通、关着 = 没测），状态词进 tooltip
            */}
            <InfoTip
              text={t(scene.origin === 'custom' ? 'scenes.notice.custom' : 'scenes.notice')}
              testId={`scene-origin-${scene.name}`}
            >
              <WsTag>{t(`scenes.origin.${scene.origin}`)}</WsTag>
            </InfoTip>
            <StatusIcons
              testId={`scene-state-${scene.name}`}
              items={[
                {
                  key: scene.state,
                  label: scene.name,
                  state: SCENE_STATE[scene.state],
                  stateText: t(`scenes.state.${scene.state}`),
                  icon: AppWindow,
                },
              ]}
            />
          </>
        )}
      </div>
      {ours ? null : (
        <>
          {scene.error === undefined ? null : (
            <p className="text-[11px] text-ws-bad">{scene.error}</p>
          )}
          <div className="flex flex-wrap gap-1">
            <SmallAction
              icon={ExternalLink}
              label={t('scenes.open')}
              disabled={busy}
              onClick={() => onOpen(false)}
              testid={`scene-open-${scene.name}`}
            />
            {live ? (
              <>
                <SmallAction
                  icon={RotateCw}
                  label={t('scenes.restart')}
                  disabled={busy}
                  onClick={() => onOpen(true)}
                  testid={`scene-restart-${scene.name}`}
                />
                <SmallAction
                  icon={Square}
                  label={t('scenes.stop')}
                  disabled={busy}
                  onClick={onStop}
                  testid={`scene-stop-${scene.name}`}
                />
              </>
            ) : null}
            {scene.deletable ? (
              <SmallAction
                icon={Trash2}
                label={t('scenes.delete')}
                disabled={busy}
                onClick={onDelete}
                testid={`scene-delete-${scene.name}`}
                danger
              />
            ) : null}
          </div>
        </>
      )}
    </li>
  )
}

function SmallAction({
  icon: Icon,
  label,
  onClick,
  disabled,
  testid,
  danger,
}: {
  icon: typeof ExternalLink
  label: string
  onClick: () => void
  disabled: boolean
  testid: string
  danger?: boolean
}): React.ReactNode {
  return (
    <button
      type="button"
      data-testid={testid}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs hover:bg-accent disabled:opacity-50',
        danger === true ? 'text-ws-bad' : 'text-ws-body',
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {label}
    </button>
  )
}
