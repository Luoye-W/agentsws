/**
 * WP395（docs/106 §13）：Amazon 运营岗位的面板骨架——右侧面板「报表」里，岗位层与亚马逊店铺运营那条职责都出它。
 *
 * 四块，一期都没有数据来源：
 * 1. **每日巡检**（账户健康 / 断货风险 / Listing 买不了）：要连上 Amazon 店铺才有。照实说「连上后才有」，不出 0
 *    （docs/36 §3）。「连上」按钮指向连接目录里**可用的** Amazon 店铺连接（WP399 那张卡）；还没有就不放按钮。
 * 2. **竞品动向**（WP392–394 填）、3. **Listing 体检**（WP396 填）、4. **词库**（WP398 填）。
 *
 * 空块一律同一个样子（{@link AmazonEmpty}：一行灰字，docs/36 §7「空态」），不各写各的。
 * 后面几单往块里填内容走 {@link registerAmazonBlockBody}，不用改这个文件的结构。
 */
import { CONNECTION_DIRECTORY } from '@agentsws/contracts'
import type { ComponentType, ReactNode } from 'react'
import { useOpenConnect } from '@/components/setup/use-open-connect'
import { EmptyLine } from '@/components/ui/empty-line'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'

/** 四块的 id（顺序 = 面板上从上到下）。 */
export const AMAZON_BLOCKS = ['daily', 'competitors', 'listing', 'keywords'] as const
export type AmazonBlockId = (typeof AMAZON_BLOCKS)[number]

/** 后面几单填进来的块身体（拿到的是亚马逊店铺运营那条分配）。 */
export type AmazonBlockBody = ComponentType<{ assignment: string }>

const bodies = new Map<AmazonBlockId, AmazonBlockBody>()

/** 给一块换上真内容（WP394 / 396 / 398 用）。回一个撤销函数。 */
export function registerAmazonBlockBody(id: AmazonBlockId, Body: AmazonBlockBody): () => void {
  bodies.set(id, Body)
  return () => {
    if (bodies.get(id) === Body) bodies.delete(id)
  }
}

/**
 * 连接目录里能用的 Amazon 店铺连接（第三栏连接卡认的 service）。现在 `amazon_sp` 还是 planned，
 * 所以是 `undefined`——不放按钮；WP399 那张卡可用了自己就亮。
 */
export function amazonConnectService(): string | undefined {
  const hit = CONNECTION_DIRECTORY.find(
    (e) => e.category === 'marketplace' && e.status === 'available' && /amazon/i.test(e.kind),
  )
  return hit === undefined ? undefined : (hit.service ?? hit.kind)
}

/** 空块：一行灰字（+ 能去连的时候一个按钮）。四块共用这一个。 */
export function AmazonEmpty({
  text,
  connect,
  testId,
}: {
  text: string
  connect?: string | undefined
  testId?: string
}): ReactNode {
  const { t } = useApp()
  const openConnect = useOpenConnect()
  return (
    <EmptyLine
      text={text}
      {...(testId === undefined ? {} : { testId })}
      {...(connect === undefined
        ? {}
        : {
            action: {
              label: t('amzops.connect'),
              onClick: () => {
                openConnect(connect)
              },
              testId: 'amzops-connect',
              connect,
            },
          })}
    />
  )
}

function Block({
  id,
  title,
  hint,
  children,
}: {
  id: AmazonBlockId
  title: string
  hint: string
  children: ReactNode
}): ReactNode {
  return (
    <section className="flex flex-col gap-2" data-testid="amzops-block" data-block={id}>
      <h4 className="flex items-center gap-1.5 text-sm font-medium">
        {title}
        <Hint text={hint} />
      </h4>
      {children}
    </section>
  )
}

/**
 * 每日巡检：WP420（自查 B12 / U18）——以前三行一模一样的「连上 Amazon 店铺后才有」，现在并成一行
 * 「账户健康、断货、买不了：要连 Amazon 店铺（还没开放）」；能连的时候带「连上」。
 */
function DailyEmpty(): ReactNode {
  const { t } = useApp()
  const connect = amazonConnectService()
  return (
    <div className="flex flex-col gap-1" data-testid="amzops-daily-row">
      <span className="text-sm">{t('amzops.daily.one')}</span>
      <AmazonEmpty
        text={connect === undefined ? t('amzops.empty.planned') : t('amzops.empty.connect')}
        connect={connect}
      />
    </div>
  )
}

const EMPTY_KEY: Record<Exclude<AmazonBlockId, 'daily'>, string> = {
  competitors: 'amzops.competitors.empty',
  listing: 'amzops.listing.empty',
  keywords: 'amzops.keywords.empty',
}

const TITLE_KEY: Record<AmazonBlockId, string> = {
  daily: 'amzops.daily',
  competitors: 'amzops.competitors',
  listing: 'amzops.listing',
  keywords: 'amzops.keywords',
}

/** 这条职责 / 这个岗位有没有这块面板（岗位层看它的职责里有没有亚马逊店铺运营）。 */
export const AMAZON_STORE_ROLE = 'amz.store'

export function AmazonOpsBoard({ assignment }: { assignment: string }): ReactNode {
  const { t } = useApp()
  return (
    <section className="flex flex-col gap-4" data-testid="amzops-board">
      <h3 className="ws-display text-base">{t('amzops.title')}</h3>
      {AMAZON_BLOCKS.map((id) => {
        const Body = bodies.get(id)
        return (
          <Block key={id} id={id} title={t(TITLE_KEY[id])} hint={t(`${TITLE_KEY[id]}.hint`)}>
            {Body !== undefined ? (
              <Body assignment={assignment} />
            ) : id === 'daily' ? (
              <DailyEmpty />
            ) : (
              <AmazonEmpty text={t(EMPTY_KEY[id])} testId={`amzops-empty-${id}`} />
            )}
          </Block>
        )
      })}
    </section>
  )
}
