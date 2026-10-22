/**
 * service worker：**插件里唯一一个能上网的地方**（WP119 定论 2）。
 *
 * 它只会打一个地方：`http://127.0.0.1:<端口>`。content script 发过来的消息里
 * 没有 URL 这一格，所以「让这个插件去打别的服务器」这件事在协议层就没有入口。
 *
 * 另外两件它管的事：
 * - 工具栏图标被按了 → 三个红人平台上让当前页面开 / 关那块面板（插件没有 popup 窗口，
 *   面板长在页面上，因为用户要一边看那个人的主页一边看体检结果）；别的页面打开侧边栏（WP413），
 *   侧边栏打不开才退回设置页（WP409 的退路）；图标角标跟着配对状态（配上了绿勾，WP409）；
 * - 每隔一会儿把排着的观测补上去（桌面应用可能是刚刚才打开的）。
 * - WP313：广告动作通道——连上了广告后台（可选权限）才每分钟问一次本机「有没有批好的活」，
 *   问到了就在看得见的广告后台标签页上做；页面顶上的横条点了停止 / 确认，消息回到这里。
 * - WP345：跟着工坊更新——每分钟（和起来时）问一次本机「插件文件夹里是哪一版」，不一样就等空闲后自己重载。
 *   WP432：没配对也问（只问版本号）。
 * - WP432（Luoye 10-20 反馈 9）：**插件不自己开 Reddit 页面**——批过的回复在侧边栏里等你点「打开这一条」，
 *   点了才在这个窗口新开标签页、填好、等你自己点发送；图标上出「等你发」的数字，新来的弹一句通知。
 * - WP467（Luoye 10-22）：「填入」先找**你已经开着的原帖页**就地填（没开着才新开 www 原帖，不用 old.reddit）；
 *   你自己在原帖页上发出去的（插件填好后点的、或复制粘贴的），插件认出来就记「已记录」。
 */

import { redditJobOnWww } from '@agentsws/browser-action'
import { defineBackground } from 'wxt/utils/define-background'
import { onActionClick } from '@/lib/action-click'
import { adsPanelStatus, recordAdsConsent } from '@/lib/ads/broker'
import { noteActionClick } from '@/lib/ads/capture-grant'
import { ADS_CONTENT_SCRIPT } from '@/lib/ads/chrome-driver'
import type { AdsDomResponse } from '@/lib/ads/dom-messages'
import type { RunControl } from '@/lib/ads/executor'
import { executeJob } from '@/lib/ads/executor'
import { openAdsTab, openRedditTab, seenAdsAccounts } from '@/lib/ads/open-tab'
import { chromePermissions } from '@/lib/ads/permissions'
import { pollAdsOnce } from '@/lib/ads/poller'
import type { BrokerDeps } from '@/lib/broker'
import { flush, observe, pair, status, unpair } from '@/lib/broker'
import { registerBusy } from '@/lib/idle-gate'
import { actionResult } from '@/lib/local-client'
import type { ExtensionMessage, ExtensionResponse } from '@/lib/messages'
import {
  type PanelBrokerDeps,
  panelAnswerPost,
  panelDropWrite,
  panelFillCard,
  panelOpenWrite,
  panelRefillWrite,
  panelSkipCard,
  panelState,
  panelUndoFollow,
} from '@/lib/panel/broker'
import { composeUrlAllowed, workshopCardUrl } from '@/lib/panel/format'
import { backgroundFetch, chromeRedditTabs, sessionFetch } from '@/lib/reddit/fetcher'
import { redditConnected } from '@/lib/reddit/permissions'
import { pollRedditOnce, REDDIT_STATUS_KEY, readRedditStatus } from '@/lib/reddit/poller'
import { SentWatcher } from '@/lib/reddit/sent-broker'
import { checkForUpdate, runningVersion } from '@/lib/self-update'
import { chromeStore, clearQueue, readSettings, writeSettings } from '@/lib/storage'
import { refreshWaiting } from '@/lib/waiting'

/** 多久试一次补传。5 分钟：够快，也不至于在应用没开时一直空打。 */
const FLUSH_ALARM = 'agentsws-flush'
const FLUSH_PERIOD_MINUTES = 5
/** WP313：多久问一次有没有批好的广告活（每次最多挂 25 秒）。 */
const ADS_ALARM = 'agentsws-ads-poll'
const ADS_PERIOD_MINUTES = 1
/** WP328：多久问一次有没有要读的 Reddit（巡查一天一次起步；问是本机回环，很便宜）。 */
const REDDIT_ALARM = 'agentsws-reddit-poll'
const REDDIT_PERIOD_MINUTES = 1
/** WP345：多久问一次「工坊换了新版插件没有」（本机回环，很便宜）。 */
const UPDATE_ALARM = 'agentsws-update'
const UPDATE_PERIOD_MINUTES = 1

export default defineBackground(() => {
  const deps: BrokerDeps = { store: chromeStore(), now: () => new Date().toISOString() }

  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_PERIOD_MINUTES })
  // WP409：图标角标跟着配对状态走（配上了绿勾）；WP432：有等你发的就出数字、新来的弹一句通知
  const badge = (): Promise<unknown> =>
    refreshWaiting({
      store: deps.store,
      action: chrome.action,
      notify: (item, total) => {
        void chrome.notifications
          ?.create(`agentsws-waiting:${item.id}`, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon/128.png'),
            title: total > 1 ? `${total} 条等你发` : '有一条等你发',
            message: `${item.label}\n点工具栏上的插件图标，在侧边栏里打开、自己点发送。`,
          })
          .catch(() => undefined)
      },
    }).catch(() => undefined)
  void badge()
  // 点通知：把侧边栏打开（Chrome 认这一下是用户手势就开，不认就只把窗口叫到前面）
  chrome.notifications?.onClicked.addListener((id) => {
    if (!id.startsWith('agentsws-waiting:')) return
    void chrome.windows
      .getLastFocused()
      .then((w) => (w.id === undefined ? undefined : chrome.sidePanel.open({ windowId: w.id })))
      .catch(() => undefined)
    void chrome.notifications.clear(id).catch(() => undefined)
  })
  // WP313：广告动作通道
  const perms = chromePermissions()
  const control: RunControl = { stop: false }
  const pollAds = (): Promise<unknown> =>
    pollAdsOnce({
      store: deps.store,
      perms,
      openTab: openAdsTab,
      // WP348：开着的广告后台里认出的账户，领活时顺手报上去（配置卡方案用）
      seenAccounts: seenAdsAccounts,
      control,
      now: deps.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    }).catch(() => undefined)
  chrome.alarms.create(ADS_ALARM, { periodInMinutes: ADS_PERIOD_MINUTES })
  // WP328：Reddit 只读（每日巡查）——借这个 Chrome 里已登录的会话读，只读、不改已读
  const redditControl = { stop: false }
  const pollReddit = (): Promise<unknown> =>
    pollRedditOnce({
      store: deps.store,
      perms,
      readFetch: () => sessionFetch(backgroundFetch(), chromeRedditTabs()),
      now: deps.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      control: redditControl,
    }).catch(() => undefined)
  chrome.alarms.create(REDDIT_ALARM, { periodInMinutes: REDDIT_PERIOD_MINUTES })

  // WP345：跟着工坊更新（起来时先问一次：刚重载完的这一刻就把新版本号报上去）
  const checkUpdate = (): Promise<unknown> =>
    checkForUpdate({
      store: deps.store,
      running: runningVersion(chrome.runtime.getManifest()),
      reload: () => chrome.runtime.reload(),
      now: deps.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    }).catch(() => undefined)
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: UPDATE_PERIOD_MINUTES })
  void checkUpdate()

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === UPDATE_ALARM) {
      void checkUpdate()
      void badge()
      // WP467：侧边栏关着时也每分钟看一眼原帖页（人自己发出去的照样记）
      void sentWatcher.tick().catch(() => undefined)
      return
    }
    if (alarm.name === ADS_ALARM) {
      void pollAds()
      return
    }
    if (alarm.name === REDDIT_ALARM) {
      void pollReddit()
      return
    }
    if (alarm.name !== FLUSH_ALARM) return
    void flush(deps).finally(() => {
      void badge()
    })
  })
  // 用户在设置页里给了 / 收回了广告后台的权限：马上问一次
  chrome.permissions.onAdded.addListener(() => {
    void pollAds()
    void pollReddit()
  })

  // 工具栏图标：没有 popup。WP413：三个红人平台上照旧开 / 关页面上那块面板；别的页面打开侧边栏
  // （进度 / 要你处理 / 记录）。WP313：执行器正在等截图授权时，这一下就是授权。
  chrome.action.onClicked.addListener((tab) => {
    onActionClick(tab, {
      noteActionClick,
      togglePanel: (id) => chrome.tabs.sendMessage(id, { type: 'toggle-panel' }),
      // 必须在点击回调里同步调（只认用户手势）
      openSidePanel: (windowId) => chrome.sidePanel.open({ windowId }),
      openOptions: () => {
        void chrome.runtime.openOptionsPage().catch(() => undefined)
      },
    })
  })
  // WP467：人自己在原帖页上发出去的，认出来就记（只读页面，不点任何东西）
  const sentWatcher = new SentWatcher({
    store: deps.store,
    now: () => Date.now(),
    read: (url) => sessionFetch(backgroundFetch(), chromeRedditTabs())(url),
    page: {
      tabs: async () =>
        (await chrome.tabs.query({ url: 'https://www.reddit.com/*', status: 'complete' }))
          .filter((t) => t.id !== undefined && t.url !== undefined)
          .map((t) => ({ id: t.id as number, url: t.url as string })),
      find: async (tabId, selector, body, text, author) => {
        await chrome.scripting.executeScript({ target: { tabId }, files: [ADS_CONTENT_SCRIPT] })
        const out = (await chrome.tabs.sendMessage(tabId, {
          type: 'ads-dom',
          op: 'find-posted',
          selector,
          body,
          text,
          ...(author === undefined ? {} : { author }),
        })) as AdsDomResponse
        return Array.isArray(out) ? out : []
      },
    },
  })
  // Reddit 标签页刚加载完（人发完评论 Reddit 有时会刷新那一页）：看一眼
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (info.status === 'complete' && (tab.url ?? '').startsWith('https://www.reddit.com/'))
      void sentWatcher.tick().catch(() => undefined)
  })

  // WP413：侧边栏要的那几件（看 / 填进页面 / 不发 / 再填一次），填完马上去领活
  // WP432：人在侧边栏里点了「打开这一条」——在那个窗口新开标签页、填好、等人点发送（同一时刻只开一条）
  let sideRunning = false
  registerBusy('side', () => sideRunning)
  const panelDeps: PanelBrokerDeps = {
    store: deps.store,
    perms,
    pollNow: () => {
      void pollAds()
    },
    busy: () => sideRunning,
    runJob: async (raw, windowId) => {
      if (raw.plan.platform !== 'reddit') return { ok: false, message: '这一条不在这里打开。' }
      // WP467：写路径里不开 old.reddit（WP445 之前排进队的老活换成 www）
      const job = redditJobOnWww(raw)
      const s = await readSettings(deps.store)
      if (s.token === undefined) return { ok: false, message: '还没配对。' }
      const tab = await openRedditTab(job, windowId).catch(() => ({
        why: '没能打开 Reddit 那个标签页。',
      }))
      const client = { port: s.port, token: s.token }
      if ('why' in tab) {
        await actionResult(client, job.id, {
          outcome: 'handover',
          message: tab.why,
          step: 0,
          reads: {},
        })
        return { ok: false, message: tab.why }
      }
      sideRunning = true
      control.stop = false
      control.answer = undefined
      void executeJob(job, {
        client,
        driver: tab,
        control,
        now: deps.now,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      })
        .catch(() => undefined)
        .finally(() => {
          sideRunning = false
          void badge()
        })
      void badge()
      return { ok: true }
    },
  }

  chrome.runtime.onMessage.addListener(
    (message: ExtensionMessage, _sender, reply: (response: ExtensionResponse) => void): boolean => {
      void (async () => {
        switch (message.type) {
          case 'status':
            reply({ type: 'status', status: await status(deps) })
            return
          case 'observe':
            reply({ type: 'observe', outcome: await observe(deps, message.observations) })
            return
          case 'pair': {
            const out = await pair(deps, message.code)
            // WP345：配上就把版本报一次（连接卡上马上看得到）
            if (out.ok) void checkUpdate()
            void badge()
            reply({ type: 'pair', ...out, status: await status(deps) })
            return
          }
          case 'set-port':
            await writeSettings(deps.store, { port: message.port })
            reply({ type: 'status', status: await status(deps) })
            return
          case 'unpair':
            await unpair(deps)
            void badge()
            reply({ type: 'status', status: await status(deps) })
            return
          case 'clear-queue':
            await clearQueue(deps.store)
            reply({ type: 'status', status: await status(deps) })
            return
          case 'ads-status':
            reply({ type: 'ads-status', ads: await adsPanelStatus({ store: deps.store, perms }) })
            return
          case 'ads-consent': {
            const out = await recordAdsConsent(
              { store: deps.store, perms },
              message.platform,
              message.text_version,
            )
            if (out.ok) void pollAds()
            reply({
              type: 'ads-consent',
              ...out,
              ads: await adsPanelStatus({ store: deps.store, perms }),
            })
            return
          }
          case 'ads-poll':
            void pollAds()
            reply({ type: 'ack' })
            return
          case 'reddit-status': {
            const st = await readRedditStatus(deps.store)
            reply({
              type: 'reddit-status',
              reddit: {
                paired: (await readSettings(deps.store)).token !== undefined,
                connected: await redditConnected(perms),
                last_poll_at: st.last_poll_at,
                note: st.note,
                user: st.user,
                last_result: st.last_result,
              },
            })
            return
          }
          case 'reddit-poll':
            // 断开 / 刚连上：不等半小时，马上告诉本机
            {
              const { last_poll_at: _drop, ...rest } = await readRedditStatus(deps.store)
              await deps.store.set({ [REDDIT_STATUS_KEY]: rest })
            }
            void pollReddit()
            reply({ type: 'ack' })
            return
          case 'update-check':
            void checkUpdate()
            reply({ type: 'ack' })
            return
          case 'panel-state': {
            const state = await panelState(panelDeps)
            // WP432：侧边栏刷新时顺手对一下图标上的数字
            if (state.kind === 'ok') {
              void refreshWaiting(
                { store: deps.store, action: chrome.action, notify: () => undefined },
                state.snapshot,
              ).catch(() => undefined)
              // WP467：侧边栏开着时每次刷新顺手看一眼原帖页
              void sentWatcher.tick(state.snapshot).catch(() => undefined)
            }
            reply({ type: 'panel-state', state })
            return
          }
          case 'panel-fill': {
            const { type: _t, id, windowId, ...input } = message
            reply({ type: 'panel-act', ...(await panelFillCard(panelDeps, id, input, windowId)) })
            return
          }
          case 'panel-open': {
            const { job, windowId, text, title } = message
            reply({
              type: 'panel-act',
              ...(await panelOpenWrite(
                panelDeps,
                job,
                {
                  ...(text === undefined ? {} : { text }),
                  ...(title === undefined ? {} : { title }),
                },
                windowId,
              )),
            })
            void badge()
            return
          }
          case 'panel-drop':
            reply({
              type: 'panel-act',
              ...(await panelDropWrite(panelDeps, message.job, message.reason)),
            })
            void badge()
            return
          case 'panel-skip':
            reply({
              type: 'panel-act',
              ...(await panelSkipCard(panelDeps, message.id, message.version, message.reason)),
            })
            void badge()
            return
          case 'panel-follow-undo':
            reply({
              type: 'panel-act',
              ...(await panelUndoFollow(panelDeps, message.leader, message.ids)),
            })
            void badge()
            return
          case 'panel-sent': {
            // WP467：「我发了，帮我记一下」——贴链接 / 认最近一条
            const out = await sentWatcher.manual(
              {
                ...(message.job === undefined ? {} : { job: message.job }),
                ...(message.card === undefined ? {} : { card: message.card }),
              },
              message.how,
              message.link,
            )
            reply({ type: 'panel-act', ...out })
            void badge()
            return
          }
          case 'panel-refill':
            reply({ type: 'panel-act', ...(await panelRefillWrite(panelDeps, message.job)) })
            return
          case 'open-options':
            void chrome.runtime.openOptionsPage().catch(() => undefined)
            reply({ type: 'ack' })
            return
          case 'open-social-compose':
            // WP419：只开那几家的发帖页；插件不在页面上点任何东西（发布永远人点）
            if (composeUrlAllowed(message.url))
              void chrome.tabs.create({ url: message.url, active: true }).catch(() => undefined)
            reply({ type: 'ack' })
            return
          case 'panel-post-done':
            reply({
              type: 'panel-act',
              ...(await panelAnswerPost(panelDeps, message.id, 'done', {
                ...(message.link === undefined ? {} : { link: message.link }),
              })),
            })
            return
          case 'panel-post-skip':
            reply({
              type: 'panel-act',
              ...(await panelAnswerPost(panelDeps, message.id, 'skip', {
                ...(message.reason === undefined ? {} : { reason: message.reason }),
              })),
            })
            return
          case 'open-workshop-card': {
            // WP419：只拼本机回环地址的 /cards/<id>（id 认不出就不开）
            const url = workshopCardUrl((await readSettings(deps.store)).port, message.id)
            if (url !== undefined)
              void chrome.tabs.create({ url, active: true }).catch(() => undefined)
            reply({ type: 'ack' })
            return
          }
          case 'ads-stop':
            control.stop = true
            reply({ type: 'ack' })
            return
          case 'ads-confirm':
            control.answer = message.answer
            reply({ type: 'ack' })
            return
          default:
            reply({ type: 'ack' })
        }
      })()
      // 必须 return true：上面是异步回复，不这么写通道会被当场关掉。
      return true
    },
  )
})
