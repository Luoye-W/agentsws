/* ── 视图渲染 ── */
function vList(list) {
  return groups(list).map(function (g) {
    var fold = state.group === "status" && state.fold[g.key];
    var rows = g.items.map(function (w) {
      return '<div class="row' + (w.s === "done" ? " done" : "") + '">' + stIcon(w.s) + kindIcon(w.k) + '<span class="tt">' + esc(w.t) + '</span><span class="pg">' + esc(w.p) + "</span>" + dutyTag(w.d) + dueCell(w) + whoAv(w) + "</div>";
    }).join("");
    var add = g.key === "you" || g.key === "all" ? '<button class="addrow" type="button"><svg class="ico s14"><use href="#i-plus"/></svg>加一个待办</button>' : "";
    return '<div class="grp' + (fold ? " fold" : "") + '" data-g="' + g.key + '"><div class="gh"><svg class="ico s14 tw"><use href="#i-cd"/></svg>' + g.head + '<span class="c">' + g.items.length + '</span></div><div class="card rows">' + (rows || '<div class="none-line" style="padding:10px 14px">这一组是空的</div>') + add + "</div></div>";
  }).join("");
}
function vBoard(list) {
  return '<div class="board">' + ["you", "doing", "others", "done"].map(function (s) {
    var items = list.filter(function (w) { return w.s === s; });
    return '<div class="col" data-s="' + s + '"><div class="gh">' + stIcon(s) + ST[s].name + '<span class="c">' + items.length + "</span></div>" + items.map(function (w) {
      return '<div class="kc" draggable="true" data-id="' + w.id + '"><div class="tt">' + esc(w.t) + '</div><div class="pg">' + esc(w.p) + '</div><div class="mt">' + dutyTag(w.d) + dueCell(w) + "</div></div>";
    }).join("") + "</div>";
  }).join("") + "</div>";
}
function evHtml(w, wk) {
  var c = ST[w.s].c;
  return '<div class="ev' + (w.s === "done" ? " done" : "") + '" style="--c:' + c + '" data-tip="' + esc(w.t) + '">' + (wk ? '<span>' + esc(w.t) + "</span><small>" + DUTY[w.d].name + (w.due.length > 5 ? " · " + w.due.slice(6) : "") + "</small>" : '<span>' + esc(w.t) + "</span>") + "</div>";
}
function vCal(list) {
  var dated = list.filter(function (w) { return w.due; });
  var head = '<div class="calh"><button class="btn xs icon ghost" type="button"><svg class="ico s14"><use href="#i-cl"/></svg></button><button class="btn xs icon ghost" type="button"><svg class="ico s14"><use href="#i-cr"/></svg></button><b>' + (state.cal === "month" ? "2026 年 10 月" : "10 月 5 日 – 11 日") + '</b><span class="tag">只看这个岗位</span><div class="r"><button class="btn xs out" type="button">今天</button><div class="tabs" id="calseg" style="height:28px"><a data-cal="month" class="' + (state.cal === "month" ? "on" : "") + '" style="font-size:12.5px;padding:0 10px">月</a><a data-cal="week" class="' + (state.cal === "week" ? "on" : "") + '" style="font-size:12.5px;padding:0 10px">周</a></div></div></div>';
  var wd = ["一", "二", "三", "四", "五", "六", "日"];
  if (state.cal === "week") {
    var cols = [5, 6, 7, 8, 9, 10, 11].map(function (d, i) {
      var key = "10-" + (d < 10 ? "0" + d : d);
      var items = dated.filter(function (w) { return md(w.due) === key; });
      return '<div class="wc' + (key === TODAY ? " today" : "") + '"><div class="wh">周' + wd[i] + "<b>" + d + "</b></div>" + items.map(function (w) { return evHtml(w, true); }).join("") + "</div>";
    }).join("");
    return '<div class="card">' + head + '<div class="wgrid">' + cols + "</div></div>";
  }
  var cells = wd.map(function (x) { return '<div class="wd">' + x + "</div>"; }).join("");
  for (var i = 0; i < 35; i++) {
    var day = i - 2; // 10-01 是周四
    var out = day < 1 || day > 31;
    var label = out ? (day < 1 ? 30 + day : day - 31) : day;
    var key = "10-" + (day < 10 ? "0" + day : day);
    var items = out ? [] : dated.filter(function (w) { return md(w.due) === key; });
    if (!out && (day === 16 || day === 23 || day === 30)) items = items.concat([{ t: "r/INMO 每周问答帖", d: "cm", s: "doing", due: key + " 09:00" }]);
    var more = items.length > 3 ? '<div class="muted" style="font-size:11px;padding-left:4px">还有 ' + (items.length - 3) + " 件</div>" : "";
    cells += '<div class="dc' + (out ? " out" : "") + (key === TODAY && !out ? " today" : "") + '"><span class="dn">' + label + "</span>" + items.slice(0, 3).map(function (w) { return evHtml(w); }).join("") + more + "</div>";
  }
  return '<div class="card">' + head + '<div class="mgrid">' + cells + "</div></div>";
}
var COLS = { d: "职责", s: "状态", due: "截止", cost: "花费积分", src: "来源", upd: "最近更新" };
function vTable(list) {
  var th = '<th>标题<svg class="ico s12"><use href="#i-sort"/></svg></th>' + state.cols.map(function (c) { return "<th>" + COLS[c] + "</th>"; }).join("");
  var tr = list.map(function (w) {
    var cell = { d: dutyTag(w.d), s: '<span class="stc">' + stIcon(w.s) + ST[w.s].name + "</span>", due: dueCell(w), cost: '<span class="num">' + (w.cost ? w.cost.toFixed(1) : "—") + "</span>", src: SRC[w.src], upd: '<span class="muted">' + w.upd + "</span>" };
    return '<tr><td class="tt">' + esc(w.t) + "</td>" + state.cols.map(function (c) { return "<td>" + cell[c] + "</td>"; }).join("") + "</tr>";
  }).join("");
  var total = list.reduce(function (a, w) { return a + w.cost; }, 0);
  return '<div class="card tbl"><table><thead><tr>' + th + "</tr></thead><tbody>" + tr + '</tbody></table><div class="muted" style="font-size:12px;padding:10px 12px;border-top:1px solid var(--ws-line)">' + list.length + " 件 · 合计花了 " + total.toFixed(1) + " 积分</div></div>";
}
function vCommunity() {
  var r = function (tone, ic, title, sub, act) { return '<div class="qrow"><span class="ic ' + tone + '"><svg class="ico"><use href="#' + ic + '"/></svg></span><div class="tx"><div>' + title + "</div><small>" + sub + '</small></div><div class="act">' + act + "</div></div>"; };
  return '<div class="card"><div class="qhead"><img src="' + REDDIT + '" width="16" height="16" alt=""><b>r/INMO 待处理</b>· 职责「自家版」的专属工具<div class="r"><a class="btn xs ghost" href="#">在职责页打开<svg class="ico s12"><use href="#i-up"/></svg></a></div></div>' +
    r("t-brand", "i-plus", "4 个人申请进版", "都有 30 天以上的号，没发过广告", '<button class="btn sm pri" type="button">全放进来</button><button class="btn sm out" type="button">逐个看</button>') +
    r("t-bad", "i-warn", "1 条帖子被举报：疑似广告链接", "u/****_deals · 「便宜 50% 的 INMO 渠道」", '<button class="btn sm pri" type="button">删帖</button><button class="btn sm out" type="button">留着</button>') +
    r("t-info", "i-file", "2 条新帖等审核", "都是求助帖，Agent 建议放行", '<button class="btn sm pri" type="button">都放行</button><button class="btn sm out" type="button">逐个看</button>') + "</div>";
}
function vSchedule() {
  var days = ["5 一", "6 二", "7 三", "8 四", "9 五", "10 六", "11 日"];
  var head = '<div class="lh">版</div>' + days.map(function (d, i) { return '<div class="lh' + (i === 1 ? " today" : "") + '">' + d + "</div>"; }).join("");
  var lane = function (name, sub, cells) { return '<div class="sub">' + name + "<small>" + sub + "</small></div>" + cells.map(function (c, i) { return '<div class="' + (c === "cool" ? "cool" : "") + (i === 1 ? " today" : "") + '">' + (c && c !== "cool" ? c : "") + "</div>"; }).join(""); };
  var ev = function (t, s) { return '<div class="ev" style="--c:' + ST[s].c + '"><span>' + t + "</span></div>"; };
  return '<div class="card"><div class="qhead"><svg class="ico s14"><use href="#i-calclock"/></svg><b>发帖排期</b>· 斜线 = 这个版的冷却期，不能发<div class="r"><a class="btn xs ghost" href="#">在职责页打开<svg class="ico s12"><use href="#i-up"/></svg></a></div></div><div class="lane">' + head +
    lane("r/SmartGlasses", "能发 · 72 小时冷却", ["", ev("回帖：近视求助", "you"), "cool", "cool", "", ev("Air 3 使用一周", "doing"), ""]) +
    lane("r/augmentedreality", "等版主答复", ["", "", ev("盯评测评论", "doing"), "", "", "", ""]) +
    lane("r/INMO", "自家版", ["", "", "", ev("置顶公告", "you"), ev("每周问答帖", "doing"), "", ""]) +
    lane("r/gadgets", "只能答不能发", ["", "", "", "", "", "", ""]) + "</div></div>";
}
