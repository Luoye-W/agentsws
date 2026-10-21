/**
 * WP432（Luoye 10-20 反馈 9）：**「插件要重新加载一下」**就地提示卡。
 *
 * 已解压的插件只在 Chrome 重启或手动「重新加载」时才读新文件——10-20 Windows 上那个插件一直停在旧版（没有侧边栏），
 * 点了没反应。新版插件会自己跟着工坊更新（配没配对都会问），但**旧版插件得人点一次重新加载**，之后才接得上。
 *
 * 只在这两种时候出（配好了自己消失）：
 * - 浏览器里的插件这几分钟报的版本跟工坊带的不一样；
 * - 有东西等你在插件里发，可这几分钟没看到插件来过（`unseen`，只在调用方说「有东西在等」时出）。
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { Puzzle, RotateCw } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { type ExtensionInstallView, getExtensionInstall, openExtensionInstall } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 插件多久没来报版本就当「没看到」（插件每分钟报一次）。 */
export const EXT_FRESH_MS = 10 * 60 * 1000

export type ReloadNeed =
  | { kind: 'stale'; running: string; folder: string }
  | { kind: 'unseen'; folder: string }

/** 要不要提示重新加载（纯函数，测试直接钉）。不是桌面版（没有固定文件夹）→ 不提示。 */
export function reloadNeed(
  view: Pick<ExtensionInstallView, 'folder_version' | 'running' | 'unpaired'> | undefined,
  nowMs: number,
): ReloadNeed | undefined {
  const folder = view?.folder_version
  if (view === undefined || folder === undefined) return undefined
  const fresh = [...view.running, ...(view.unpaired === undefined ? [] : [view.unpaired])].filter(
    (r) => nowMs - Date.parse(r.at) < EXT_FRESH_MS,
  )
  if (fresh.some((r) => r.version === folder)) return undefined
  const old = fresh.find((r) => r.version !== folder)
  if (old !== undefined) return { kind: 'stale', running: old.version, folder }
  return { kind: 'unseen', folder }
}

const copy = (text: string): Promise<boolean> =>
  (globalThis.navigator?.clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard')))
    .then(() => true)
    .catch(() => false)

export function ExtensionReloadPrompt(props: {
  assignment?: string | undefined
  /** 有东西在等你在插件里发：这几分钟没看到插件也提示。 */
  waiting?: boolean
}): ReactNode {
  const { t } = useApp()
  const [note, setNote] = useState<string | undefined>(undefined)
  const view = useQuery({
    queryKey: ['extension-install', props.assignment],
    queryFn: () => getExtensionInstall(props.assignment),
    retry: false,
    refetchInterval: 15_000,
  })
  const open = useMutation({
    mutationFn: () => openExtensionInstall('chrome', props.assignment),
    onSuccess: (out) => {
      if (!out.opened && out.message !== undefined) setNote(out.message)
      else setNote(t('extreload.copied'))
    },
  })
  const need = reloadNeed(view.data, Date.now())
  if (need === undefined || (need.kind === 'unseen' && props.waiting !== true)) return null
  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg bg-ws-warn-bg px-3 py-2 text-sm"
      data-testid="extension-reload"
      data-kind={need.kind}
      data-slot="status"
    >
      <span className="flex items-center gap-1.5 font-medium text-ws-warn">
        <RotateCw className="size-4 shrink-0" aria-hidden />
        {t('extreload.title')}
      </span>
      <span className="text-ws-body">
        {need.kind === 'stale'
          ? t('extreload.stale', { running: need.running, folder: need.folder })
          : t('extreload.unseen')}{' '}
        {t('extreload.steps')}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          className="gap-1"
          data-testid="extension-reload-copy"
          onClick={() => {
            void copy('chrome://extensions').then((ok) => {
              if (ok) setNote(t('extreload.copied'))
            })
          }}
        >
          {t('extreload.copy')}
        </Button>
        {view.data?.can_open === true ? (
          <Button
            size="xs"
            variant="outline"
            className="gap-1"
            disabled={open.isPending}
            data-testid="extension-reload-chrome"
            onClick={() => {
              void copy('chrome://extensions')
              open.mutate()
            }}
          >
            <Puzzle className="size-3.5" aria-hidden />
            {t('extinstall.chrome')}
          </Button>
        ) : null}
        {note === undefined ? null : <span className="text-xs text-ws-muted-fg">{note}</span>}
      </div>
    </div>
  )
}
