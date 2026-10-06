/* 合成数据：照 10-06 Windows 真机那轮 INMO Reddit 调研编的（不含真实用户名 / 邮箱）。今天 = 2026-10-06（周二） */
var REDDIT = "{{REDDIT}}";
var DUTY = {
  mk: { name: "Reddit 营销", glyph: "g-pr" },
  cm: { name: "自家版", glyph: "g-social" },
};
var ST = {
  you: { name: "等你", tip: "等你批、等你选、你自己的待办", c: "var(--ws-warn)" },
  doing: { name: "进行中", tip: "Agent 正在做", c: "var(--ws-brand)" },
  others: { name: "等别人", tip: "等公关、客服、版主回话", c: "var(--ws-info)" },
  done: { name: "已完成", tip: "", c: "var(--ws-good)" },
};
var KIND = { card: ["i-stamp", "卡 · 要你拍板"], matter: ["i-matter", "事项"], todo: ["i-sq", "待办 · 你自己做"], post: ["i-calclock", "排期 · 到点发"] };
var SRC = { you: "你交的", agent: "Agent 发现", cron: "定时", mail: "来信" };
var WORK = [
  { id: 1, t: "回帖草稿：「近视能戴 INMO Air 3 吗？」", d: "mk", s: "you", k: "card", due: "10-06 18:00", p: "草稿写好了，带镜片夹片的说明", src: "agent", cost: 0.6, upd: "25 分钟前", who: "AI" },
  { id: 2, t: "有人说 INMO「召回」，怎么处理？", d: "mk", s: "you", k: "card", due: "10-06", p: "出处只有一条评论，没核实", src: "agent", cost: 0.2, upd: "1 小时前", who: "AI" },
  { id: 3, t: "r/INMO 置顶公告：固件 2.1 续航说明", d: "cm", s: "you", k: "card", due: "10-08", p: "草稿等你批", src: "you", cost: 0.3, upd: "1 小时前", who: "AI" },
  { id: 4, t: "私信 r/SmartGlasses 版主：能否挂官方 flair", d: "mk", s: "you", k: "todo", due: "10-06", p: "你来发，Agent 起草了一版", src: "you", cost: 0, upd: "今天 09:12", who: "舟" },
  { id: 5, t: "INMO Reddit 口碑调研（第二轮）", d: "mk", s: "doing", k: "matter", due: "10-09", p: "取回 25 条，去掉同名噪音剩 10 条", src: "you", cost: 2.2, upd: "10 分钟前", who: "AI" },
  { id: 6, t: "盯 10-07 那篇评测帖的评论", d: "mk", s: "doing", k: "matter", due: "10-07", p: "评测明早发，发了第一时间看评论", src: "agent", cost: 0, upd: "2 小时前", who: "AI" },
  { id: 7, t: "5 条重点帖的回应口径", d: "mk", s: "doing", k: "matter", due: "10-08", p: "写完 3 / 5", src: "you", cost: 1.1, upd: "40 分钟前", who: "AI" },
  { id: 8, t: "r/INMO 每周问答帖", d: "cm", s: "doing", k: "post", due: "10-09 09:00", p: "排好了，到点自动发", src: "cron", cost: 0.1, upd: "昨天", who: "AI" },
  { id: 9, t: "r/INMO 新人入群审核", d: "cm", s: "doing", k: "matter", due: "", p: "今天放进 4 人，拦下 1 个广告号", src: "cron", cost: 0.4, upd: "3 小时前", who: "AI" },
  { id: 10, t: "「召回」说法核实（上周那条）", d: "mk", s: "others", k: "matter", due: "10-07", p: "交给公关了，等回话", src: "agent", cost: 0.3, upd: "昨天", who: "公" },
  { id: 11, t: "固件 2.1 续航投诉 3 条", d: "cm", s: "others", k: "matter", due: "10-07", p: "客户问题转客服，等客服回", src: "mail", cost: 0.2, upd: "今天 10:30", who: "客" },
  { id: 12, t: "r/augmentedreality 能否发官方帖", d: "mk", s: "others", k: "matter", due: "10-05", p: "10-04 私信了版主，还没回", src: "you", cost: 0, upd: "10-04", who: "版" },
  { id: 13, t: "INMO Reddit 口碑调研（第一轮）", d: "mk", s: "done", k: "matter", due: "10-06", p: "5 条重点帖、3 件要回应", src: "you", cost: 2.2, upd: "今天 14:20", who: "AI" },
  { id: 14, t: "r/INMO 版规改版", d: "cm", s: "done", k: "matter", due: "10-03", p: "加了「求助帖写型号和固件」", src: "you", cost: 0.5, upd: "10-03", who: "AI" },
  { id: 15, t: "找 5 个适合我们的版", d: "mk", s: "done", k: "matter", due: "10-02", p: "能发 2 个、只能答 2 个、别去 1 个", src: "you", cost: 0.9, upd: "10-02", who: "AI" },
];
var TODAY = "10-06";
var KEY = "wp239.position.reddit-ops"; // 视图记在这个岗位上
var state = { view: "list", group: "status", sort: "due", f: { d: [], s: [], due: "", src: [] }, cols: ["d", "s", "due", "cost", "src", "upd"], cal: "month", fold: { done: true } };
try { Object.assign(state, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (e) {}
var q = new URLSearchParams(location.search);
if (q.get("view")) state.view = q.get("view");
function save() { try { localStorage.setItem(KEY, JSON.stringify({ view: state.view, group: state.group, sort: state.sort, cols: state.cols, cal: state.cal })); } catch (e) {} }
var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

function di(d) { return '<span class="di"><svg class="gl"><use href="#' + DUTY[d].glyph + '"/></svg><img src="' + REDDIT + '" alt=""></span>'; }
function dutyTag(d) { return '<span class="duty">' + di(d) + DUTY[d].name + "</span>"; }
function stIcon(s) {
  if (s === "you") return '<svg class="st you" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2"/><circle class="f" cx="8" cy="8" r="2.6"/></svg>';
  if (s === "doing") return '<svg class="st doing" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2"/><path class="f" d="M8 3.6a4.4 4.4 0 0 1 0 8.8z"/></svg>';
  if (s === "others") return '<svg class="st others" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2"/><path d="M8 5.2V8l1.8 1.2"/></svg>';
  return '<svg class="st done" viewBox="0 0 16 16"><circle class="f" cx="8" cy="8" r="7"/><path d="m5.2 8.2 1.9 1.9 3.7-3.9"/></svg>';
}
function kindIcon(k) { return '<span class="kd" data-tip="' + KIND[k][1] + '"><svg class="ico s14"><use href="#' + KIND[k][0] + '"/></svg></span>'; }
function md(due) { return due ? due.slice(0, 5) : ""; }
function dueCell(w) {
  if (!w.due) return '<span class="due none">没有截止</span>';
  var m = md(w.due), cls = "due";
  if (w.s !== "done" && m === TODAY) cls += " today";
  else if (w.s !== "done" && m < TODAY) cls += " late";
  var label = m === TODAY ? "今天" + (w.due.length > 5 ? " " + w.due.slice(6) : "") : m === "10-07" ? "明天" : m + (w.due.length > 5 ? " " + w.due.slice(6) : "");
  return '<span class="' + cls + '">' + label + "</span>";
}
function whoAv(w) {
  var tone = w.who === "AI" ? "t-brand" : w.who === "舟" ? "t-warn" : "t-info";
  var tip = w.who === "AI" ? "Agent 在做" : w.who === "舟" ? "你" : w.who === "公" ? "公关岗位" : w.who === "客" ? "客服岗位" : "对方版主";
  return '<span class="av sm ' + tone + '" data-tip="' + tip + '">' + w.who + "</span>";
}

function passes(w) {
  var f = state.f;
  if (f.d.length && f.d.indexOf(w.d) < 0) return false;
  if (f.s.length && f.s.indexOf(w.s) < 0) return false;
  if (f.src.length && f.src.indexOf(w.src) < 0) return false;
  var m = md(w.due);
  if (f.due === "today" && m !== TODAY) return false;
  if (f.due === "week" && !(m >= "10-05" && m <= "10-11")) return false;
  if (f.due === "late" && !(m && m < TODAY && w.s !== "done")) return false;
  if (f.due === "none" && m) return false;
  return true;
}
function sorted(list) {
  var a = list.slice();
  if (state.sort === "due") a.sort(function (x, y) { return (md(x.due) || "99") < (md(y.due) || "99") ? -1 : 1; });
  if (state.sort === "upd") a.sort(function (x, y) { return x.id < y.id ? 1 : -1; });
  if (state.sort === "cost") a.sort(function (x, y) { return y.cost - x.cost; });
  return a;
}
function groups(list) {
  if (state.group === "duty") return ["mk", "cm"].map(function (d) { return { key: d, head: di(d) + DUTY[d].name, items: list.filter(function (w) { return w.d === d; }) }; });
  if (state.group === "due") {
    var b = [["late", "已过期"], ["today", "今天"], ["week", "这周"], ["later", "以后"], ["none", "没有截止"]];
    return b.map(function (x) {
      return { key: x[0], head: x[1], items: list.filter(function (w) {
        var m = md(w.due); if (!m) return x[0] === "none";
        if (m < TODAY) return x[0] === (w.s === "done" ? "week" : "late");
        if (m === TODAY) return x[0] === "today";
        return x[0] === (m <= "10-11" ? "week" : "later");
      }) };
    }).filter(function (g) { return g.items.length; });
  }
  if (state.group === "none") return [{ key: "all", head: "全部", items: list }];
  return ["you", "doing", "others", "done"].map(function (s) { return { key: s, head: stIcon(s) + ST[s].name + (ST[s].tip ? ' <span class="hint" tabindex="0" data-hint="' + ST[s].tip + '">?</span>' : ""), items: list.filter(function (w) { return w.s === s; }) }; });
}
