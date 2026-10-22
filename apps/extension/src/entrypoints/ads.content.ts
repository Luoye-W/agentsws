/**
 * 广告后台页面里的那一半（WP313）：只做「手」和顶上那条横条。
 *
 * **运行时注册，不进清单**（`registration: 'runtime'`、不写 `matches`）：两家后台是可选权限，
 * 用户点「连接」之前插件根本进不了那两个站；连上之后也只在执行一件活时由执行器放进那个标签页。
 * 判断（白名单、指纹、不碰的区域、被拦就停）一条都不在这里，全在 service worker 的执行器里。
 */

import { defineContentScript } from 'wxt/utils/define-content-script'
import { renderBanner } from '@/lib/ads/banner'
import {
  type AdsBannerEvent,
  type AdsBannerRequest,
  type AdsDomRequest,
  handleDomRequest,
} from '@/lib/ads/dom-messages'

const FLAG = '__agentswsAdsHand'

export default defineContentScript({
  registration: 'runtime',
  main() {
    // 同一页被放进来好几次（每一步都会放一次）：只挂一次监听
    const w = window as unknown as Record<string, boolean>
    if (w[FLAG] === true) return
    w[FLAG] = true

    const tell = (event: AdsBannerEvent): void => {
      void chrome.runtime.sendMessage(event).catch(() => {})
    }

    chrome.runtime.onMessage.addListener(
      (message: AdsDomRequest | AdsBannerRequest, _sender, reply: (r: unknown) => void) => {
        if (message.type === 'ads-dom') {
          // WP467：填框要等编辑器一拍——异步回（return true 让通道等着）
          const fail = (err: unknown) =>
            reply({ ok: false, why: err instanceof Error ? err.message : String(err) })
          try {
            void Promise.resolve(handleDomRequest(document, location.href, message)).then(
              reply,
              fail,
            )
          } catch (err) {
            fail(err)
          }
          return true
        }
        if (message.type === 'ads-banner') {
          renderBanner(document, message.state, {
            onStop: () => tell({ type: 'ads-stop' }),
            onConfirm: (answer) => tell({ type: 'ads-confirm', answer }),
          })
          reply(true)
          return false
        }
        return false
      },
    )
  },
})
