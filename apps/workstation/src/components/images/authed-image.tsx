/**
 * WP268：素材库里的图要带登录令牌才取得到（`/v1/brand-assets/:id/file`），`<img src>` 带不了头——
 * 先取字节、换成页面内的 `blob:` 地址再画；离开就收回。
 */
import { cn } from 'cn'
import { ImageOff } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { brandAssetObjectUrl } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 收回页面内地址（老环境 / 测试环境没有这个函数就算了）。 */
const revoke = (u: string): void => {
  if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(u)
}

export function AuthedImage({
  src,
  alt,
  className,
  testId,
}: {
  src: string
  alt: string
  className?: string
  testId?: string
}): ReactNode {
  const { t } = useApp()
  const [url, setUrl] = useState<string | undefined>(undefined)
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    let alive = true
    let made: string | undefined
    setBroken(false)
    setUrl(undefined)
    brandAssetObjectUrl(src)
      .then((u) => {
        made = u
        if (alive) setUrl(u)
        else revoke(u)
      })
      .catch(() => {
        if (alive) setBroken(true)
      })
    return () => {
      alive = false
      if (made !== undefined) revoke(made)
    }
  }, [src])
  if (broken)
    return (
      <div
        role="img"
        aria-label={t('images.broken')}
        className={cn('grid place-items-center bg-ws-tint text-ws-muted-fg', className)}
      >
        <ImageOff aria-hidden className="size-5" />
      </div>
    )
  if (url === undefined)
    return (
      <div
        role="img"
        aria-label={t('images.loading')}
        className={cn('animate-pulse bg-ws-tint', className)}
      />
    )
  return (
    <img
      src={url}
      alt={alt}
      className={cn('object-cover', className)}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    />
  )
}
