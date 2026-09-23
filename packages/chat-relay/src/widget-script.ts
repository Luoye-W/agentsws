/**
 * 网站聊天窗的嵌入脚本（一份脚本，三种部署）。
 *
 * 出处：整块移植自 `apps/server/src/widget.ts`（WP60，48 §4 L3 #11）的
 * `CHAT_WIDGET_JS`，WP124 起这里是**唯一真源**——`apps/server` 从这里 re-export，
 * 转发器（官方托管 / 自建 Docker / 自建 Worker）都从这里拿，改一处三处生效。
 * WP124 的增量：
 * 1. **离线留言表单**：转发器回「离线」（本机不在线 / 免费额度到顶拦新会话）时，
 *    挂件自动切留言表单（邮箱 + 问题，可选订单号），POST 到
 *    `/v1/chat/public/offline-messages` 暂存转发器；本机上线后拉走。
 * 2. **打字信号**：访客的输入只上报布尔（≤1 次 / 2 秒节流），请求体里没有、
 *    也不可能有输入框内容；服务端（转发器）强制拒绝带自由文本的打字事件。
 * 3. 收到转发器的 `typing` / `offline` 事件照常渲染（我方「正在输入」是三个点的
 *    纯动画，不带任何文字）。
 *
 * 四条硬约束（WP60 原文，逐条保持）：
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

/** 嵌入脚本的路径。公网地址 = `https://<转发器>/relay/<ws>/widget.js` 或本地 `/w/<ws>/widget.js`。 */
export const WIDGET_PATH = '/widget.js'

/** 网关里那一条（进 OpenAPI 与 SDK）。 */
export const WIDGET_API_PATH = '/v1/chat/widget.js'

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
  // 界面语言：默认跟宿主页 <html lang>；商家配置里选了 zh / en 就强制
  //（docs/72 §2.1 #8：挂件该说商家网站上的语言，招呼语是内容不是界面）
  var zh = (document.documentElement.lang || 'zh').toLowerCase().indexOf('zh') === 0
  var TXT = zh
    ? {
        title: '在线客服',
        send: '发送',
        tooFast: '发得有点快，稍等一下再说。',
        offline: '客服现在不在线，给我们留个话吧。',
        formEmail: '你的邮箱（必填）',
        formOrder: '订单号（选填）',
        formQuestion: '想问什么？',
        formSend: '留言',
        formDone: '已收到，我们会用邮件回复你。',
        formNeedEmail: '先填一个邮箱，我们才能回你。',
      }
    : {
        title: 'Chat with us',
        send: 'Send',
        tooFast: 'A bit too fast — give it a second.',
        offline: 'We are away right now — leave us a message.',
        formEmail: 'Your email (required)',
        formOrder: 'Order number (optional)',
        formQuestion: 'What is your question?',
        formSend: 'Send message',
        formDone: 'Got it — we will reply by email.',
        formNeedEmail: 'Please add an email so we can get back to you.',
      }
  function applyLanguage(cfgLang) {
    if (cfgLang !== 'zh' && cfgLang !== 'en') return
    zh = cfgLang === 'zh'
    TXT = zh
      ? {
          title: '在线客服',
          send: '发送',
          tooFast: '发得有点快，稍等一下再说。',
          offline: '客服现在不在线，给我们留个话吧。',
          formEmail: '你的邮箱（必填）',
          formOrder: '订单号（选填）',
          formQuestion: '想问什么？',
          formSend: '留言',
          formDone: '已收到，我们会用邮件回复你。',
          formNeedEmail: '先填一个邮箱，我们才能回你。',
        }
      : {
          title: 'Chat with us',
          send: 'Send',
          tooFast: 'A bit too fast — give it a second.',
          offline: 'We are away right now — leave us a message.',
          formEmail: 'Your email (required)',
          formOrder: 'Order number (optional)',
          formQuestion: 'What is your question?',
          formSend: 'Send message',
          formDone: 'Got it — we will reply by email.',
          formNeedEmail: 'Please add an email so we can get back to you.',
        }
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
    return node
  }

  /*
   * 我方「正在输入」：三个点的纯动画，**不带任何文字**。
   * 对面的打字事件只有布尔——服务端（转发器）强制拒绝带自由文本的载荷（FR-035），
   * 这里即使收到异常载荷也只当"在打字"看，不渲染任何内容。
   */
  var typingNode = null
  function showTyping(on) {
    if (!list) return
    if (on && !typingNode) {
      typingNode = el('div', bubbleStyle(false), '•••')
      typingNode.className = NS + '-typing'
      list.appendChild(typingNode)
      list.scrollTop = list.scrollHeight
    } else if (!on && typingNode) {
      typingNode.remove()
      typingNode = null
    }
  }

  /*
   * 打字信号：**只有布尔**，上报节流 ≤1 次 / 2 秒；停止判定 3 秒。
   * 请求体里没有输入框内容、没有字符数——隐私红线不依赖客户端自律，
   * 服务端还会再拒一次带自由文本的载荷。
   */
  var typingSentAt = 0
  var typingStopTimer = null
  function reportTyping(active) {
    if (!session) return
    var now = new Date().getTime()
    if (active && now - typingSentAt < 2000) return
    if (active) typingSentAt = now
    api('/v1/chat/public/sessions/' + encodeURIComponent(session.id) + '/typing', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + session.token,
      },
      body: JSON.stringify({ active: !!active }),
    }).catch(function () {})
  }

  /* 离线留言表单：邮箱必填、问题必填、订单号选填。出现在转发器回「离线」时。 */
  function showOfflineForm() {
    if (!list) return
    say(TXT.offline, false)
    var wrap = el('div', 'display:flex;flex-direction:column;gap:6px;margin:8px 0;')
    var email = el(
      'input',
      'border:1px solid #dfe2e6;border-radius:8px;padding:8px 10px;font:inherit;font-size:14px;color:#16181d;background:#fff;',
    )
    email.type = 'email'
    email.placeholder = TXT.formEmail
    var order = el(
      'input',
      'border:1px solid #dfe2e6;border-radius:8px;padding:8px 10px;font:inherit;font-size:14px;color:#16181d;background:#fff;',
    )
    order.placeholder = TXT.formOrder
    var question = el(
      'textarea',
      'border:1px solid #dfe2e6;border-radius:8px;padding:8px 10px;font:inherit;font-size:14px;color:#16181d;background:#fff;resize:none;height:70px;',
    )
    question.placeholder = TXT.formQuestion
    var go = el(
      'button',
      'border:0;border-radius:8px;padding:8px 0;background:' + cfg.accent + ';color:#fff;font:inherit;font-size:14px;cursor:pointer;',
      TXT.formSend,
    )
    go.addEventListener('click', function () {
      var mail = (email.value || '').trim()
      var text = (question.value || '').trim()
      if (!mail || mail.indexOf('@') < 0) {
        say(TXT.formNeedEmail, false)
        return
      }
      if (!text) return
      api('/v1/chat/public/offline-messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: mail,
          text: text,
          order_ref: (order.value || '').trim() || undefined,
          page: location.host + location.pathname,
        }),
      })
        .then(function (r) {
          if (r.status === 429) {
            say(TXT.tooFast, false)
            return
          }
          wrap.remove()
          say(TXT.formDone, false)
        })
        .catch(function () {
          say(TXT.offline, false)
        })
    })
    wrap.appendChild(email)
    wrap.appendChild(order)
    wrap.appendChild(question)
    wrap.appendChild(go)
    list.appendChild(wrap)
    list.scrollTop = list.scrollHeight
  }

  function render() {
    var side = cfg && cfg.position === 'left' ? 'left' : 'right'
    root = el(
      'div',
      'position:fixed;' + side + ':20px;bottom:20px;z-index:2147483000;font-family:' +
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

    var typingStop = null
    input.addEventListener('input', function () {
      reportTyping(true)
      if (typingStop) clearTimeout(typingStop)
      // 停止判定 3 秒：连续 3 秒无键击才判「停了」
      typingStop = setTimeout(function () {
        reportTyping(false)
      }, 3000)
    })

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
        } else if (r.ok) {
          // 只确认收到；回复从 SSE 那条流回来（FR-047，接收与投递解耦）。
          // 转发器回「离线」（本机不在线 / 免费额度到顶拦新会话）时切留言表单。
          return r
            .json()
            .then(function (body) {
              var data = body && body.data ? body.data : null
              if (data && data.status === 'offline') showOfflineForm()
            })
            .catch(function () {})
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
      if (payload && payload.type === 'message' && payload.message && payload.message.role !== 'visitor') {
        showTyping(false)
        say(payload.message.text, false)
      } else if (payload && payload.type === 'typing') {
        showTyping(payload.active === true)
      } else if (payload && payload.type === 'offline') {
        showTyping(false)
        showOfflineForm()
      }
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
      applyLanguage(data.language)
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
