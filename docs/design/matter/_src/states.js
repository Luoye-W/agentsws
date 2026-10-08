// WP262 状态稿：等你批 / 运行中 / 卡住了 / 已完成 四个结尾，外加输入卡六种样子。
const lastRun = sys({ icon: 'i-checkc', tone: 'good', text: '跑完了 · 4 分 12 秒 · 改 2 个文件 · 检查 0 错 0 警 · 推成未发布主题' })
const lastAi = ai({ t: '10/7 14:40', html: '<p>预览好了，线上没动。还要补三处占位：横幅图、品牌故事图、主推合集。要发布说一句，会先出审批卡。</p>', card: previewCard() })
const frame = (n, title, sub, body) => `<div class="fr-h"><b>${n} ${title}</b><span>${sub}</span></div><div class="frame">${body}</div>`
const tl = (s) => `<div class="mx"><div class="tl"><div id="tail" style="display:contents">${s}</div></div></div>`
const cell = (label, c) => `<div class="cell"><span>${label}</span>${c}</div>`
document.getElementById('page').innerHTML = [
  frame('①', '等你批', '「发布上线」→ 审批卡就在对话里，直接批', head({ state: 'awaiting', when: '09:05' }) + tl(lastRun + lastAi + user('发布上线', '10/8 09:05') + ai({ t: '09:05', html: '<p>好，发布前要你批一下：</p>', card: approvalCard() })) + composer()),
  frame('②', '运行中', '左边一条「正在做…」+ 当前一步；发送位变「停」', head({ state: 'running', when: '刚刚' }) + tl(lastAi + user('把深色只用在首页，其他页保持原来的浅色。', '10/8 09:02') + running(true)) + composer({ run: true })),
  frame('③', '卡住了', '最新一条是卡，带「去连接」；接上之后缩成一行灰字', head({ state: 'blocked', when: '09:21' }) + tl(lastAi + user('把主推合集换成 Bumblebee 系列', '10/8 09:20') + ai({ t: '09:21', html: '<p>要读店里的合集，但店铺后台连接断了（授权过期）。</p>', card: blockedCard() })) + composer()),
  frame('④', '已完成', '审批卡批过缩成一行；关了的事说一句就重开；待办还在就照样挂着', head({ state: 'done', todos: 3, when: '09:15' }) + tl(user('发布上线', '10/8 09:05') + ai({ t: '09:05', html: '<p>好，发布前要你批一下：</p>', card: approvalCard(true) }) + ai({ t: '09:12', html: '<p>已发布。线上首页就是「Rollout Homepage v1 (dark tech)」，原来的主题留成未发布，想换回说一句。</p>', card: previewCard(true) }) + `<div class="closed-line">${ico('i-checkc', 's14')}你在 09:15 关闭了这件事</div>`) + composer({ closed: true })),
  `<div class="fr-h"><b>⑤ 输入卡</b><span>Claude 那样：圆角卡、卡内右下圆形发送、左下私聊 AI 开关、浅灰建议按 Tab 收下</span></div>`,
  `<div class="cgrid">${[
    cell('有建议：AI 刚说「要发布说一句」→ 浅灰「发布上线」+ Tab', composer({ suggest: '发布上线' })),
    cell('没建议：普通占位字，不硬给', composer()),
    cell('按了 Tab / 打了字：变正文，发送钮变主色', composer({ value: '发布上线' })),
    cell('私聊 AI：整张卡变蓝，只你看得见', composer({ mode: 'private', value: '只把深色用在首页，要改哪里？' })),
    cell('运行中：发送位变「停」，还能接着说', composer({ run: true })),
    cell('另一种建议：从「影响面」那句取', composer({ suggest: '把深色只用在首页' })),
  ].join('')}</div>`,
  `<div class="fr-h"><b>⑥ 私聊 AI 的一问一答</b><span>只你看得见、不进记录、关掉就没了（要不要留，见 README）</span></div>`,
  `<div class="frame" style="padding:16px 22px">${privatePair('只把深色用在首页，要改哪里？', '<p>全店配色在「主题设置 → 颜色」里一处改。只想首页深色，可以让它给首页单独套一个<b>配色方案</b>，其他页不动——要做就在输入框里关掉私聊，跟它说一句。</p>')}</div>`,
].join('')
document.querySelectorAll('[data-cmp]').forEach(syncCmp)
if (q.get('focus') === '1') document.querySelector('.cgrid textarea').focus()
