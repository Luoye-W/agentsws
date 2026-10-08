// WP262 事项页 v2：两张稿共用的画法（只拼 HTML 字符串，没有框架）。真做时对应的组件写在每个函数上面。
const SHOP = '{{SHOPIFY}}'
const ico = (id, cls = '') => `<svg class="ico ${cls}"><use href="#${id}"/></svg>`
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const ava = (live) =>
  `<span class="ava${live ? ' pulse-ring' : ''}"><svg class="gl"><use href="#g-web"/></svg><img src="${SHOP}" alt=""></span>`

const STATE = {
  running: ['doing', 'running', '在跑'],
  doing: ['doing', '', '进行中'],
  awaiting: ['awaiting', 'awaiting', '等你批'],
  blocked: ['blocked', 'blocked', '卡住了'],
  done: ['done', 'ready', '已完成'],
}

/* MatterHeader：短标题（点了能改）+ 一行灰字元信息 + 右边「⋯」。待办有才出。 */
function head({ state = 'doing', todos = 0, when = '14:40', title = 'Rollout 英文首页 · 深色科技风' } = {}) {
  const [cls, dot, word] = STATE[state]
  const todo = todos
    ? `<span class="dot"></span><button class="todo-chip" type="button" data-todos aria-expanded="false">${ico('i-sq', 's12')}${todos} 个待办${ico('i-cd', 's12')}</button>`
    : ''
  return `<div class="mh"><div class="mx">
  <div class="row">
    <div style="min-width:0">
      <h1 data-title title="AI 起的标题，点了能改">${esc(title)}<svg class="ico s14 pen"><use href="#i-pen"/></svg></h1>
      <div class="meta">
        <span class="duty" data-tip="这件事归这条职责做 · 点了换">${'<span class="di"><svg class="gl"><use href="#g-web"/></svg><img src="' + SHOP + '" alt=""></span>'}Shopify 网页模板${ico('i-swap', 's12 sw')}</span>
        <span class="dot"></span><span class="state ${cls}"><i class="sd ${dot}" style="${dot ? '' : 'background:var(--ws-brand)'}"></i>${word}</span>
        <span class="dot"></span><span class="holders" data-tip="你 + 网页模板 Agent"><span class="av sm t-warn">舟</span><span class="av sm t-brand" style="margin-left:-5px">AI</span></span>
        <span class="dot"></span><span>最近 ${when}</span>${todo}
      </div>
    </div>
    <div class="r">
      <button class="btn sm icon ghost" type="button" data-menu aria-label="更多">${ico('i-more')}</button>
      <div class="pop menu" hidden>
        <button type="button">${ico('i-swap', 's14')}换职责<span class="why">${ico('i-cr', 's12')}</span></button>
        <button type="button">${ico('i-link', 's14')}复制链接</button>
        <hr>
        <button type="button" ${state === 'running' || state === 'awaiting' ? 'disabled' : ''}>${ico('i-archive', 's14')}归档${state === 'running' ? '<span class="why">在跑，跑完再归</span>' : state === 'awaiting' ? '<span class="why">有卡等你批</span>' : ''}</button>
        <button type="button" class="bad">${ico('i-xcircle', 's14')}关闭事项</button>
      </div>
    </div>
  </div>
  <ul class="todos" data-todo-list hidden>
    <li><i class="cb"></i><span>补横幅大图（建议 2400×1000）</span><span class="from">AI 提的 · 10/7</span></li>
    <li><i class="cb"></i><span>补品牌故事配图</span><span class="from">AI 提的 · 10/7</span></li>
    <li><i class="cb"></i><span>选主推合集</span><span class="from">AI 提的 · 10/7</span></li>
  </ul>
</div></div>`
}

/* 用户的话：右侧气泡；超过 6 行先收起 */
const user = (text, t, clamp = false) =>
  `<div class="me"><div class="bubble${clamp ? ' clamp' : ''}">${esc(text)}</div><div class="t">${clamp ? '<button class="more" type="button" data-clamp>展开</button>' : ''}<span>${t}</span></div></div>`

/* Agent：左侧，职责头像 + 名字 + 时间；正文 Markdown；长的折叠 */
function ai({ t, html, fold = false, card = '', lead = '' }) {
  const body = fold
    ? `${lead}${card}<div class="md fold" style="margin-top:14px">${html}</div><button class="unfold" type="button" data-fold>${ico('i-cd', 's12')}展开全文</button>`
    : `<div class="md">${html}</div>${card}`
  return `<div class="ai">${ava()}<div class="who">Shopify 网页模板<span class="t">${t}</span></div><div class="bd">${body}
  <div class="acts"><button type="button" data-tip="复制">${ico('i-copy', 's14')}</button></div></div></div>`
}

/* 过程与系统事件：居中一行，点开是工具调用摘要 */
function sys({ icon = 'i-bot', tone = '', text, steps = [], open = false }) {
  const li = steps
    .map(([k, i, s, d = '']) => `<li class="${k}">${ico(i, `s14${k === 'now' ? ' spin' : ''}`)}<span>${s}</span>${d ? `<span class="dur">${d}</span>` : ''}</li>`)
    .join('')
  return `<div class="sys${open ? ' open' : ''}"><button type="button" data-sys>${ico(icon, `s14 ${tone}`)}<span>${text}</span>${steps.length ? ico('i-cr', 's12 cv') : ''}</button>${steps.length ? `<ul class="steps">${li}</ul>` : ''}</div>`
}

/* 「预览好了」结果卡（WP253 preview 事件）：主按钮打开预览，次按钮「发布上线」→ 出审批卡 */
const previewCard = (published = false) => `<div class="rc">
  <div class="rh">${ico('i-eye', 's14')}预览好了<span class="pill ${published ? 't-good' : 't-neutral'}" style="margin-left:auto">${published ? '已发布' : '未发布 · 线上没动'}</span></div>
  <div class="rb"><div class="thumb"><i class="hero"></i><i class="grid"></i><i class="story"></i><i class="faq"></i><i class="sub"></i></div>
    <div><div class="rt">Rollout Homepage v1 (dark tech)</div><div class="rm">改了 2 个文件 · 首页 5 屏 · 检查 0 错 0 警</div></div></div>
  <div class="rf"><button class="btn sm pri" type="button">${ico('i-ext', 's14')}打开预览</button>${published ? '' : `<button class="btn sm out" type="button" data-publish>${ico('i-rocket', 's14')}发布上线</button>`}<a class="lnk">${ico('i-filecode', 's12')}看改动</a></div>
</div>`

/* 审批卡（发布上线）：内嵌在对话里、能直接批；批过之后缩成一行结论 */
const approvalCard = (decided = false) => decided
  ? `<div class="rc done-card"><div class="rf" style="border:0"><span class="stamp">${ico('i-checkc', 's14')}你批了 · 发布上线</span><span class="lnk">10/8 09:12</span></div></div>`
  : `<div class="rc await">
  <div class="rh">${ico('i-stamp', 's14')}等你批<span class="pill t-warn" style="margin-left:auto">发布上线</span></div>
  <div class="rb" style="padding-bottom:8px"><div><div class="rt">把「Rollout Homepage v1 (dark tech)」设为线上主题</div><div class="rm">访客马上看到新首页</div></div></div>
  <ul class="imp">
    <li>${ico('i-warn', 's14')}<span><b>配色是全店级</b>：商品页、购物车也会变深色</span></li>
    <li>${ico('i-undo', 's14')}<span>现在的线上主题退成未发布，随时能换回</span></li>
  </ul>
  <div class="rf"><button class="btn sm pri" type="button">${ico('i-check', 's14')}批准发布</button><button class="btn sm ghost" type="button">先不发</button><a class="lnk">${ico('i-ext', 's12')}再看一眼预览</a></div>
</div>`

/* 卡住了（WP251 blocked）：最新一条时是卡 + 「去连接」；连上并接着做之后缩成一行 */
const blockedCard = () => `<div class="rc block">
  <div class="rh">${ico('i-plug', 's14')}卡住了<span class="pill t-bad" style="margin-left:auto">缺连接</span></div>
  <div class="rb" style="padding-bottom:12px"><div><div class="rt">要先连上「Shopify 店铺后台」</div><div class="rm">连上后点「接着做」，从卡住的地方继续</div></div></div>
  <div class="rf"><button class="btn sm pri" type="button">${ico('i-plug', 's14')}去连接</button><button class="btn sm out" type="button">接着做</button></div>
</div>`

/* 运行中：左侧「正在做…」+ 当前一步，可展开实时步骤 */
const running = (open = false) => `<div class="ai run">${ava(true)}<div class="who"><span class="live">正在做…</span><span class="t">已 1 分 12 秒</span></div>
<div class="bd"><button class="now" type="button" data-run>${ico('i-loader', 's14 spin')}<span class="shimmer">正在跑主题检查</span><span class="el">第 5 步</span>${ico(open ? 'i-cd' : 'i-cr', 's12')}</button>
<ul class="steps" ${open ? '' : 'hidden'} data-run-steps>
  <li class="ok">${ico('i-check', 's14')}<span>读 <code>templates/index.json</code></span><span class="dur">2s</span></li>
  <li class="ok">${ico('i-check', 's14')}<span>读 <code>sections/faq.liquid</code> 等 3 个分区</span><span class="dur">4s</span></li>
  <li class="ok">${ico('i-check', 's14')}<span>改 <code>templates/index.json</code>（首页 5 屏）</span><span class="dur">31s</span></li>
  <li class="ok">${ico('i-check', 's14')}<span>改 <code>config/settings_data.json</code>（配色）</span><span class="dur">9s</span></li>
  <li class="now">${ico('i-loader', 's14')}<span>主题检查</span><span class="dur">…</span></li>
  <li class="todo">${ico('i-upload', 's14')}<span>推成未发布主题，出预览</span></li>
</ul></div></div>`

/* 底部输入卡：建议输入（浅灰 + Tab）/ 私聊 AI 切换 / 发送圆钮（空时置灰）/ 运行中变「停」 */
function composer({ suggest = '', placeholder = '回复，或交代新要求…', mode = 'agent', run = false, closed = false, value = '' } = {}) {
  const cls = ['cmp', mode === 'private' ? 'private' : '', run ? 'running' : '', value ? 'has' : '', closed ? 'closed' : ''].join(' ')
  const ph = mode === 'private' ? '问 AI 一句，只你看得见…' : closed ? '这件事已关闭，说一句就重新打开' : run ? '还能接着说，会排在这一轮后面…' : placeholder
  return `<div class="dock"><div class="mx"><div class="${cls}" data-cmp data-suggest="${esc(suggest)}">
  <div class="ptag">${ico('i-lock', 's12')}私聊 AI · 只你看得见，不会让它去做事</div>
  <div class="field"><textarea rows="1" placeholder="${suggest && !value ? '' : ph}" aria-label="在这个事项里说一句">${esc(value)}</textarea>
  <div class="sug" ${suggest && !value ? '' : 'hidden'}><span>${esc(suggest)}</span><span class="kbd">Tab</span></div></div>
  <div class="bar">
    <button class="ib" type="button" data-tip="附件（以后）">${ico('i-plus', 's18')}</button>
    <button class="ib" type="button" data-tip="提及同事 / 文件（以后）">${ico('i-at', 's18')}</button>
    <button class="mode" type="button" data-mode data-tip="打开：只问 AI 一句，不让它去做事">${ico('i-lock', 's14')}私聊 AI<span class="toggle${mode === 'private' ? ' on' : ''}"></span></button>
    <span class="khint" title="Enter 发送 · Shift+Enter 换行">↵ 发送 · ⇧↵ 换行</span>
    <button class="send" type="button" data-send aria-label="${run ? '停下这一轮' : '发送'}" style="${run ? '' : 'margin-left:0'}">${run && !value ? ico('i-stop') : ico('i-arrow-up')}</button>
  </div>
</div></div></div>`
}

/* 私聊 AI 的一问一答（只你看得见，不进事项记录；关掉就没了） */
const privatePair = (q, a) => `<div class="pv"><div class="ph2">${ico('i-lock', 's12')}只你看得见 · 不进这件事的记录<button type="button" data-close-pv aria-label="关掉">${ico('i-x', 's14')}</button></div>
<div class="q">${esc(q)}</div><div class="a">${a}</div></div>`

/* 交互：全部挂在 document 上（两张稿共用），能点的都能点 */
function grow(ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 240)}px` }
function syncCmp(c) {
  const ta = c.querySelector('textarea'), g = c.querySelector('.sug'), v = ta.value
  c.classList.toggle('has', v.trim() !== '')
  const sug = c.dataset.suggest
  g.hidden = !(sug && v === '' && !c.classList.contains('private'))
  const cl = c.classList
  ta.placeholder = g.hidden ? (cl.contains('private') ? '问 AI 一句，只你看得见…' : cl.contains('running') ? '还能接着说，会排在这一轮后面…' : cl.contains('closed') ? '这件事已关闭，说一句就重新打开' : '回复，或交代新要求…') : ''
  const send = c.querySelector('[data-send]')
  if (c.classList.contains('running')) send.innerHTML = v.trim() ? ico('i-arrow-up') : ico('i-stop')
  grow(ta)
}
function sendFrom(c) {
  const ta = c.querySelector('textarea'), v = ta.value.trim()
  if (!v) return
  const tail = document.getElementById('tail')
  if (tail) {
    tail.insertAdjacentHTML('beforeend', c.classList.contains('private')
      ? privatePair(v, '<p>（稿子里的示意回答）全店配色在「主题设置 → 颜色」里一处改；只想首页深色，可以让它给首页单独套一个配色方案，其他页不动。</p>')
      : user(v, '刚刚'))
    tail.lastElementChild.scrollIntoView({ block: 'nearest' })
  }
  ta.value = ''; c.dataset.suggest = ''; syncCmp(c)
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('button,[data-title],.cb,[data-tip]')
  document.querySelectorAll('.menu').forEach((m) => { if (!e.target.closest('.r')) m.hidden = true })
  if (!el) return
  if (el.matches('[data-fold]')) { const f = el.previousElementSibling; f.classList.toggle('open'); el.innerHTML = f.classList.contains('open') ? `${ico('i-up', 's12')}收起` : `${ico('i-cd', 's12')}展开全文` }
  else if (el.matches('[data-sys]')) el.parentElement.classList.toggle('open')
  else if (el.matches('[data-clamp]')) { const b = el.closest('.me').querySelector('.bubble'); b.classList.toggle('clamp'); el.textContent = b.classList.contains('clamp') ? '展开' : '收起' }
  else if (el.matches('[data-menu]')) { const m = el.nextElementSibling; m.hidden = !m.hidden }
  else if (el.matches('[data-todos]')) { const l = el.closest('.mh').querySelector('[data-todo-list]'); l.hidden = !l.hidden; el.setAttribute('aria-expanded', String(!l.hidden)) }
  else if (el.matches('.cb')) el.parentElement.classList.toggle('done')
  else if (el.matches('[data-run]')) { const s = el.nextElementSibling; s.hidden = !s.hidden }
  else if (el.matches('[data-close-pv]')) el.closest('.pv').remove()
  else if (el.matches('[data-mode]')) { const c = el.closest('[data-cmp]'); c.classList.toggle('private'); el.querySelector('.toggle').classList.toggle('on'); syncCmp(c); c.querySelector('textarea').focus() }
  else if (el.matches('[data-send]')) sendFrom(el.closest('[data-cmp]'))
  else if (el.matches('[data-publish]') && window.onPublish) window.onPublish()
  else if (el.matches('[data-title]') && !el.querySelector('input')) {
    const old = el.firstChild.textContent
    el.innerHTML = `<input value="${old}" aria-label="改标题">`
    const i = el.querySelector('input'); i.focus(); i.select()
    const done = () => { el.innerHTML = `${esc(i.value || old)}<svg class="ico s14 pen"><use href="#i-pen"/></svg>` }
    i.addEventListener('blur', done); i.addEventListener('keydown', (k) => { if (k.key === 'Enter' || k.key === 'Escape') i.blur() })
  }
})
document.addEventListener('input', (e) => { const c = e.target.closest('[data-cmp]'); if (c) syncCmp(c) })
document.addEventListener('keydown', (e) => {
  const c = e.target.closest && e.target.closest('[data-cmp]')
  if (!c) return
  const ta = c.querySelector('textarea'), g = c.querySelector('.sug')
  if (e.key === 'Tab' && !g.hidden) { e.preventDefault(); ta.value = c.dataset.suggest; syncCmp(c) }
  else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendFrom(c) }
})
const q = new URLSearchParams(location.search)
