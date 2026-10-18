/**
 * WP345（决策 871）：连接卡 / 连接页「浏览器插件」一节里**装插件**那一块。
 *
 * 插件不上架商店，随工坊带着：桌面版把它放在数据目录下一个固定文件夹里。用户只在第一次动一次手——
 * 一句话 + 「打开插件文件夹」「打开 Chrome 扩展页」两个按钮 + 一行小字（开发者模式 → 把选中的文件夹拖进扩展页；WP409）。
 * 之后插件跟着工坊自己更新，这一块就不出了（配上对之后卡自己收起：WP324 规则，看的是有没有配上的令牌）。
 *
 * 只在两种时候说话：
 * - 还没配上（第一次装）；
 * - 没跟上新版：文件夹没换成（照实说原因，旧版照常能用）、或浏览器里那个插件重载了还是旧版（多半从别的文件夹装的）。
 *
 * 老本机服务 / 不是桌面版（没有固定文件夹）：整块不出，退回只出配对码。
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { FolderOpen, Puzzle } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { getExtensionInstall, openExtensionInstall } from '@/lib/api'
import { useApp } from '@/lib/app-context'

const copy = (text: string): void => {
  void globalThis.navigator?.clipboard?.writeText(text).catch(() => undefined)
}

export function ExtensionInstall(props: {
  assignment?: string | undefined
  /** 这个工作区里有没有还能用的配对（有 = 已经装好了）。 */
  paired: boolean
}): React.ReactNode {
  const { t } = useApp()
  const [note, setNote] = useState<string | undefined>(undefined)
  const view = useQuery({
    queryKey: ['extension-install', props.assignment],
    queryFn: () => getExtensionInstall(props.assignment),
    retry: false,
    refetchInterval: 5000,
  })
  const open = useMutation({
    mutationFn: (target: 'folder' | 'chrome') => openExtensionInstall(target, props.assignment),
    onSuccess: (out, target) => {
      if (!out.opened) setNote(out.message)
      // WP409：文件夹在访达 / 资源管理器里被选中了——告诉人下一步就是拖
      else if (target === 'folder') setNote(t('extinstall.selected'))
      else {
        // Chrome 不让从外面直接打开扩展页（实测开成新标签页）：地址复制好，请人粘贴
        const address = out.address ?? 'chrome://extensions'
        copy(address)
        setNote(t('extinstall.chrome.copied', { address }))
      }
    },
    onError: (err) => setNote((err as Error).message),
  })

  const v = view.data
  if (v === undefined || !v.can_open || v.folder === undefined) return null
  const folder = v.folder

  const failed = v.sync?.status === 'failed'
  const stuck = v.running.find((r) => r.stuck_on !== undefined && r.version !== v.folder_version)
  if (props.paired && !failed && stuck === undefined) return null

  const openFolder = (): void => {
    // 路径顺手复制：Chrome 的选择窗口里 Mac 按 ⌘⇧G 粘贴、Windows 粘贴到地址栏
    copy(folder)
    open.mutate('folder')
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-2xl bg-card p-4 shadow-[var(--ws-shadow)]"
      data-testid="extension-install"
    >
      {failed ? (
        <p className="text-sm text-[var(--ws-warn)]" data-testid="extension-install-failed">
          {t('extinstall.failed', {
            version: v.bundled_version ?? '',
            error: v.sync?.error ?? '',
          })}
        </p>
      ) : null}
      {stuck === undefined ? null : (
        <p className="text-sm text-[var(--ws-warn)]" data-testid="extension-install-stuck">
          {t('extinstall.stuck', { running: stuck.version, folder: v.folder_version ?? '' })}
        </p>
      )}
      {props.paired && stuck === undefined ? null : (
        <>
          {failed ? null : <p className="text-sm">{t('extinstall.line')}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={openFolder}
              disabled={open.isPending}
              data-testid="extension-install-folder"
            >
              <FolderOpen className="size-4" aria-hidden />
              {t('extinstall.folder')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                // 先复制一份（点的这一下还在用户手势里），本机回来说是 Edge 再换
                copy('chrome://extensions')
                open.mutate('chrome')
              }}
              disabled={open.isPending}
              data-testid="extension-install-chrome"
            >
              <Puzzle className="size-4" aria-hidden />
              {t('extinstall.chrome')}
            </Button>
          </div>
          <p
            className="flex items-center gap-1 text-xs text-muted-foreground"
            data-testid="extension-install-steps"
          >
            {t('extinstall.steps')}
            <Hint text={t('extinstall.steps.hint')} />
          </p>
          {note === undefined ? null : (
            <p className="text-xs text-muted-foreground" data-testid="extension-install-note">
              {note}
            </p>
          )}
        </>
      )}
    </div>
  )
}
