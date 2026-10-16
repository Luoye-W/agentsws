/**
 * WP341 追加（849）：「设置 → 通用」里的一行——AI 回话里哪些网站的图直接显示（品牌级白名单）。
 * 能看、能删、能手动加；已连店铺的域名自动算在里面（标「已连的店铺」，删不掉）。说明进问号（少字）。
 */
import { Store, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useImageHosts } from '@/components/answer/genui/use-image-hosts'
import { SettingRow } from '@/components/settings-panel/setting-row'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useApp } from '@/lib/app-context'

const CHIP =
  'inline-flex items-center gap-1 rounded-full bg-ws-surface px-2.5 py-0.5 text-xs text-ws-body shadow-[inset_0_0_0_1px_var(--ws-line)]'

export function ImageHostsSetting(): ReactNode {
  const { t } = useApp()
  const hosts = useImageHosts()
  const [draft, setDraft] = useState('')
  if (hosts.view === undefined) return null
  const submit = (): void => {
    if (draft.trim() === '') return
    hosts.add(draft)
    setDraft('')
  }
  return (
    <SettingRow
      stacked
      testId="settings-image-hosts"
      title={t('settings.image_hosts')}
      desc={t('sp.image_hosts.desc')}
      hint={t('settings.image_hosts.hint')}
      control={
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {hosts.view.shop_hosts.map((h) => (
              <span
                key={h}
                className={CHIP}
                title={t('settings.image_hosts.shop')}
                data-shop="true"
              >
                <Store aria-label={t('settings.image_hosts.shop')} className="size-3" />
                {h}
              </span>
            ))}
            {hosts.view.hosts.map((h) => (
              <span key={h.host} className={CHIP} data-testid="settings-image-host">
                {h.host}
                <button
                  type="button"
                  className="text-ws-muted-fg hover:text-ws-ink"
                  aria-label={t('settings.image_hosts.remove', { host: h.host })}
                  disabled={hosts.busy}
                  onClick={() => {
                    hosts.remove(h.host)
                  }}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <Input
              value={draft}
              className="h-8 max-w-xs text-xs"
              placeholder={t('settings.image_hosts.placeholder')}
              aria-label={t('settings.image_hosts')}
              data-testid="settings-image-hosts-input"
              onChange={(e) => {
                setDraft(e.target.value)
              }}
            />
            <Button size="sm" variant="outline" type="submit" disabled={hosts.busy}>
              {t('settings.image_hosts.add')}
            </Button>
          </form>
          {hosts.error === undefined ? null : <p className="text-xs text-ws-bad">{hosts.error}</p>}
        </div>
      }
    />
  )
}
