/**
 * WP456-T2：**组件一览**（`/ui-kit`，左栏不放入口）——工作台共用件一页看全，浅 / 深色对照、截图验收、
 * 以后新写页面先来这里挑件。只摆样子，不接数据；文字是演示用的假话（演示品牌 NordVolt Gear）。
 *
 * 每一节对应 `WP456-design.md` §2.6 的一条；最底下一块是 genui 插件画的卡（决策 847：同一套档位），
 * 和上面的决定卡并排看是不是一套。
 */
import { filterGenuiSpec } from '@agentsws/contracts'
import { Bell, CalendarDays, Inbox, Link2Off, MessageSquare, Plus } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { GenuiBlockView } from '@/components/answer/genui/genui-block'
import {
  CategoryTag,
  CompareBlock,
  CountBadge,
  DecisionCard,
  DecisionCardBody,
  DecisionCardFoot,
  DecisionCardHead,
  EmptyState,
  GroupLabel,
  ListGroup,
  ListRow,
  NoticeLine,
  OptionGroup,
  PageHeader,
  SectionHeader,
  Segmented,
  SkeletonList,
  StatusPill,
} from '@/components/design'

const GENUI_SAMPLE = filterGenuiSpec({
  items: [
    {
      type: 'card',
      title: '退货这周的样子',
      items: [
        { type: 'badge', label: '要留意', tone: 'warn' },
        {
          type: 'grid',
          cols: 2,
          items: [
            { type: 'stat', label: '本周退货', value: '12', delta: '+3' },
            { type: 'stat', label: '平均处理', value: '1.4 天', delta: '-0.3' },
          ],
        },
        { type: 'text', content: '多数是尺码不合适，集中在充电宝 20000mAh。', size: 'muted' },
      ],
    },
  ],
}).spec

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader title={title} />
      {children}
    </section>
  )
}

export default function UiKitPage(): ReactNode {
  const [view, setView] = useState<'open' | 'sent' | 'all'>('open')
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system')
  const [tab, setTab] = useState<'role' | 'knowledge' | 'caps'>('role')
  const [option, setOption] = useState<string | undefined>('refund')
  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-8 pb-12" data-testid="ui-kit">
      <PageHeader
        title="组件一览"
        sub="工作台共用件 · 视觉规范 v1"
        actions={
          <>
            <Segmented
              label="视图"
              value={view}
              onChange={setView}
              options={[
                { value: 'open', label: '没人接的', count: 8 },
                { value: 'sent', label: '已分出去', count: 4 },
                { value: 'all', label: '全部' },
              ]}
            />
            <button type="button" className="ws-btn ws-btn-primary">
              <Plus aria-hidden className="size-4" />
              记一条
            </button>
          </>
        }
      />

      <div className="grid gap-8 md:grid-cols-2">
        <Section title="节标题 · 分组名">
          <SectionHeader
            title="今天要做"
            count={3}
            actions={
              <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm">
                全部
              </button>
            }
          />
          <GroupLabel count={2}>本周</GroupLabel>
        </Section>

        <Section title="标签三种">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone="good">在跑</StatusPill>
            <StatusPill tone="warn">等你批</StatusPill>
            <StatusPill tone="bad">连接断了</StatusPill>
            <StatusPill tone="info">提示</StatusPill>
            <StatusPill>没开始</StatusPill>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CategoryTag>售后</CategoryTag>
            <CategoryTag>退款</CategoryTag>
            <CategoryTag outline>演示数据</CategoryTag>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <CountBadge n={3} />
            <CountBadge n={12} tone="brand" />
            <CountBadge n={128} tone="alert" />
            <span className="relative inline-flex size-7 items-center justify-center rounded-md text-ws-muted-fg">
              <Bell aria-hidden className="size-4" />
              <CountBadge n={4} tone="alert" corner />
            </span>
          </div>
        </Section>
      </div>

      <Section title="列表组 / 行">
        <ListGroup>
          <ListRow end={<span className="ws-num text-ws-faint">09:40</span>}>
            <span className="size-4 shrink-0 rounded-sm shadow-[inset_0_0_0_1.5px_var(--ws-line-strong)]" />
            <span className="min-w-0 flex-1 truncate">回 Anna 的退货邮件</span>
            <CategoryTag>售后</CategoryTag>
          </ListRow>
          <ListRow onClick={() => {}} end="3 个要处理">
            <Inbox aria-hidden className="size-4 text-ws-muted-fg" />
            <span className="min-w-0 flex-1 truncate">消息 · 没人接的</span>
          </ListRow>
          <ListRow onClick={() => {}} end={<StatusPill tone="good">已连接</StatusPill>}>
            <MessageSquare aria-hidden className="size-4 text-ws-muted-fg" />
            <span className="min-w-0 flex-1 truncate">网站聊天</span>
          </ListRow>
        </ListGroup>
      </Section>

      <div className="grid gap-8 md:grid-cols-2">
        <Section title="分段切换（全站一种）">
          <Segmented
            label="主题"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
              { value: 'system', label: '跟系统' },
            ]}
          />
          <Segmented
            kind="tabs"
            size="sm"
            label="设定"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'role', label: '角色' },
              { value: 'knowledge', label: '知识' },
              { value: 'caps', label: '额度' },
            ]}
          />
        </Section>

        <Section title="按钮四级">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="ws-btn ws-btn-primary">
              主按钮
            </button>
            <button type="button" className="ws-btn ws-btn-secondary">
              次按钮
            </button>
            <button type="button" className="ws-btn ws-btn-ghost">
              弱按钮
            </button>
            <button type="button" className="ws-link">
              链接
            </button>
            <button type="button" className="ws-btn ws-btn-primary" disabled>
              不能点
            </button>
          </div>
        </Section>
      </div>

      <Section title="一行提醒">
        <NoticeLine icon={Link2Off} action={{ label: '去连接', onClick: () => {} }}>
          还没连 Shopify 店铺，订单和退货看不到
        </NoticeLine>
        <NoticeLine tone="bad" action={{ label: '重新连接', onClick: () => {} }}>
          Gmail 连接断了
        </NoticeLine>
        <NoticeLine tone="info" icon={CalendarDays}>
          日历只显示勾上的那几层
        </NoticeLine>
      </Section>

      <div className="grid gap-8 md:grid-cols-2">
        <Section title="空状态">
          <EmptyState
            icon={Inbox}
            text="没有要你处理的"
            action={{ label: '看全部', onClick: () => {} }}
          />
        </Section>
        <Section title="加载（骨架行）">
          <SkeletonList rows={3} label="加载中" />
        </Section>
      </div>

      <div className="grid gap-8 md:grid-cols-2">
        <Section title="决定卡外壳">
          <DecisionCard>
            <DecisionCardHead end={<span className="ws-link-muted">证据 3</span>}>
              <CategoryTag>售后 · 退款</CategoryTag>
              <StatusPill tone="warn">等你批</StatusPill>
            </DecisionCardHead>
            <DecisionCardBody
              title="Anna 要退 #1001，超出 14 天"
              desc="这周碰到 3 次。定了以后照这个办，不再问你"
            >
              <CompareBlock
                beforeLabel="现在"
                before="超期一律拒绝"
                afterLabel="改成"
                after="超期 7 天内退一半"
              />
              <OptionGroup
                label="怎么处理"
                value={option}
                onChange={setOption}
                options={[
                  { id: 'refund', label: '全额退款', note: '推荐' },
                  { id: 'half', label: '退一半' },
                  { id: 'no', label: '不退，礼貌说明' },
                ]}
              />
            </DecisionCardBody>
            <DecisionCardFoot keys="↑ 稍后 · ↓ 修改">
              <button type="button" className="ws-btn ws-btn-primary">
                通过
              </button>
              <button type="button" className="ws-btn ws-btn-secondary">
                修改
              </button>
              <button type="button" className="ws-btn ws-btn-ghost">
                稍后
              </button>
            </DecisionCardFoot>
          </DecisionCard>
        </Section>

        <Section title="genui 画的卡（同一套档位）">
          {GENUI_SAMPLE === undefined ? null : (
            <GenuiBlockView spec={GENUI_SAMPLE} fallback={null} />
          )}
        </Section>
      </div>
    </div>
  )
}
