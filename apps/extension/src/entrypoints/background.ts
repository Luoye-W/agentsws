/**
 * service worker：**插件里唯一一个能上网的地方**（WP119 定论 2）。
 *
 * 它只会打一个地方：`http://127.0.0.1:<端口>`。content script 发过来的消息里
 * 没有 URL 这一格，所以「让这个插件去打别的服务器」这件事在协议层就没有入口。
 *
 * 另外两件它管的事：
 * - 工具栏图标被按了 → 让当前页面开 / 关那块面板（插件没有 popup 窗口，
 *   面板长在页面上，因为用户要一边看那个人的主页一边看体检结果）；
 * - 每隔一会儿把排着的观测补上去（桌面应用可能是刚刚才打开的）。
 * - WP313：广告动作通道——连上了广告后台（可选权限）才每分钟问一次本机「有没有批好的活」，
 *   问到了就在看得见的广告后台标签页上做；页面顶上的横条点了停止 / 确认，消息回到这里。
 */

import { defineBackground } from 'wxt/utils/define-background'
import { adsPanelStatus, recordAdsConsent } from '@/lib/ads/broker'
import { noteActionClick } from '@/lib/ads/capture-grant'
import type { RunControl } from '@/lib/ads/executor'
import { openAdsTab } from '@/lib/ads/open-tab'
import { chromePermissions } from '@/lib/ads/permissions'
import { pollAdsOnce } from '@/lib/ads/poller'
import type { BrokerDeps } from '@/lib/broker'
import { flush, observe, pair, status, unpair } from '@/lib/broker'
import type { ExtensionMessage, ExtensionResponse } from '@/lib/messages'
import { chromeStore, clearQueue, writeSettings } from '@/lib/storage'

/** 多久试一次补传。5 分钟：够快，也不至于在应用没开时一直空打。 */
const FLUSH_ALARM = 'agentsws-flush'
const FLUSH_PERIOD_MINUTES = 5
/** WP313：多久问一次有没有批好的广告活（每次最多挂 25 秒）。 */
const ADS_ALARM = 'agentsws-ads-poll'
const ADS_PERIOD_MINUTES = 1

export default defineBackground(() => {
  const deps: BrokerDeps = { store: chromeStore(), now: () => new Date().toISOString() }

  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_PERIOD_MINUTES })
  // WP313：广告动作通道
  const perms = chromePermissions()
  const control: RunControl = { stop: false }
  const pollAds = (): Promise<unknown> =>
    pollAdsOnce({
      store: deps.store,
      perms,
      openTab: openAdsTab,
      control,
      now: deps.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    }).catch(() => undefined)
  chrome.alarms.create(ADS_ALARM, { periodInMinutes: ADS_PERIOD_MINUTES })

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ADS_ALARM) {
      void pollAds()
      return
    }
    if (alarm.name !== FLUSH_ALARM) return
    void flush(deps)
  })
  // 用户在设置页里给了 / 收回了广告后台的权限：马上问一次
  chrome.permissions.onAdded.addListener(() => void pollAds())

  // 工具栏图标：没有 popup，按一下是让页面上那块面板开 / 关。
  chrome.action.onClicked.addListener((tab) => {
    if (tab.id === undefined) return
    // WP313：执行器正在这个标签页上等截图授权——这一下点击就是授权（activeTab），不开红人面板
    if (noteActionClick(tab.id)) return
    chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' }).catch(() => {
      // 不是三个平台的页面 = 没有 content script 在听。静默。
    })
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
            reply({ type: 'pair', ...out, status: await status(deps) })
            return
          }
          case 'set-port':
            await writeSettings(deps.store, { port: message.port })
            reply({ type: 'status', status: await status(deps) })
            return
          case 'unpair':
            await unpair(deps)
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
