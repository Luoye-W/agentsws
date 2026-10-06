/* ── 装配 + 交互 ── */
var GL = { status: "按状态", duty: "按职责", due: "按截止", none: "不分组" };
var SL = { due: "按截止", upd: "按最近更新", cost: "按花费" };
function render() {
  var list = sorted(WORK.filter(passes));
  var v = state.view, html = "";
  if (v === "board") html = vBoard(list);
  else if (v === "calendar") html = vCal(list);
  else if (v === "table") html = vTable(list);
  else if (v === "community") html = vCommunity();
  else if (v === "schedule") html = vSchedule();
  else html = vList(list);
  $("#viewport").innerHTML = html;
  $$("#views a").forEach(function (a) { a.classList.toggle("on", a.dataset.view === v); });
  $$("#qv button").forEach(function (b) { b.classList.toggle("on", b.dataset.view === v); });
  var quick = v === "community" || v === "schedule";
  $("#tools").style.display = quick ? "none" : "";
  $("#colsBtn").hidden = v !== "table";
  $("#glabel").textContent = GL[state.group];
  $("#slabel").textContent = SL[state.sort];
  $("#workCount").textContent = quick ? "" : list.length + " 件";
  var n = state.f.d.length + state.f.s.length + state.f.src.length + (state.f.due ? 1 : 0);
  $("#fcount").hidden = !n; $("#fcount").textContent = n;
  $("[data-pop=filter]").classList.toggle("on", !!n);
  chips(quick);
  wire();
  save();
}
var DUE = { today: "今天到期", week: "这周到期", late: "已过期", none: "没有截止" };
function chips(quick) {
  var f = state.f, out = [];
  f.d.forEach(function (d) { out.push(["d", d, "职责：" + DUTY[d].name]); });
  f.s.forEach(function (s) { out.push(["s", s, "状态：" + ST[s].name]); });
  if (f.due) out.push(["due", f.due, DUE[f.due]]);
  f.src.forEach(function (s) { out.push(["src", s, "来源：" + SRC[s]]); });
  $("#fchips").innerHTML = quick || !out.length ? "" : out.map(function (c) { return '<span class="fc">' + c[2] + '<button type="button" data-rm="' + c[0] + ":" + c[1] + '" aria-label="去掉"><svg class="ico s12"><use href="#i-x"/></svg></button></span>'; }).join("") + '<button class="btn xs ghost" type="button" data-rm="all">清空</button>';
  $$("#fchips [data-rm]").forEach(function (b) {
    b.onclick = function () {
      var r = b.dataset.rm;
      if (r === "all") state.f = { d: [], s: [], due: "", src: [] };
      else { var p = r.split(":"); if (p[0] === "due") state.f.due = ""; else state.f[p[0]] = state.f[p[0]].filter(function (x) { return x !== p[1]; }); }
      render();
    };
  });
}
function wire() {
  $$(".grp .gh").forEach(function (h) { h.onclick = function (e) { if (e.target.closest(".hint")) return; var g = h.parentNode; g.classList.toggle("fold"); state.fold[g.dataset.g] = g.classList.contains("fold"); }; });
  $$("#calseg a").forEach(function (a) { a.onclick = function () { state.cal = a.dataset.cal; render(); }; });
  // 看板：真能拖，拖到哪一列就改成哪个状态
  $$(".kc").forEach(function (c) {
    c.ondragstart = function (e) { e.dataTransfer.setData("text/plain", c.dataset.id); c.classList.add("drag"); };
    c.ondragend = function () { c.classList.remove("drag"); };
  });
  $$(".col").forEach(function (col) {
    col.ondragover = function (e) { e.preventDefault(); col.classList.add("over"); };
    col.ondragleave = function () { col.classList.remove("over"); };
    col.ondrop = function (e) { e.preventDefault(); var id = +e.dataTransfer.getData("text/plain"); WORK.forEach(function (w) { if (w.id === id) w.s = col.dataset.s; }); render(); };
  });
}
/* 弹层 */
var popEl = null;
function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
function opt(on, label, attrs, radio, cnt) { return '<button class="opt' + (on ? " on" : "") + '" type="button" ' + attrs + ">" + (radio ? '<span class="rd"></span>' : '<span class="ck"><svg class="ico s12"><use href="#i-check"/></svg></span>') + label + (cnt !== undefined ? '<span class="cnt">' + cnt + "</span>" : "") + "</button>"; }
function cnt(fn) { return WORK.filter(fn).length; }
function popHtml(kind) {
  var f = state.f;
  if (kind === "filter") {
    return '<div class="ph2">职责</div><div class="ph2">状态</div>' +
      "<div>" + ["mk", "cm"].map(function (d) { return opt(f.d.indexOf(d) >= 0, di(d) + DUTY[d].name, 'data-f="d:' + d + '"', false, cnt(function (w) { return w.d === d; })); }).join("") + '<div class="ph2" style="margin-top:6px">截止</div>' +
      ["today", "week", "late", "none"].map(function (k) { return opt(f.due === k, DUE[k], 'data-f="due:' + k + '"', true); }).join("") + "</div>" +
      "<div>" + STS.map(function (s) { return opt(f.s.indexOf(s) >= 0, stIcon(s) + ST[s].name, 'data-f="s:' + s + '"', false, cnt(function (w) { return w.s === s; })); }).join("") + '<div class="ph2" style="margin-top:6px">来源</div>' +
      ["you", "agent", "cron", "mail"].map(function (s) { return opt(f.src.indexOf(s) >= 0, SRC[s], 'data-f="src:' + s + '"', false, cnt(function (w) { return w.src === s; })); }).join("") + "</div>" +
      '<div class="foot"><button class="btn sm ghost" type="button" data-f="clear">清空</button><span class="muted" style="font-size:12px">筛选记在这个岗位上</span><button class="btn sm pri" type="button" data-f="done">好了</button></div>';
  }
  if (kind === "group") return '<div class="ph2">分组</div>' + Object.keys(GL).map(function (k) { return opt(state.group === k, GL[k], 'data-g="' + k + '"', true); }).join("");
  if (kind === "sort") return '<div class="ph2">排序</div>' + Object.keys(SL).map(function (k) { return opt(state.sort === k, SL[k], 'data-s="' + k + '"', true); }).join("");
  return '<div class="ph2">显示哪几列</div><button class="opt on" type="button" disabled><span class="ck"><svg class="ico s12"><use href="#i-check"/></svg></span>标题</button>' + Object.keys(COLS).map(function (k) { return opt(state.cols.indexOf(k) >= 0, COLS[k], 'data-c="' + k + '"'); }).join("");
}
function openPop(kind, btn) {
  closePop();
  popEl = document.createElement("div");
  popEl.className = "pop" + (kind === "filter" ? " fpop" : "");
  popEl.innerHTML = popHtml(kind);
  $("#vbar").appendChild(popEl);
  var bar = $("#vbar").getBoundingClientRect(), b = btn.getBoundingClientRect();
  popEl.style.top = b.bottom - bar.top + 6 + "px";
  popEl.style.right = Math.max(0, bar.right - b.right) + "px";
  popEl.dataset.kind = kind;
  popEl.onclick = function (e) {
    e.stopPropagation();
    var t = e.target.closest("button"); if (!t) return;
    if (t.dataset.f) {
      var v = t.dataset.f;
      if (v === "done") return closePop();
      if (v === "clear") state.f = { d: [], s: [], due: "", src: [] };
      else { var p = v.split(":"); if (p[0] === "due") state.f.due = state.f.due === p[1] ? "" : p[1]; else { var a = state.f[p[0]], i = a.indexOf(p[1]); if (i >= 0) a.splice(i, 1); else a.push(p[1]); } }
    }
    if (t.dataset.g) { state.group = t.dataset.g; render(); return closePop(); }
    if (t.dataset.s) { state.sort = t.dataset.s; render(); return closePop(); }
    if (t.dataset.c) { var c = t.dataset.c, j = state.cols.indexOf(c); if (j >= 0) state.cols.splice(j, 1); else state.cols = Object.keys(COLS).filter(function (k) { return k === c || state.cols.indexOf(k) >= 0; }); }
    render(); popEl.innerHTML = popHtml(kind);
  };
}
$$("[data-pop]").forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); if (popEl && popEl.dataset.kind === b.dataset.pop) return closePop(); openPop(b.dataset.pop, b); }; });
document.addEventListener("click", function (e) { if (popEl && !popEl.contains(e.target)) closePop(); });
$$("#views a, #qv button").forEach(function (a) { a.onclick = function () { state.view = a.dataset.view; closePop(); render(); }; });
/* 页签：工作 / 记录（设置是另一张稿） */
$$("[data-tab]").forEach(function (a) { a.onclick = function () { $$("[data-tab]").forEach(function (x) { x.classList.toggle("on", x === a); }); $("#tab-work").style.display = a.dataset.tab === "work" ? "flex" : "none"; $("#tab-records").hidden = a.dataset.tab !== "records"; }; });
/* 页头那一行状态：点了跳到对应的地方并筛好 */
$$("[data-jump]").forEach(function (a) { a.onclick = function () { if (a.dataset.jump === "deck") return; state.view = "list"; state.f = { d: [], s: a.dataset.jump === "doing" ? ["doing"] : [], due: a.dataset.jump === "today" ? "today" : "", src: [] }; render(); }; });
/* 交给它：一行，聚焦展开 */
var hand = $("#hand"), ta = $("#handText");
ta.onfocus = function () { hand.classList.add("open"); };
ta.onblur = function () { if (!ta.value) hand.classList.remove("open"); };
$$(".sug").forEach(function (s) { s.onmousedown = function (e) { e.preventDefault(); ta.value = s.textContent; hand.classList.add("open"); ta.focus(); }; });
/* 图表 */
function bars(id, a, b) { $(id).innerHTML = a.map(function (v, i) { return '<div class="bd"><i style="height:' + b[i] * 8 + 'px"></i><i class="a" style="height:' + v * 8 + 'px"></i></div>'; }).join(""); }
bars("#bars1", [4, 6, 3, 5, 4, 7, 9], [3, 4, 4, 3, 5, 4, 5]);
bars("#bars2", [2, 3, 5, 2, 4, 3, 4], [1, 2, 3, 2, 2, 3, 2]);
$("#chartsBtn").onclick = function () { $("#charts").classList.toggle("on"); this.classList.toggle("on"); };
/* 截图用的参数：?filter=1 ?group=duty ?banner=1 ?tab=records ?focus=1 ?charts=1 */
if (q.get("group")) state.group = q.get("group");
if (q.get("banner")) $("#banner").hidden = false;
render();
if (q.get("filter")) { state.f.d = ["mk"]; render(); openPop("filter", $("[data-pop=filter]")); }
if (q.get("tab") === "records") $("[data-tab=records]").click();
if (q.get("focus")) { ta.focus(); }
if (q.get("charts")) $("#chartsBtn").click();
function toggleBanner() { var b = $("#banner"); b.hidden = !b.hidden; b.scrollIntoView({ block: "center" }); }
function showView(v) { state.view = v; render(); $("#work").scrollIntoView({ block: "start" }); }
