import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { defineConfig } from 'wxt'
import { EXTENSION_PUBLIC_KEY } from './src/lib/identity'

// WP345（决策 871）：固定扩展 id 的公钥，说明见 src/lib/identity.ts
/**
 * WP345：版本号跟工坊走。桌面打包（`apps/desktop/scripts/dist.mjs`）构建插件时给 `AGENTSWS_EXTENSION_VERSION`
 * = 这一包工坊的版本（`0.2.0-beta.8`）；Chrome 的 `version` 只认数字，WXT 自动拆成 `version`（0.2.0）+
 * `version_name`（完整那串）。插件与工坊比对用的是 `version_name`。不给就照旧取 package.json。
 */
const releaseVersion = process.env.AGENTSWS_EXTENSION_VERSION?.trim()

/**
 * 「Agents 工坊助手」的 MV3 清单（WP119 / 68；WP313 / 决策 551 改名：红人与广告都是它的功能）。
 *
 * **为什么是 WXT 不是 Plasmo**：这个仓库的工作台已经是 Vite 7 + React 19 +
 * Tailwind v4，WXT 本身就是一层 Vite 插件——同一套 `vite.config` 概念、同一个
 * `@tailwindcss/vite`、同一份 `@vitejs/plugin-react`，连 vitest 都能直接复用。
 * Plasmo 自带 Parcel 那一套构建，等于在这个仓里再养第二条工具链。
 *
 * 权限上的五条，每一条都是审核时会被问到的：
 *
 * 1. `host_permissions` 只有三个平台 + `http://127.0.0.1/*`。没有 `<all_urls>`、
 *    没有 `tabs`、没有 `history`、没有 `webRequest`——插件读不到你在别处开了什么。
 * 2. `activeTab` 而不是全局注入：content script 只在那三个域名的页面上跑，
 *    而且**页面上不点按钮就一个字段都不解析**（解析函数由用户动作触发）。
 * 3. `storage` 只用来放三样东西：本机服务端口、配对得来的插件令牌、
 *    桌面应用没开时排队的观测。三样都在设置页看得见、清得掉。
 * 4. 没有 `content_security_policy` 的放宽项：不远程加载任何脚本。
 * 5. WP313（广告）：Google 广告 / Meta 广告后台与 `downloads` 都是**可选权限**——装插件、升级插件都
 *    不要，用户在设置页点「连接」时才弹窗申请；`scripting` 只用来把执行器的「手」放进已经授权的
 *    那个后台标签页（没有站点权限它什么页面都进不去）。截图用 `captureVisibleTab`，只截正在
 *    执行的那个后台标签页。
 * 6. WP328（Reddit）：`old.reddit.com` / `www.reddit.com` 也是可选权限，设置页点「连接 Reddit」才申请；
 *    只用来借你已登录的会话读品牌号自己的收件箱与自家版块的 `.json`（只读、不改已读）。
 * 7. WP413（侧边栏）：`sidePanel` 由 WXT 按 `entrypoints/sidepanel/` 自动加进清单（`side_panel.default_path`），
 *    这个权限没有任何安装提示；侧边栏页面和设置页一样只跟本插件的后台说话，后台只打 `127.0.0.1`。
 * 8. WP432：`notifications`——批过的 Reddit 回复等你在侧边栏里发时弹一句（工坊设置 → 通知「等你发」可关）；
 *    已解压插件重载后直接生效、不弹窗。
 */
export default defineConfig({
  // WXT 把 `@` 指向 srcDir，所以 srcDir 就是 `src/`——这样 `@/lib/*`、`@/ui/*`
  // 与 `tsconfig.json` 的 paths、工作台那边的写法完全一致，不用再配一遍 alias。
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  /**
   * WP456-T7：构建前先从工作台的 `index.css` 重出插件的令牌（`src/ui/tokens.css`），插件和工作台永远是同一套数。
   * `wxt build`（含桌面打包直接调 wxt 那一路）与 `wxt` 开发都会先走这一步；脚本不改动就不写文件。
   */
  hooks: {
    'build:before': (wxt) => {
      execFileSync(
        process.execPath,
        [join(wxt.config.root, '..', '..', 'scripts', 'gen-extension-tokens.mjs')],
        { stdio: 'inherit' },
      )
    },
  },
  outDir: 'build',
  manifest: {
    name: 'Agents 工坊助手',
    key: EXTENSION_PUBLIC_KEY,
    ...(releaseVersion === undefined || releaseVersion === ''
      ? {}
      : { version_name: releaseVersion }),
    short_name: '工坊助手',
    description:
      '在 YouTube / Instagram / TikTok 页面上即时体检红人、一键收进本机红人库；连接广告后台后，替你执行批过的广告动作；连接 Reddit 后，在侧边栏里打开批过的回复，插件填好、由你自己点发送。',
    // 没有 `default_locale`：这一版只有中文，而声明了 `default_locale` 就必须带
    // `_locales/<lang>/messages.json`，否则 Chrome 连装都装不上。
    // `alarms` 是给「应用刚打开，把排着的补上去」那个 5 分钟定时用的；
    // 没有它 service worker 一被回收，队列就要等用户下次点按钮才动。
    permissions: ['storage', 'activeTab', 'alarms', 'scripting', 'notifications'],
    // WP313：连接时才申请（见上面第 5 条）
    optional_permissions: ['downloads'],
    optional_host_permissions: [
      'https://ads.google.com/*',
      'https://adsmanager.facebook.com/*',
      'https://business.facebook.com/*',
      // WP328：Reddit（读品牌号自己的收件箱与自家版块；WP329 填草稿也用这两个）
      'https://old.reddit.com/*',
      'https://www.reddit.com/*',
    ],
    host_permissions: [
      'https://*.youtube.com/*',
      'https://*.instagram.com/*',
      'https://*.tiktok.com/*',
      // 本机服务。只有回环——插件不认识任何其它 http 目标。
      'http://127.0.0.1/*',
    ],
    // `action` **没有** popup：三个红人平台上按一下工具栏图标是开 / 关页面上那块面板
    // （用户要一边看那个人的主页一边看体检结果，弹窗挡着就白做了）；别的页面打开侧边栏（WP413）。
    // 有 popup 的话 `chrome.action.onClicked` 根本不会触发。
    action: { default_title: 'Agents 工坊助手' },
    // 设置页开在新标签里：那一页除了配对还有整段隐私说明，塞进小弹窗读不了。
    options_ui: { open_in_tab: true },
  },
  // 安装包文件名不跟着改名：内测用户与教程里认的是这个名字（改不改列进 WP313 报告）
  zip: { name: 'agentsws-influencer-assistant' },
})
