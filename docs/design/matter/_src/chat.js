// WP262 主稿：Rollout 建站事项（10-07 Windows 真机）那条时间线，照对话式重排。
// ?state=running|awaiting|blocked|done 看另外几种结尾；?todos=1 页头出待办；?suggest=0 输入框不给建议；
// ?private=1 输入卡切到私聊 AI；?open=1 展开最终交代与运行步骤；?menu=1 打开「⋯」。
const ORIGINAL = '用 agentsws-theme 给 Rollout 搭英文首页（变形金刚正版授权耳机音箱，美国市场）：大图横幅、主推产品占位、品牌故事、FAQ、邮件订阅；深色科技风红色点缀。推成未发布主题给我预览，先别发布。'
const MORE = '开始做吧。详细要求：\n1. 横幅标题用一句英文短句，副标题点出 Officially licensed\n2. 主推产品先放占位，合集我之后再选\n3. FAQ 写 4 条：正版授权、发货、退换、保修\n4. 整体深色，红色只做点缀，按钮别太圆'
const FINAL = `<h3>改了什么（2 个文件）</h3>
<ul><li><code>templates/index.json</code>：首页 5 屏
  <ol><li>大图横幅，标题「More than meets the ear.」</li><li>主推产品网格（先放占位）</li><li>品牌故事图文</li><li>常见问题手风琴，4 条</li><li>邮件订阅条</li></ol></li>
<li><code>config/settings_data.json</code>：深色科技风——底色 <span class="sw" style="background:#0B0D10"></span> <code>#0B0D10</code>、主色红 <span class="sw" style="background:#E11D2E"></span> <code>#E11D2E</code>，按钮切角、全大写</li></ul>
<h3>影响面</h3>
<ul><li>配色是<b>全店级</b>的：发布后商品页、购物车也会变深色。只想首页深色就跟我说</li></ul>
<h3>还要你补的三处占位</h3>
<ol><li>横幅大图</li><li>品牌故事配图</li><li>主推合集（选好哪个，我接上）</li></ol>
<h3>两处口径请你确认</h3>
<ul><li>FAQ 里发货 / 退换的说法以店里的<a>政策页</a>为准，我没自己编时限</li><li>FAQ 的富摘要（搜索结果里的问答）先关着</li></ul>
<h3>检查与退回</h3>
<ul><li>主题检查 0 错 0 警</li><li>想退回：这份是未发布副本，删掉或不理它就行，线上主题一个字没动</li></ul>
<p>要发布说一句，会先出一张审批卡给你批。</p>`

const RUN_STEPS = [
  ['ok', 'i-check', '读 <code>templates/index.json</code> 与 3 个分区', '6s'],
  ['ok', 'i-check', '改 <code>templates/index.json</code>（首页 5 屏）', '1m 48s'],
  ['ok', 'i-check', '改 <code>config/settings_data.json</code>（配色）', '22s'],
  ['ok', 'i-check', '主题检查：0 错 0 警', '41s'],
  ['ok', 'i-check', '推成未发布主题「Rollout Homepage v1 (dark tech)」', '35s'],
]

function timeline(open) {
  return [
    '<div class="day">10月7日 周三</div>',
    user(ORIGINAL, '14:02'),
    sys({ icon: 'i-swap', text: '交给「Shopify 网页模板」来做', steps: [['ok', 'i-check', '网站运营岗位里按内容挑的：建站 / 改主题'], ['todo', 'i-swap', '想换：页头职责标签或「⋯ → 换职责」']] }),
    sys({ text: '跑了一次 · 41 秒 · 读了 2 个文件', steps: [['ok', 'i-check', '读 <code>AGENTS.md</code>（主题规矩）', '3s'], ['ok', 'i-check', '读 <code>CATALOG.index.json</code>（分区目录）', '2s']] }),
    ai({ t: '14:03', html: '<p>可以。我的打算：首页按你说的 5 屏搭，配色一起改，推成<b>未发布</b>主题给你看，线上不动。</p><p>有具体要求（标题口号、FAQ 写哪几条）现在说，我一起做；没有就按常见做法来。</p>' }),
    user(MORE, '14:09'),
    sys({ icon: 'i-bot', text: '接着跑了一次 · 57 秒 · 只读没改', steps: [['ok', 'i-check', '读 <code>templates/index.json</code>', '4s'], ['ok', 'i-check', '读 FAQ / 容器分区的 schema', '9s'], ['ok', 'i-check', '读标题块 schema', '3s']] }),
    ai({ t: '14:10', html: '<p>现在读首页模板、FAQ / 容器分区、标题块的 schema，并顺手看店里有没有可引用的商品。</p>' }),
    user('接着做：主题规矩和目录你已经读过了，别再重读，直接改首页模板和配色，改完检查、推成未发布主题。', '14:20'),
    sys({ icon: 'i-plug', tone: 'warn', text: '卡在缺连接：Shopify 店铺后台 · 14:29 已连上', steps: [['ok', 'i-check', '读 <code>templates/index.json</code>', '3s'], ['todo', 'i-plug', '查店里的商品 → 店铺后台没连上，停下'], ['ok', 'i-checkc', '14:29 你连上了']] }),
    user('接着做，一口气做到出预览，中间不用汇报。', '14:31'),
    sys({ icon: 'i-checkc', tone: 'good', text: '跑完了 · 4 分 12 秒 · 改 2 个文件 · 检查 0 错 0 警 · 推成未发布主题', steps: RUN_STEPS, open }),
    ai({ t: '14:40', fold: true, lead: '<div class="md"><p>预览好了，线上没动。</p></div>', card: previewCard(), html: FINAL }),
  ].join('\n')
}

function render() {
  const state = q.get('state') ?? 'doing'
  const open = q.get('open') === '1'
  const todos = q.get('todos') === '1' ? 3 : 0
  let tail = ''
  let suggest = q.get('suggest') === '0' ? '' : '发布上线'
  let when = '14:40'
  if (state === 'running') { tail = user('把深色只用在首页，其他页保持原来的浅色。', '10/8 09:02') + running(open); suggest = ''; when = '刚刚' }
  if (state === 'awaiting') { tail = user('发布上线', '10/8 09:05') + ai({ t: '09:05', html: '<p>好，发布前要你批一下：</p>', card: approvalCard() }); suggest = ''; when = '09:05' }
  if (state === 'blocked') { tail = user('把主推合集换成 Bumblebee 系列', '10/8 09:20') + ai({ t: '09:21', html: '<p>要读店里的合集，但店铺后台连接断了（授权过期）。</p>', card: blockedCard() }); suggest = ''; when = '09:21' }
  if (state === 'done') { tail = user('发布上线', '10/8 09:05') + ai({ t: '09:05', html: '<p>好，发布前要你批一下：</p>', card: approvalCard(true) }) + ai({ t: '09:12', html: '<p>已发布。线上首页就是「Rollout Homepage v1 (dark tech)」，原来的主题留成未发布，想换回说一句。</p>', card: previewCard(true) }) + '<div class="closed-line">' + ico('i-checkc', 's14') + '你在 09:15 关闭了这件事</div>'; suggest = ''; when = '09:15' }
  document.getElementById('page').innerHTML =
    head({ state, todos, when }) +
    `<div class="mx"><div class="tl">${timeline(open)}<div id="tail" style="display:contents">${tail}</div></div></div>` +
    composer({ suggest, run: state === 'running', closed: state === 'done', mode: q.get('private') === '1' ? 'private' : 'agent', value: q.get('typed') ?? '' })
  const dot = document.getElementById('navDot')
  dot.className = `sd ${STATE[state][1] || 'running'}`
  if (state === 'doing') dot.className = 'sd'
  if (open) document.querySelectorAll('.fold').forEach((f) => { f.classList.add('open'); f.nextElementSibling.innerHTML = `${ico('i-up', 's12')}收起` })
  if (todos && q.get('todolist') === '1') document.querySelector('[data-todos]').click()
  if (q.get('menu') === '1') document.querySelector('.menu').hidden = false
  document.querySelectorAll('[data-cmp]').forEach(syncCmp)
}
window.onPublish = () => { q.set('state', 'awaiting'); render(); document.getElementById('tail').scrollIntoView({ block: 'start' }) }
window.setState = (s) => { q.set('state', s); render(); if (s !== 'doing') document.getElementById('tail').scrollIntoView({ block: 'center' }) }
window.setQ = (k, v) => { if (v === null) q.delete(k); else q.set(k, v); render() }
render()
