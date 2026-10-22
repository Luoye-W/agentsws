/**
 * WP419（自查 S4）：排期框里带素材库的图（最近 8 张，点一下选 / 取消）。IG / TikTok / YouTube 要带图片或视频——
 * 没挑也能提上去（到时候在发帖页里自己选），但这里说一句。
 */
import { useQuery } from '@tanstack/react-query'
import { listBrandAssets, type SocialChannelId } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

const MEDIA_CHANNELS: ReadonlySet<string> = new Set(['instagram', 'tiktok', 'youtube'])

export function SocialMediaPick(props: {
  channel: SocialChannelId
  picked: string[]
  onChange(next: string[]): void
}): React.ReactNode {
  const { t } = useApp()
  const assets = useQuery({
    queryKey: ['brand-assets', 'social-pick'],
    queryFn: () => listBrandAssets({ limit: 8 }),
    retry: false,
  })
  const rows = assets.data?.rows ?? []
  return (
    <div className="flex flex-col gap-1" data-testid="social-media-pick">
      {MEDIA_CHANNELS.has(props.channel) && props.picked.length === 0 ? (
        <p className="text-[12px] text-ws-warn" data-testid="social-media-need">
          {t('social.media.need')}
        </p>
      ) : null}
      {rows.length === 0 ? null : (
        <div className="flex flex-wrap gap-1">
          <span className="text-[12px] text-ws-muted-fg">{t('social.media.pick')}</span>
          {rows.map((a) => {
            const on = props.picked.includes(a.id)
            return (
              <button
                key={a.id}
                type="button"
                aria-pressed={on}
                data-testid="social-media-asset"
                className={cn(
                  'max-w-32 truncate rounded-sm border px-1.5 text-xs',
                  on && 'border-primary bg-primary/10',
                )}
                onClick={() =>
                  props.onChange(
                    on ? props.picked.filter((x) => x !== a.id) : [...props.picked, a.id],
                  )
                }
              >
                {a.source_label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
