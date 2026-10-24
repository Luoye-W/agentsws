/**
 * WP502（决策 1760 B）：红人图片——头像、横幅、近期作品封面。
 *
 * 图是「存入红人池」那一刻由本机服务缓存下来的，地址是同源的 `/v1/kol/media/<id>`（要登录令牌）。
 * `<img src>` 带不了令牌头，所以先取字节、换成页面内的 `blob:` 地址再画（同素材库那张图的做法），
 * 离开就收回。**壳的「不加载外站图片」一个字没放开**：这里只认同源地址，外站地址根本不进来。
 *
 * 没缓存到 / 取不回来：照旧一个字的头像（`WsAvatar`）、一块色块封面——和以前长得一样，不显示「坏图」。
 */
import { Play } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { WsAvatar } from '@/components/design'
import { kolMediaObjectUrl } from '@/lib/api'
import { cn } from '@/lib/utils'

/** 收回页面内地址（老环境 / 测试环境没有这个函数就算了）。 */
const revoke = (u: string): void => {
  if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(u)
}

/** 只认本机同源的那条路：别的地址一律当没有（外站图片不进壳）。 */
const isLocalMedia = (u: string | undefined): u is string =>
  u !== undefined && /^\/v1\/kol\/media\/[a-f0-9]{32}$/.test(u)

/** 同源图片 → 页面内地址。没有 / 取不到 = `undefined`。 */
export function useKolMedia(
  media_url: string | undefined,
  assignment?: string | undefined,
): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!isLocalMedia(media_url)) {
      setUrl(undefined)
      return
    }
    let alive = true
    let made: string | undefined
    kolMediaObjectUrl(media_url, assignment)
      .then((u) => {
        made = u
        if (alive) setUrl(u)
        else revoke(u)
      })
      .catch(() => {
        if (alive) setUrl(undefined)
      })
    return () => {
      alive = false
      if (made !== undefined) revoke(made)
    }
  }, [media_url, assignment])
  return url
}

/** 头像：缓存到了画图，没有就是一个字的圆头像（KOLAgents `CreatorAvatar`）。 */
export function CreatorAvatar({
  id,
  name,
  mediaUrl,
  assignment,
  className,
}: {
  id: string
  name: string
  mediaUrl?: string | undefined
  assignment?: string | undefined
  className?: string
}): ReactNode {
  const src = useKolMedia(mediaUrl, assignment)
  if (src === undefined)
    return <WsAvatar id={id} name={name} {...(className === undefined ? {} : { className })} />
  return (
    <img
      src={src}
      alt=""
      title={name}
      className={cn('shrink-0 rounded-full object-cover', className)}
      data-testid="kol-avatar-img"
    />
  )
}

/** 横幅（KOLAgents：6:1，纯装饰；没缓存到就整条不画）。 */
export function CreatorBanner({
  mediaUrl,
  assignment,
}: {
  mediaUrl?: string | undefined
  assignment?: string | undefined
}): ReactNode {
  const src = useKolMedia(mediaUrl, assignment)
  if (src === undefined) return null
  return (
    <div className="aspect-[6/1] overflow-hidden rounded-lg bg-muted" data-testid="kol-banner">
      <img src={src} alt="" className="size-full object-cover" />
    </div>
  )
}

/** 作品封面（16:9）：缓存到了画图，没有就是一块色块 + 播放标。 */
export function WorkCover({
  mediaUrl,
  assignment,
  children,
}: {
  mediaUrl?: string | undefined
  assignment?: string | undefined
  /** 盖在左上角的东西（多平台时的平台标志）。 */
  children?: ReactNode
}): ReactNode {
  const src = useKolMedia(mediaUrl, assignment)
  return (
    <div
      className="relative aspect-video overflow-hidden rounded-md bg-muted"
      data-testid="kol-recent-cover"
      data-cached={src === undefined ? 'no' : 'yes'}
    >
      {src === undefined ? (
        <div className="flex size-full items-center justify-center text-muted-foreground">
          <Play className="size-5" aria-hidden />
        </div>
      ) : (
        <img
          src={src}
          alt=""
          className="size-full object-cover transition-transform group-hover:scale-105"
        />
      )}
      {children === undefined ? null : (
        <span className="absolute top-1 left-1 rounded-sm bg-background/90 p-1 shadow-sm">
          {children}
        </span>
      )}
    </div>
  )
}
