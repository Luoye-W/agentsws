/**
 * service worker：**插件里唯一一个能上网的地方**（WP119 定论 2）。
 *
 * 它只会打一个地方：`http://127.0.0.1:<端口>`。content script 发过来的消息里
 * 没有 URL 这一格，所以「让这个插件去打别的服务器」这件事在协议层就没有入口。
 *
 * 另外两件它管的事：
 * - 工具栏图标被按了 → 让当前页面开 / 关那块面板（插件没有 popup 窗口，
 *   面板长在页面上，因为用户要一边看那个人的主页一边看体检结果）；别的页面上打开设置页（WP409）；
 *   图标角标跟着配对状态（配上了绿勾，WP409）；
 * - 每隔一会儿把排着的观测补上去（桌面应用可能是刚刚才打开的）。
 * - WP313：广告动作通道——连上了广告后台（可选权限）才每分钟问一次本机「有没有批好的活」，
 *   问到了就在看得见的广告后台标签页上做；页面顶上的横条点了停止 / 确认，消息回到这里。
 * - WP345：跟着工坊更新——每分钟（和起来时）问一次本机「插件文件夹里是哪一版」，不一样就等空闲后自己重载。
 */

import { defineBackground } from 'wxt/utils/define-background'
import { adsPanelStatus, recordAdsConsent } from '@/lib/ads/broker'
import { noteActionClick } from '@/lib/ads/capture-grant'
import type { RunControl } from '@/lib/ads/executor'
import { openAdsTab, seenAdsAccounts } from '@/lib/ads/open-tab'
import { chromePermissions } from '@/lib/ads/permissions'
import { pollAdsOnce } from '@/lib/ads/poller'
import { syncPairedBadge } from '@/lib/badge'
import type { BrokerDeps } from '@/lib/broker'
import { flush, observe, pair, status, unpair } from '@/lib/broker'
import type { ExtensionMessage, ExtensionResponse } from '@/lib/messages'
import { backgroundFetch, chromeRedditTabs, sessionFetch } from '@/lib/reddit/fetcher'
import { redditConnected } from '@/lib/reddit/permissions'
import { pollRedditOnce, REDDIT_STATUS_KEY, readRedditStatus } from '@/lib/reddit/poller'
import { checkForUpdate, runningVersion } from '@/lib/self-update'
import { chromeStore, clearQueue, readSettings, writeSettings } from '@/lib/storage'

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
  // WP409：图标角标跟着配对状态走（配上了绿勾）——起来时、配上 / 解除时、每次补传时各对一次
  const badge = (): Promise<unknown> =>
    readSettings(deps.store)
      .then((s) => syncPairedBadge(chrome.action, s.token !== undefined))
      .catch(() => undefined)
  void badge()
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

  // 工具栏图标：没有 popup，按一下是让页面上那块面板开 / 关。
  chrome.action.onClicked.addListener((tab) => {
    // WP409（内测 10-18 #4）：不是三个平台的页面（没有 content script 在听）以前是静默——用户第一反应就是点图标，
    // 以为插件坏了。现在打开设置页（配对、连 Reddit 都在那儿）。完整的侧边栏另见 R1。
    const openOptions = (): void => {
      void chrome.runtime.openOptionsPage().catch(() => undefined)
    }
    if (tab.id === undefined) {
      openOptions()
      return
    }
    // WP313：执行器正在这个标签页上等截图授权——这一下点击就是授权（activeTab），不开红人面板
    if (noteActionClick(tab.id)) return
    chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' }).catch(openOptions)
  })

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
