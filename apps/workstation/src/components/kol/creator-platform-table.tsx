/** 移植自 KOLAgents `src/components/influencer/creator-platform-table.tsx` @ 88d74b2c（Luoye 的产品，非模板代码）。 */
/**
 * 分平台一行表 + 上面那两个合计数（KOLAgents WP-B3）。回答谈判现场那一句：「他 YouTube 45 万、TikTok 8 万，
 * 互动率各是多少」——一个人有两条以上渠道的账号时，详情顶上那一条三格数字换成这张表。
 *
 * 口径红线照搬（KOLAgents 方案 §7.5）：
 * - 粉丝合计永远标「未去重」，不叫触达；
 * - 互动率**按平台各写各的**，永不跨平台平均——YouTube 的播放和 TikTok 的播放没有一个共同的分母。
 *
 * 改的地方：样式换成工坊的令牌；平台标志用工坊本地的品牌图标（不加载外站图）；
 * 「设为主平台」「拆分为独立红人」那个行菜单不搬（工坊没有这两条接口——见报告「缺什么」）；
 * 「最近发布距今」一列换成「看到于」：工坊每个账号都有「这份数字是什么时候看到的」，
 * 发布时间只有存入过红人池的账号才有。
 */
import type { ReactNode } from 'react'
import { BrandIcon } from '@/components/brand-icons'
import { CategoryTag } from '@/components/design'
import { Hint } from '@/components/ui/hint'
import type { KolCreatorDetailData } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import {
  avgViewsOf,
  dayOf,
  formatCount,
  formatEngagementRate,
  totalFollowers,
} from './creator-display'
import { atHandle, CHANNEL_SERVICE } from './kol-channel'

type Account = KolCreatorDetailData['accounts'][number]

function StatFigure({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs leading-tight text-muted-foreground">{label}</div>
      <div className="ws-num truncate text-base font-semibold">{value}</div>
    </div>
  )
}

export function CreatorPlatformBreakdown({
  accounts,
  primaryId,
  profiles,
}: {
  /** 主平台排第一（`personAccounts`）。 */
  accounts: readonly Account[]
  primaryId: string | undefined
  profiles: KolCreatorDetailData['profiles']
}): ReactNode {
  const { t } = useApp()
  const followers = totalFollowers(accounts)
  return (
    <div className="flex flex-col gap-2" data-testid="kol-platform-table" data-slot="data">
      {/* 合计：只有一个数，口径写在它的问号里 */}
      <div className="flex items-end gap-1.5 rounded-lg bg-muted/50 px-3 py-2">
        <StatFigure
          label={t('kol.info.total_followers')}
          value={followers.counted === 0 ? '—' : formatCount(followers.total)}
        />
        <Hint
          text={t('kol.info.total_followers.hint', {
            counted: followers.counted,
            accounts: accounts.length,
          })}
          className="mb-1"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[20rem] border-collapse text-xs whitespace-nowrap">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-1 pr-2 text-left font-normal">{t('kol.info.table.account')}</th>
              <th className="px-1.5 py-1 text-right font-normal">{t('kol.judge.followers')}</th>
              <th className="px-1.5 py-1 text-right font-normal">{t('kol.info.avg_views')}</th>
              <th className="px-1.5 py-1 text-right font-normal">{t('kol.info.engagement')}</th>
              <th className="py-1 pl-1.5 text-right font-normal">{t('kol.info.table.seen')}</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} className="border-t border-ws-line" data-testid="kol-platform-row">
                <td className="py-1.5 pr-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <BrandIcon provider={CHANNEL_SERVICE[a.channel]} size={14} />
                    <a
                      className="min-w-0 max-w-[9rem] truncate hover:underline"
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {atHandle(a.handle)}
                    </a>
                    {a.id === primaryId ? (
                      <CategoryTag className="h-[18px] px-1 text-[11px]">
                        {t('kol.info.table.primary')}
                      </CategoryTag>
                    ) : null}
                  </span>
                </td>
                <td className="ws-num px-1.5 py-1.5 text-right">{formatCount(a.followers)}</td>
                <td className="ws-num px-1.5 py-1.5 text-right">
                  {formatCount(avgViewsOf(profiles?.[a.id]))}
                </td>
                <td className="ws-num px-1.5 py-1.5 text-right">
                  {formatEngagementRate(a.engagement_rate)}
                </td>
                <td
                  className="ws-num py-1.5 pl-1.5 text-right text-muted-foreground"
                  title={dayOf(a.observed_at)}
                >
                  {/* 月-日：一行放得下；整日期在悬停里 */}
                  {dayOf(a.observed_at).slice(5)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
