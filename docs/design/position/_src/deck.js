/* ── 卡片流：照 DeckSection 的行为——一次一张、上一张 / 下一张、全部列出、方向键、决定后飞走换下一张 ──
   卡就是普通卡片流里的卡：标签行「岗位 · 类别」+ 剩几天 + 证据 N + 谁提的；Reddit 不另起样式。 */
var CARDS = [
  { id: 1, matter: "近视求助帖的回帖", cat: "回帖草稿", tone: "t-warn", left: "剩 1 天", orig: true, ev: 5, who: "AI",
    title: "回帖 r/SmartGlasses：「近视能戴 INMO Air 3 吗？」",
    box: '<small>用品牌号发 · 中文摘要</small>先表明是 INMO 官方；能戴，Air 3 有磁吸近视镜片夹片，度数在 −8.00 以内可配；附上配镜说明页，不放购买链接（这个版禁链接）。',
    chips: ["r/SmartGlasses", "品牌号 u/inmo_****"], fact: "事实卡 · 夹片支持到 −8.00",
    acts: [["pri", "发出"], ["out", "改一下"], ["out", "不发"]], keys: "→ 发出 · ← 不发 · ↑ 稍后 · ↓ 改一下" },
  { id: 2, matter: "「召回」传言怎么应对", cat: "要你选", tone: "t-info", left: "剩 2 天", orig: true, ev: 2, who: "AI",
    title: "有人说 INMO「召回」，怎么处理？",
    box: '<small>为什么问你</small>出处只有 r/gadgets 一条评论，没找到官方或媒体消息。没核实的说法不下结论（这个岗位的规矩）。',
    opts: ["交给公关核实", "先观察，不回应", "我来说"],
    acts: [["pri", "就这条", true]], keys: "→ 就这条 · ← 都不是 · ↑ 稍后" },
  { id: 3, matter: "r/INMO 置顶公告：固件 2.1 续航说明", cat: "发公告", tone: "t-warn", left: "剩 2 天", ev: 3, who: "AI",
    title: "r/INMO 置顶公告：固件 2.1 续航说明",
    box: '<small>排在 10-08 09:00 发 · 中文摘要</small>回应这周 3 条续航抱怨：2.1 之后待机耗电变高是已知问题，2.1.1 本月下旬修；临时办法是关掉「抬头唤醒」。',
    chips: ["r/INMO"], fact: "事实卡 · 2.1.1 修复计划",
    acts: [["pri", "批准发布"], ["out", "改一下"], ["out", "驳回"]], keys: "→ 批准发布 · ← 驳回 · ↑ 稍后 · ↓ 改一下" },
  { id: 4, matter: "r/INMO 入群审核与举报处理", cat: "删帖", tone: "t-neutral", left: "剩 3 天", ev: 2, who: "AI",
    title: "删掉被举报的帖子「便宜 50% 的 INMO 渠道」？",
    box: '<small>r/INMO · 被 2 人举报</small>发帖号注册 3 天，帖里是外部低价链接，违反版规第 2 条（禁广告）。建议删帖并禁言 7 天。',
    chips: ["r/INMO", "u/****_deals"],
    acts: [["pri", "删帖"], ["out", "只删不禁言"], ["out", "留着"]], keys: "→ 删帖 · ← 留着 · ↑ 稍后 · ↓ 指导" },
];
var deck = { i: 0, left: CARDS.slice(), busy: false };
function dEl(s) { return document.querySelector(s); }
function cardHtml(c) {
  var body = '<p class="ti">' + c.title + "</p>" + '<div class="dbox">' + c.box + "</div>";
  if (c.opts) body += '<fieldset class="dopts"><legend>选一个</legend>' + c.opts.map(function (o, i) { return '<label><input type="radio" name="o' + c.id + '" value="' + i + '">' + o + "</label>"; }).join("") + "</fieldset>";
  if (c.chips || c.fact) body += '<div class="dchips">' + (c.chips || []).map(function (x) { return "<span>" + x + "</span>"; }).join("") + (c.fact ? '<span class="fact">' + c.fact + "</span>" : "") + "</div>";
  var acts = c.acts.map(function (a) { return '<button class="btn sm ' + a[0] + '" type="button" data-dec="' + (a[0] === "pri" ? "r" : "l") + '"' + (a[2] ? " disabled" : "") + ">" + a[1] + "</button>"; }).join("") + (c.opts ? '<span class="need">先选一个</span>' : "");
  return '<div class="card dcard" id="dcard">' +
    '<button class="dmatter" type="button">属于：' + c.matter + "</button>" +
    '<div class="dtag"><span class="pill ' + c.tone + '">Reddit 运营 · ' + c.cat + '</span><span class="pill t-warn">' + c.left + '</span><span class="r">' + (c.orig ? '<a class="orig" href="#">看原帖 →</a>' : "") + '<button class="evp" type="button"><svg class="ico s12"><use href="#i-evid"/></svg>证据 ' + c.ev + '</button><span class="av t-good" style="width:22px;height:22px;font-size:10px">' + c.who + "</span></span></div>" +
    '<div class="dbody">' + body + "</div>" +
    '<div class="dact"><div class="bar">' + acts + '<button class="more" type="button" aria-label="更多"><svg class="ico"><use href="#i-more"/></svg></button></div><a class="go" href="#" aria-label="进这件事"><svg class="ico"><use href="#i-go"/></svg></a></div></div>';
}
function renderDeck() {
  var L = deck.left, n = L.length;
  dEl("#deckCount").textContent = n + " 张";
  if (!n) {
    dEl("#dstack").innerHTML = '<div class="card" style="padding:28px;text-align:center;color:var(--ws-muted-fg)">队列清空了</div>';
    dEl("#dkeys").textContent = ""; dEl("#dprog").textContent = "0 张"; return;
  }
  deck.i = Math.max(0, Math.min(deck.i, n - 1));
  var c = L[deck.i];
  dEl("#dstack").innerHTML = (deck.i + 1 < n ? '<div class="dghost"></div>' : "") + (deck.i + 2 < n ? '<div class="dghost g2"></div>' : "") + cardHtml(c);
  dEl("#dprog").textContent = "第 " + (deck.i + 1) + " / " + n + " 张";
  dEl("#dprev").disabled = deck.i === 0;
  dEl("#dnext").disabled = deck.i === n - 1;
  dEl("#dkeys").textContent = c.keys;
  dEl("#dlist").innerHTML = L.map(function (x, i) { return '<button type="button" data-i="' + i + '" class="' + (i === deck.i ? "on" : "") + '"><span>' + x.cat + "</span>" + x.title + "</button>"; }).join("");
  Array.prototype.forEach.call(document.querySelectorAll("#dlist button"), function (b) { b.onclick = function () { deck.i = +b.dataset.i; renderDeck(); }; });
  Array.prototype.forEach.call(document.querySelectorAll("#dcard input"), function (r) { r.onchange = function () { var p = dEl("#dcard [data-dec=r]"); p.disabled = false; var nd = dEl("#dcard .need"); if (nd) nd.remove(); }; });
  Array.prototype.forEach.call(document.querySelectorAll("#dcard [data-dec]"), function (b) { b.onclick = function () { decide(b.dataset.dec, b.textContent); }; });
}
function decide(dir, label) {
  if (deck.busy || !deck.left.length) return;
  var c = deck.left[deck.i], el = dEl("#dcard");
  if (c.opts && dir === "r" && !el.querySelector("input:checked")) return;
  deck.busy = true;
  el.classList.add(dir === "r" ? "out-r" : dir === "l" ? "out-l" : "out-u");
  setTimeout(function () {
    if (dir !== "u") {
      deck.left.splice(deck.i, 1);
      WORK.forEach(function (w) { if (w.card === c.id) delete w.card; });
      var rc = dEl("#dreceipt"); rc.hidden = false; rc.textContent = "记下了：" + label;
      if (typeof render === "function") render();
    } else deck.i = (deck.i + 1) % deck.left.length;
    deck.busy = false; renderDeck();
  }, 300);
}
dEl("#dprev").onclick = function () { deck.i--; renderDeck(); };
dEl("#dnext").onclick = function () { deck.i++; renderDeck(); };
dEl("#dlistBtn").onclick = function () { var l = dEl("#dlist"); l.hidden = !l.hidden; this.querySelector("span").textContent = l.hidden ? "全部列出" : "收起列表"; };
/* 方向键绑在这副牌上，不绑整页（与 DeckSection 同一条） */
dEl("#deck").addEventListener("keydown", function (e) {
  if (/INPUT|TEXTAREA/.test(e.target.tagName) && e.target.type !== "radio") return;
  var m = { ArrowRight: "r", ArrowLeft: "l", ArrowUp: "u" }[e.key];
  if (!m) return; e.preventDefault();
  var c = deck.left[deck.i]; if (!c) return;
  decide(m, m === "r" ? c.acts[0][1] : m === "l" ? (c.opts ? "都不是" : c.acts[c.acts.length - 1][1]) : "稍后");
});
/* 工作里的「1 张卡等你」：滚到卡片流并翻到那张 */
function showCard(id) {
  var i = deck.left.findIndex(function (c) { return c.id === id; });
  if (i >= 0) { deck.i = i; renderDeck(); }
  var d = dEl("#deck"); d.scrollIntoView({ behavior: "smooth", block: "start" });
  d.classList.add("flash"); setTimeout(function () { d.classList.remove("flash"); }, 1200);
}
document.addEventListener("click", function (e) { var a = e.target.closest && e.target.closest("[data-card]"); if (a) { e.preventDefault(); e.stopPropagation(); showCard(+a.dataset.card); } }, true);
renderDeck();
