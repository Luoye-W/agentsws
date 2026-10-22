/**
 * WP341（决策 847）：宿主自己画的两种 genui 组件（契约过滤时由别的组件换过来；渲染层那一块加载时登记）。
 *
 * - **口令格**（`ws-secret`，决策 814）：模型写的口令 / key / token 格子。值**不**进插件的表单状态、不经处理器、
 *   不经 AI——绑了服务的，就地画那一样的连接卡（本机原生表单，值只打连接面 / 消息渠道那条接口进本机加密库）；
 *   连上后只告诉处理器「这一格已填好」（名字，没有值）。没绑服务的，给一个「去连接」开第三栏。
 * - **「点开看」的外部媒体**（`ws-media`）：不在常见来源里的图片 / 音视频先不加载，标出真实域名，点了才画；
 *   旁边「以后这个网站的图都直接显示」记进品牌的白名单（849），白名单里的（含已连店铺的域名）直接画。
 *
 * WP456-T2：两种都用工作台的共用件（口令格是一张 `.ws-group` 卡、「点开看」是小号次按钮、白名单是 `ws-link-muted`），
 * 和插件画的卡（`genui-view.css` 接过档位）看着是一套。
 */
import { type ConnectNeed, type GenuiNodeLite, genuiHostAllowed } from '@agentsws/contracts'
import { Image as ImageIcon, Lock } from 'lucide-react'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { InfoTip } from '@/components/design'
import { ConnectNeedsBody, useConnectContext } from '@/components/setup/connect-card'
import { useOpenConnect } from '@/components/setup/use-open-connect'
import { Button } from '@/components/ui/button'
import { useApp } from '@/lib/app-context'
import type { HostGenuiProps } from './primitives-shim'
import { useImageHosts } from './use-image-hosts'

/** 处理器认的那个动作名：一格口令填好了（只带名字）。 */
export const SECRET_DONE_ACTION = 'ws-secret:done'

const textOf = (x: unknown): string => (typeof x === 'string' ? x : '')

export function SecretNode({ node, onAction }: HostGenuiProps): ReactNode {
  const { t } = useApp()
  const label = textOf(node.label) || '口令'
  const service = textOf(node.service)
  const ctx = useConnectContext(undefined)
  const openConnect = useOpenConnect()
  const needs = useMemo<ConnectNeed[]>(
    () => (service === '' ? [] : [{ kind: service, service, name: label, required: true }]),
    [service, label],
  )
  const done = useCallback(() => {
    onAction?.(SECRET_DONE_ACTION, { type: 'ws-secret', label })
  }, [onAction, label])
  return (
    <div
      className="ws-group flex flex-col gap-2 p-4"
      data-testid="genui-secret"
      data-service={service}
    >
      <InfoTip
        text={t('genui.secret.tip')}
        className="flex items-center gap-1.5 text-sm text-ws-ink"
      >
        <Lock aria-hidden className="size-3.5 text-ws-muted-fg" />
        {label}
      </InfoTip>
      {service === '' ? (
        <div>
          <Button
            size="sm"
            variant="secondary"
            data-testid="genui-secret-connect"
            onClick={() => {
              openConnect(undefined)
            }}
          >
            {t('genui.secret.elsewhere')}
          </Button>
        </div>
      ) : (
        <ConnectNeedsBody needs={needs} ctx={ctx} onAllConnected={done} />
      )}
    </div>
  )
}

export function MediaGateNode({ node, renderChildren }: HostGenuiProps): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const hosts = useImageHosts()
  const src = textOf(node.src)
  const media = textOf(node.media) || 'image'
  const host = textOf(node.host)
  // WP341 追加（849）：白名单里的网站（人加的 + 已连的店铺）直接画
  if (open || genuiHostAllowed(src, hosts.allowed)) {
    const real: GenuiNodeLite = {
      type: media as GenuiNodeLite['type'],
      src,
      ...(textOf(node.alt) === '' ? {} : { alt: textOf(node.alt) }),
    }
    return <>{renderChildren([real], 'media') as ReactNode}</>
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        title={src}
        data-testid="genui-media-gate"
        className="ws-btn ws-btn-secondary ws-btn-sm w-fit"
        onClick={() => {
          setOpen(true)
        }}
      >
        <ImageIcon aria-hidden className="size-3.5" />
        {t('genui.media.open', { host })}
      </button>
      {host === '' || hosts.view === undefined ? null : (
        <button
          type="button"
          data-testid="genui-media-always"
          disabled={hosts.busy}
          className="ws-link-muted text-xs"
          onClick={() => {
            hosts.add(host)
          }}
        >
          {t('genui.media.always')}
        </button>
      )}
    </span>
  )
}
