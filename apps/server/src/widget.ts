/**
 * 网站聊天窗的嵌入脚本（48 §4 L3 #11 的云端那一半，WP60）。
 *
 * 商家往自己网站里贴一行：
 *
 * ```html
 * <script src="https://cloud.agentsws.com/w/ws_x/widget.js" async></script>
 * ```
 *
 * 四条硬约束，逐条写在代码里：
 *
 * 1. **无框架、无依赖、无构建**。它跑在别人的网站上——那里可能已经有 React 17、
 *    jQuery 1.x、一个把 `Array.prototype` 改过的旧库。带进去任何一个依赖，
 *    就是在别人家里和别人的版本打架。
 * 2. **不污染宿主页面**。样式全部内联在自己那几个节点上，类名带前缀；
 *    不注册全局变量（除了一个可选的 `window.agentswsChat` 供商家手动开关）。
 * 3. **凭据不进 URL**。SSE 走 `fetch` + `ReadableStream` 自己解析，
 *    而不是 `EventSource`——后者塞不进 `Authorization` 头，只能把令牌挂在查询串上，
 *    而查询串会进浏览器历史、反代日志与 Referer（20 §3 / 21 §5）。
 * 4. **访客说的话只发给这一个端点**。没有第三方统计、没有 beacon、没有 cookie。
 *
 * 脚本本体写成一个常量而不是一个 `.js` 资源文件：这样它跟着 `tsc` 一起进
 * `dist/`，不需要在打包脚本里多一条"记得把 assets 拷过去"（那条迟早会被忘掉）。
 */
import type { Env, Hono } from 'hono'

/** 嵌入脚本的路径。公网地址 = `https://<云>/w/<ws>/widget.js`。 */
export const WIDGET_PATH = '/widget.js'

/** 网关里那一条（进 OpenAPI 与 SDK）。 */
export const WIDGET_API_PATH = '/v1/chat/widget.js'

/**
 * 嵌入脚本。
 *
 * 读自己 `<script>` 标签的 `src` 定出服务端地址——商家贴的那一行里已经有了
 * 工作区，不必再让他填第二遍（填两遍就会有一遍是错的）。
 */
export const CHAT_WIDGET_JS = String.raw`(function () {
  'use strict'
  var current = document.currentScript
  if (!current) return
  // 脚本地址就是服务端地址：.../w/<ws>/widget.js → .../w/<ws>
  var base = current.src.replace(/\/widget\.js(\?.*)?$/, '')
  var store = 'agentsws.chat.' + base
  var NS = 'agentsws-chat'

  /*
   * 界面上那几个词跟着**宿主页面的语言**走（<html lang>），不跟着服务端配置走。
   * 理由很实际：这个气泡是长在商家网站上的一块，它该说那个网站的语言；
   * 而招呼语是商家自己写的（配置里那条），那是内容，不是界面。
   */
  var zh = (document.documentElement.lang || 'zh').toLowerCase().indexOf('zh') === 0
  var TXT = zh
    ? { title: '在线客服', send: '发送', tooFast: '发得有点快，稍等一下再说。', offline: '网络好像断了，稍后再试。' }
    : {
        title: 'Chat with us',
        send: 'Send',
        tooFast: 'A bit too fast — give it a second.',
        offline: 'Looks like the network dropped. Try again in a moment.',
      }

  function saved() {
    try {
      var raw = localStorage.getItem(store)
      return raw ? JSON.parse(raw) : null
    } catch (e) {
      return null
    }
  }
  function save(v) {
    try {
      localStorage.setItem(store, JSON.stringify(v))
    } catch (e) {
      /* 无痕模式：这一次就不记了 */
    }
  }

  function api(path, options) {
    var init = options || {}
    init.credentials = 'omit'
    init.mode = 'cors'
    return fetch(base + path, init)
  }

  var cfg = null
  var session = saved()
  var root = null
  var list = null
  var input = null
  var open = false
  var reader = null

  function el(tag, style, text) {
    var node = document.createElement(tag)
    node.style.cssText = style
    if (text !== undefined) node.textContent = text
    return node
  }

  function bubbleStyle(mine) {
    return (
      'max-width:78%;margin:4px 0;padding:8px 11px;border-radius:12px;font-size:14px;' +
      'line-height:1.5;word-break:break-word;white-space:pre-wrap;' +
      (mine
        ? 'align-self:flex-end;background:' + cfg.accent + ';color:#fff;'
        : 'align-self:flex-start;background:#f1f2f4;color:#16181d;')
    )
  }

  function say(text, mine) {
    if (!list) return
    var node = el('div', bubbleStyle(mine), text)
    node.className = NS + '-msg'
    list.appendChild(node)
    list.scrollTop = list.scrollHeight
  }

  function render() {
    root = el(
      'div',
      'position:fixed;right:20px;bottom:20px;z-index:2147483000;font-family:' +
        '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,' +
        '"PingFang SC","Microsoft YaHei",sans-serif;',
    )
    root.className = NS

    var panel = el(
      'div',
      'display:none;flex-direction:column;width:340px;height:460px;background:#fff;' +
        'border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.18);overflow:hidden;' +
        'margin-bottom:12px;border:1px solid rgba(0,0,0,.06);',
    )
    panel.className = NS + '-panel'

    var head = el(
      'div',
      'padding:12px 14px;background:' + cfg.accent + ';color:#fff;font-size:14px;font-weight:600;',
      TXT.title,
    )
    panel.appendChild(head)

    list = el(
      'div',
      'flex:1;display:flex;flex-direction:column;overflow-y:auto;padding:12px 14px;background:#fff;',
    )
    panel.appendChild(list)

    var bar = el('div', 'display:flex;gap:8px;padding:10px;border-top:1px solid #eceef1;')
    input = el(
      'textarea',
      'flex:1;resize:none;border:1px solid #dfe2e6;border-radius:9px;padding:8px 10px;' +
        'font:inherit;font-size:14px;height:38px;outline:none;color:#16181d;background:#fff;',
    )
    input.setAttribute('rows', '1')
    input.setAttribute('aria-label', TXT.title)
    var send = el(
      'button',
      'border:0;border-radius:9px;padding:0 14px;background:' +
        cfg.accent +
        ';color:#fff;font:inherit;font-size:14px;cursor:pointer;',
      TXT.send,
    )
    bar.appendChild(input)
    bar.appendChild(send)
    panel.appendChild(bar)

    var launcher = el(
      'button',
      'width:56px;height:56px;border-radius:28px;border:0;cursor:pointer;background:' +
        cfg.accent +
        ';color:#fff;font-size:24px;box-shadow:0 6px 20px rgba(0,0,0,.22);float:right;',
      '💬',
    )
    launcher.setAttribute('aria-label', TXT.title)

    root.appendChild(panel)
    root.appendChild(launcher)
    document.body.appendChild(root)

    launcher.addEventListener('click', function () {
      open = !open
      panel.style.display = open ? 'flex' : 'none'
      launcher.textContent = open ? '×' : '💬'
      if (open) start()
    })
    send.addEventListener('click', submit)
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        submit()
      }
    })
  }

  function start() {
    if (list && list.childElementCount === 0 && cfg.greeting) say(cfg.greeting, false)
    if (session) return listen()
    api('/v1/chat/public/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
      .then(function (r) {
        return r.ok ? r.json() : null
      })
      .then(function (body) {
        if (!body || !body.data) return
        session = { id: body.data.session_id, token: body.data.visitor_token }
        save(session)
        listen()
      })
      .catch(function () {
        /* 网络不通：不在别人的网站上弹任何东西 */
      })
  }

  function submit() {
    var text = (input.value || '').trim()
    if (!text || !session) return
    input.value = ''
    say(text, true)
    api('/v1/chat/public/sessions/' + encodeURIComponent(session.id) + '/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 凭据进头不进 URL（20 §3 / 21 §5）
        authorization: 'Bearer ' + session.token,
      },
      body: JSON.stringify({ text: text }),
    })
      .then(function (r) {
        if (r.status === 429) say(TXT.tooFast, false)
        else if (r.status === 401 || r.status === 404) {
          // 会话没了（服务端换过 / 被清过）：下一句重开一条
          session = null
          save(null)
        }
      })
      .catch(function () {
        say(TXT.offline, false)
      })
  }

  // SSE 自己解析：fetch 能带 Authorization 头，浏览器内建的那个流式 API 不能
  function listen() {
    if (reader || !session) return
    api('/v1/chat/public/sessions/' + encodeURIComponent(session.id) + '/stream', {
      headers: { authorization: 'Bearer ' + session.token },
    })
      .then(function (res) {
        if (!res.ok || !res.body) return
        reader = res.body.getReader()
        var decoder = new TextDecoder()
        var buffer = ''
        function pump() {
          return reader.read().then(function (chunk) {
            if (chunk.done) {
              reader = null
              return
            }
            buffer += decoder.decode(chunk.value, { stream: true })
            var parts = buffer.split('\n\n')
            buffer = parts.pop() || ''
            for (var i = 0; i < parts.length; i++) frame(parts[i])
            return pump()
          })
        }
        return pump()
      })
      .catch(function () {
        reader = null
      })
  }

  function frame(block) {
    var lines = block.split('\n')
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      if (line.indexOf('data: ') !== 0) continue
      var payload = null
      try {
        payload = JSON.parse(line.slice(6))
      } catch (e) {
        continue
      }
      // 访客只看 agent 说的话。plan / 内部状态一律不推到这里（服务端已经过滤）
      if (payload && payload.type === 'message' && payload.message && payload.message.role !== 'visitor')
        say(payload.message.text, false)
    }
  }

  api('/v1/chat/widget-config')
    .then(function (r) {
      return r.ok ? r.json() : null
    })
    .then(function (body) {
      var data = body && body.data ? body.data : null
      if (!data || !data.enabled) return
      cfg = data
      if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', render)
      else render()
      window.agentswsChat = {
        open: function () {
          var launcher = root && root.querySelector('button')
          if (launcher) launcher.click()
        },
      }
    })
    .catch(function () {
      /* 这家店没开聊天窗，或者网络不通：什么都不做 */
    })
})()
`

/**
 * 把 `/widget.js` 挂到服务进程的 Hono 应用上（网关路由之后、静态托管之前）。
 *
 * 为什么不走 `RouteSpec`：它不是一条 API，是一个**资源**——`/v1` 之下那套
 * 信封、鉴权、幂等对一段 JavaScript 没有意义。顺手把这几条公开路由的
 * CORS 预检（`OPTIONS`）也挂在这里：`RouteSpec` 的方法表里没有 `options`，
 * 为了一次预检去改契约的方法联合，代价比在这里多两行大。
 */
export function mountChatWidget<E extends Env>(
  app: Hono<E>,
  deps: { allowedOrigin: (origin: string | undefined) => string | undefined },
): void {
  const serve = (): Response =>
    new Response(CHAT_WIDGET_JS, {
      status: 200,
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        // 商家网站上的每个访客都会拉它一次；改了主色要等最多 5 分钟生效
        'cache-control': 'public, max-age=300',
        // 脚本本身谁都能拉（它是公开资源）；能不能建会话由 Origin 白名单说了算
        'access-control-allow-origin': '*',
      },
    })

  app.get(WIDGET_PATH, () => serve())

  app.on('OPTIONS', ['/v1/chat/public/*', '/v1/chat/widget-config'], (c) => {
    const origin = deps.allowedOrigin(c.req.header('Origin'))
    if (origin === undefined) return new Response(null, { status: 403 })
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization',
        'access-control-max-age': '600',
        vary: 'Origin',
      },
    })
  })
}
