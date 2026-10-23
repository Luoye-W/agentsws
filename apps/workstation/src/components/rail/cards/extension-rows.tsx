/**
 * WP420（自查 ads-amazon A5 / U1）：连接卡上**插件那几行**。
 *
 * 投放这类岗位真正要的是插件（配对 + 在插件里连上广告后台），不是开发者令牌。以前连接卡只列职责的
 * `connectors`（还把人引去填 Meta / Google 的 API 令牌），插件那一格反而不在——没配对也写「都连好了」。
 * 现在：要插件的这一层，连接卡先列两类行——「插件 · 配上了 / 没配对」「Meta 广告后台 · 插件连上了 / 没连」，
 * 没好的亮红、算进「要处理」，点「去配对」就地弹配对那一块。
 *
 * 「要不要插件、配上没有、后台连没连」全是服务端 `GET /v1/extension/needs` 算的（职责的 `browser_extension` 推）。
 */
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { RailScope } from '@/components/rail/rail-scope'
import { EGO_DOWNLOAD_URL } from '@/components/settings/ego-recommend'
import { useOpenConnect } from '@/components/setup/use-open-connect'
import { getExtensionNeeds } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/**
 * 和岗位页顶上那张装插件卡同一个缓存前缀（`extension-onboard-card.tsx` 的 `EXTENSION_NEEDS_KEY`）。
 * 不 import 那个文件：它连着设置 / 连接一大串，挂进卡片堆会拖慢、还可能绕成环。
 */
const EXTENSION_NEEDS_KEY = 'extension-needs'

export interface ExtensionRow {
  key: string
  ok: boolean
  /** WP493：备用（ego 能做全部时插件那一行）——不亮红、不算要处理。 */
  backup?: boolean
  /** WP496（决策 1729 A）：ego 那一行——ego 说有新版本（提一句 + 下载页，不算要处理）。 */
  update?: boolean
}

/** 这一层要插件的话：几行、哪几行没好。不要插件回 `undefined`。 */
export function useScopeExtension(scope: RailScope | undefined): ExtensionRow[] | undefined {
  const roleIds = (scope?.roles ?? []).map((r) => r.role_id)
  const q = useQuery({
    queryKey: [EXTENSION_NEEDS_KEY, 'rail', scope?.assignment ?? '', roleIds.join(',')],
    queryFn: () => getExtensionNeeds(roleIds, scope?.assignment),
    enabled: scope?.assignment !== undefined,
    retry: false,
    staleTime: 30_000,
  })
  return extensionRowsOf(q.data)
}

/** 纯函数：needs → 行（测试直接测它）。 */
export function extensionRowsOf(
  v:
    | {
        needed: boolean
        paired: boolean
        steps: { step: string; done?: boolean }[]
        ego_covers?: string[]
        plugin_backup?: boolean
        ego_update?: boolean
      }
    | undefined,
): ExtensionRow[] | undefined {
  if (v === undefined || !v.needed) return undefined
  // WP493（决策 1718）：ego 能做的那几样由 ego 做——先列 ego；全能做时插件那一行降成「备用」
  const ego: ExtensionRow[] =
    (v.ego_covers?.length ?? 0) > 0
      ? [{ key: 'ego', ok: true, ...(v.ego_update === true ? { update: true } : {}) }]
      : []
  if (v.plugin_backup === true) return [...ego, { key: 'paired', ok: true, backup: true }]
  return [
    ...ego,
    { key: 'paired', ok: v.paired },
    // 配对之后还要在插件里连上的那几家（查不了的不列，不瞎说连上了）
    ...v.steps
      .filter((s) => s.done !== undefined)
      .map((s) => ({ key: s.step, ok: v.paired && s.done === true })),
  ]
}

export function ExtensionRows({ rows }: { rows: ExtensionRow[] }): ReactNode {
  const { t } = useApp()
  const openConnect = useOpenConnect()
  return (
    <ul className="flex flex-col gap-px" data-testid="connection-extension-rows">
      {rows.map((r) => (
        <li
          key={r.key}
          className="flex min-w-0 items-center gap-2 px-1.5 py-1 text-[13px]"
          data-testid="connection-row"
          data-kind={`extension:${r.key}`}
          data-todo={r.ok ? undefined : 'true'}
          data-backup={r.backup === true ? 'true' : undefined}
        >
          <span className="min-w-0 truncate">{t(`extconn.${r.key}`)}</span>
          {r.update === true ? (
            <a
              href={EGO_DOWNLOAD_URL}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 rounded-md bg-ws-tint px-2 py-0.5 text-[12px] text-ws-muted-fg hover:underline"
              title={t('ego.update.hint')}
              data-testid="connection-ego-update"
            >
              {t('ego.update')}
            </a>
          ) : null}
          {r.backup === true ? (
            <span
              className="ml-auto shrink-0 rounded-md bg-ws-tint px-2 py-0.5 text-[12px] text-ws-muted-fg"
              title={t('extconn.backup.hint')}
              data-testid="connection-backup"
            >
              {t('extconn.backup')}
            </span>
          ) : r.ok ? (
            <CheckCircle2
              className="ml-auto size-3.5 shrink-0 text-ws-good"
              aria-label={t('conncard.connected')}
            />
          ) : (
            <button
              type="button"
              data-testid="connection-go"
              className={cn(
                'ml-auto shrink-0 rounded-md bg-ws-bad-bg px-2 py-0.5 text-[12px] font-medium text-ws-bad',
              )}
              onClick={() => {
                openConnect('extension')
              }}
            >
              {t(r.key === 'paired' ? 'extconn.pair' : 'conncard.connect')}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}
