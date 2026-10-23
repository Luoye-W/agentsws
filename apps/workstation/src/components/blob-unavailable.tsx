/**
 * WP482：大文件（附件、录音、上传的原件）放在外置硬盘 / NAS 上、这次连不上时，用到它们的地方说一句
 * 「大文件存放的位置现在连不上：<位置>」，给「再试一次」。别的地方照常用——工坊不因为大文件被拦住。
 *
 * 服务进程那一侧：`provider_unavailable`（503）+ `details.reason = 'blob_location_unreachable'`
 * + `details.location`（`@agentsws/blob` 的 `LocalBlobStore`）。接好之后同一个服务进程下一次读写就通了，
 * 所以「再试一次」就是把刚才那件事再做一遍。
 */
import { AlertTriangle, RotateCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { ApiClientError } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 服务进程回的那个原因（与 `@agentsws/blob` 的 `BLOB_LOCATION_UNREACHABLE` 同一个值）。 */
export const BLOB_LOCATION_UNREACHABLE = 'blob_location_unreachable'

/** 这个错是不是「大文件位置连不上」；是就回那个位置（没给位置回空串）。 */
export function blobUnavailableLocation(err: unknown): string | undefined {
  if (!(err instanceof ApiClientError)) return undefined
  const details = err.details as { reason?: unknown; location?: unknown } | undefined
  if (err.code !== 'provider_unavailable' || details?.reason !== BLOB_LOCATION_UNREACHABLE)
    return undefined
  return typeof details.location === 'string' ? details.location : ''
}

/** 一句话 + 「再试一次」。 */
export function BlobUnavailableNotice({
  location,
  onRetry,
  retrying = false,
  testId = 'blob-unavailable',
}: {
  location: string
  onRetry: () => void
  retrying?: boolean
  testId?: string
}): ReactNode {
  const { t } = useApp()
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-ws-warn-bg px-2 py-1.5 text-xs text-ws-warn"
      data-testid={testId}
      role="alert"
    >
      <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
      <span className="break-all">{t('blobloc.unreachable', { path: location })}</span>
      <Button
        type="button"
        size="xs"
        variant="link"
        className="h-auto px-0 text-xs"
        data-testid={`${testId}-retry`}
        disabled={retrying}
        onClick={onRetry}
      >
        <RotateCw aria-hidden className={retrying ? 'animate-spin' : undefined} />
        {t('blobloc.retry')}
      </Button>
    </p>
  )
}
