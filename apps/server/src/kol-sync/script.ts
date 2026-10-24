/**
 * WP509：**在 ego 里往飞书表格写几行 / 改几格**的那一段脚本（交给 `ego-browser nodejs` 跑）。
 *
 * 飞书多维表格 / 电子表格的格子画在画布上，DOM 里没有格子（主会话 10-23 真机）。所以这一段只用四样：
 *
 * 1. **截住复制读整张表**（与 WP493 只读通道同一法）：点画布里一格 → 全选 → 复制，页面写出的 `text/plain`（TSV）/
 *    `text/bitable`（表头）被截下，不调原来的 `setData`——**用户的剪贴板不动**。
 * 2. **按键走格子**：只按方向键（可带 ControlOrMeta 跳到边上）；位置自己记着。
 * 3. **探一格**：选着一格按复制，截下来的就是这一格的字——每次写之前都先探一下，认准了才写。
 * 4. **原生粘贴**：ego 的 `page.keyboard.paste(tsv)`（发原生粘贴快捷键，事后恢复用户剪贴板；主会话真机验过一次写多行多列）。
 *    `dispatchEvent` 合成的粘贴不可靠，不用。
 *
 * 一趟的步骤：打开 → 认登录 / 没权限 → 读整张表（写之前那一份）→ 认列（少了列一格不写）→ 定位左上角 →
 * 改已有的行（按认行那一格的原字找行；探认行格对得上才写；对不上 → 这一件退回「追加一行进展记录」）→
 * 追加新行（先用表尾的空行；多维表格没有空行时按白名单字样点「添加记录」，重读确认真多了一行空行；
 * 电子表格数据下面本来就是空行）→ **再读一遍整张表核对**：写过的格子是不是写进去了；
 * **没写的格子有没有被改动——有就按 ControlOrMeta+Z 把这一趟全撤掉**，照实回 `rolled_back`。
 *
 * 能按的键只有 {@link EGO_SHEET_KEYS} 里那几个（测试逐字查）；不打字（`type` / `insertText` / `fill` 一处都没有）；
 * 唯一的 DOM 点击是「添加记录」，字样过白名单、碰到黑名单（删除 / 分享 / 发送…）拒点。
 *
 * 结果写进 `CFG.out`（本机临时文件），最后一行打印 `@@FINAL {state, …}`；每趟 `finish({ keep: [] })` 收空间。
 */

/** 只许按的键。 */
export const EGO_SHEET_KEYS: readonly string[] = [
  'ControlOrMeta+A',
  'ControlOrMeta+C',
  'ControlOrMeta+Z',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ControlOrMeta+ArrowUp',
  'ControlOrMeta+ArrowLeft',
]

/** 「添加一行」那一下允许点的字样（多维表格表尾 / 工具条上的那个按钮）。 */
export const EGO_SHEET_ADD_ROW =
  '^\\s*(\\+\\s*)?(添加记录|新增记录|新建记录|添加一行|新增一行|Add (a )?record|New record|Add (a )?row)\\s*$'

/** 一律不点的字样。 */
export const EGO_SHEET_FORBID =
  '删除|清空|分享|邀请|发送|发布|提交|权限|导出|下载|复制链接|Delete|Remove|Clear|Share|Invite|Send|Publish|Submit|Permission|Export|Download'

/** 一件要做的事。 */
export type EgoSheetOp =
  | { id: string; op: 'append'; cells: Record<string, string> }
  | {
      id: string
      op: 'update'
      /** 认行那一列里这一行的原字（上一次读回 / 写进去的）。 */
      key_text: string
      cells: Record<string, string>
      /** 认不准那一行时追加的进展行（不给 = 照实回失败）。 */
      fallback?: Record<string, string>
    }

export interface EgoSheetScriptConfig {
  space: string
  url: string
  /** 结果写到哪（本机绝对路径）。 */
  out: string
  /** `auto` = 读回来看有没有 `text/bitable`。 */
  kind: 'bitable' | 'sheet' | 'auto'
  /** 认行那一列（没有 = 只能追加）。 */
  key_column?: string
  ops: EgoSheetOp[]
  settle_ms?: number
  /** 点画布哪一格开始（相对最大那块画布左上角，CSS 像素）。 */
  at?: { x: number; y: number }
  /** 方向键最多按几下（再大的表退回进展行）。 */
  max_moves?: number
  /** 结束前截一张图（本机联调用，产品里不给）。 */
  shot?: string
}

/** 拼一段完整脚本。 */
export function egoSheetScript(cfg: EgoSheetScriptConfig): string {
  const injected = {
    ...cfg,
    keys: EGO_SHEET_KEYS,
    add_row: EGO_SHEET_ADD_ROW,
    forbid: EGO_SHEET_FORBID,
  }
  return `const CFG = ${JSON.stringify(injected)};\n${BODY_HEAD}${BODY_COPY}${BODY_MAIN}`
}

const BODY_HEAD = String.raw`
const fs = await import("node:fs/promises");
const t0 = Date.now();
let task;
let page;
let mutations = 0;
let moves = 0;
const results = new Map();
const msg = (e) => String((e && e.message) || e).slice(0, 300);
const HUMAN = /user (now )?controls|permission prompt|handed (off|over)|inactive|unassigned|takeOverTaskSpace/i;
const LOGIN_HOSTS = /(^|\.)(passport\.feishu\.cn|accounts\.feishu\.cn|passport\.larksuite\.com|accounts\.larksuite\.com|login\.)/i;
const NO_ACCESS = /没有权限|无权限|暂无权限|申请权限|无访问权限|you need (access|permission)|request access|no permission/i;
const wait = (ms) => page.waitForTimeout(ms);
const report = { kind: CFG.kind, header: [], before_rows: [], after_rows: [], mutations: 0, tactic: undefined };
const done = async (state, why, extra) => {
  let closed = false;
  if (task && state !== "needs_human") {
    try {
      await task.finish({ keep: [] });
      closed = true;
    } catch {}
  }
  const final = { state, ...(why ? { why: String(why).slice(0, 300) } : {}), ...(task ? { space_id: task.spaceId } : {}), closed, duration_ms: Date.now() - t0 };
  const full = { ...final, ...report, mutations, ops: [...results.values()], ...(extra || {}) };
  full.before_rows = (full.before_rows || []).slice(0, 3000);
  full.after_rows = (full.after_rows || []).slice(0, 3000);
  try {
    await fs.writeFile(CFG.out, JSON.stringify(full));
  } catch (e) {
    final.write_error = msg(e);
  }
  console.log("@@FINAL " + JSON.stringify(final));
};
const result = (op, r, extra) => results.set(op.id, { id: op.id, op: op.op, result: r, ...(extra || {}) });

// 只许按白名单里的键
const press = async (key) => {
  if (!CFG.keys.includes(key)) throw new Error("refused-key: " + key);
  await page.keyboard.press(key);
};

// TSV → 格子（空行保留；Excel 同款引号）
const parseTsv = (text) => {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const t = String(text).replace(/\r\n?/g, "\n");
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"' && cell === "") quoted = true;
    else if (c === "\t") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
};
const unescape = (s) =>
  String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const map = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return map[e.toLowerCase()] ?? m;
  });
const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
// 数字列复制出来可能带千分位：比对时去掉
const same = (a, b) => {
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  const nx = x.replace(/[,，\s]/g, "");
  const ny = y.replace(/[,，\s]/g, "");
  return nx !== "" && nx === ny;
};
`

/** 截住复制、读整张表、探一格、走格子。 */
const BODY_COPY = String.raw`
// 截住「复制」：记下 (type, value)，不调原来的 setData / writeText（用户剪贴板不动）。回画布的位置。
const arm = () =>
  page.evaluate(() => {
    const w = window;
    w.__agentswsCopy = [];
    if (!w.__agentswsCopyOn) {
      w.__agentswsCopyOn = true;
      const keep = (type, value) => {
        try {
          w.__agentswsCopy.push([String(type), String(value).slice(0, 8000000)]);
        } catch {}
      };
      DataTransfer.prototype.setData = function (type, value) {
        keep(type, value);
      };
      const cb = navigator.clipboard;
      if (cb) {
        try {
          cb.writeText = async (t) => keep("text/plain", t);
          cb.write = async (items) => {
            for (const it of items || [])
              for (const type of it.types || []) {
                try {
                  keep(type, await (await it.getType(type)).text());
                } catch {}
              }
          };
        } catch {}
      }
    }
    const canvases = [...document.querySelectorAll("canvas")]
      .map((c) => c.getBoundingClientRect())
      .filter((r) => r.width > 200 && r.height > 120)
      .sort((a, b) => b.width * b.height - a.width * a.height);
    const r = canvases[0];
    return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : undefined;
  });
const copied = () => page.evaluate(() => window.__agentswsCopy || []);
const clearCopied = () => page.evaluate(() => { window.__agentswsCopy = []; });
let canvas;
const clickCell = async () => {
  // 先 Esc 两下：万一停在格内编辑，退出来（不提交）
  await press("Escape");
  await press("Escape");
  const at = CFG.at || { x: 220, y: 90 };
  const x = canvas.x + Math.min(at.x, canvas.w - 10);
  const y = canvas.y + Math.min(at.y, canvas.h - 10);
  await page.mouse.click(x, y, { label: "select a table cell" });
  await wait(400);
  // 点的正好是已选中的那一格时会进格内编辑：再 Esc 一下退出来（不提交），留在「选中」
  await press("Escape");
  await wait(200);
};
// 读整张表：点一格（已经选着一格时不再点）→ 全选 → 复制 → Esc
const readGrid = async (click = true) => {
  if (click) await clickCell();
  await clearCopied();
  await press("ControlOrMeta+A");
  await wait(300);
  await press("ControlOrMeta+C");
  await wait(1000);
  const got = await copied();
  // 全选之后 Esc 只是取消全选；之后要再点一格才有「选中的格子」
  await press("Escape");
  const of = (re) => [...got].reverse().find(([t, v]) => re.test(t) && String(v).trim() !== "");
  const plain = of(/^text\/plain/i);
  const bit = of(/^text\/bitable/i);
  let fields;
  if (bit) {
    try {
      const j = JSON.parse(unescape(bit[1]));
      const list = Array.isArray(j.header) ? j.header : Array.isArray(j.fields) ? j.fields : [];
      fields = list.map((f, i) => (f && typeof f.name === "string" && f.name.trim() !== "" ? f.name : "列" + (i + 1)));
      if (fields.length === 0) fields = undefined;
    } catch {}
  }
  const kind = CFG.kind === "auto" ? (fields ? "bitable" : "sheet") : CFG.kind;
  const grid = plain ? parseTsv(plain[1]) : [];
  if (kind === "bitable") {
    if (!fields) return undefined;
    return { kind, header: fields, rows: grid.map((r) => fields.map((_, i) => r[i] ?? "")) };
  }
  const head = grid[0];
  if (!head) return undefined;
  let width = head.length;
  while (width > 0 && String(head[width - 1]).trim() === "") width -= 1;
  if (width === 0) return undefined;
  const header = head.slice(0, width).map((h, i) => (String(h).trim() === "" ? "列" + (i + 1) : String(h).trim()));
  return { kind, header, rows: grid.slice(1).map((r) => header.map((_, i) => r[i] ?? "")) };
};
// 探一格：选着它按复制，截下来的就是这一格的字
const probe = async () => {
  await clearCopied();
  await press("ControlOrMeta+C");
  await wait(350);
  const got = await copied();
  const hit = [...got].reverse().find(([t]) => /^text\/plain/i.test(t));
  return hit ? String(hit[1]).replace(/\n$/, "") : "";
};
// 位置：表格行号（电子表格第 0 行是表头，多维表格第 0 行是第一条记录）、列号
let cur = { r: 0, c: 0 };
let off = 0;
const step = async (key, n) => {
  for (let i = 0; i < n; i += 1) {
    if (moves >= (CFG.max_moves || 4000)) throw new Error("too-many-moves");
    moves += 1;
    await press(key);
  }
};
const moveTo = async (r, c) => {
  if (r > cur.r) await step("ArrowDown", r - cur.r);
  if (r < cur.r) await step("ArrowUp", cur.r - r);
  if (c > cur.c) await step("ArrowRight", c - cur.c);
  if (c < cur.c) await step("ArrowLeft", cur.c - c);
  cur = { r, c };
  await wait(120);
};
// 定位左上角：点一格 → 跳到最上、最左；探两格认准（左上角那格 + 同一行认行那一格）
const anchor = async (grid, keyIdx) => {
  await clickCell();
  const first = off === 1 ? grid.header : grid.rows[0];
  if (!first) return false;
  // 跳到最上、最左（一列里有空格时一跳可能停在半路：再跳，最多三回）
  let a;
  for (let i = 0; i < 3; i += 1) {
    await press("ControlOrMeta+ArrowUp");
    await press("ControlOrMeta+ArrowLeft");
    await wait(300);
    a = await probe();
    if (same(a, first[0] ?? "")) break;
  }
  cur = { r: 0, c: 0 };
  if (!same(a, first[0] ?? "")) return false;
  const k = keyIdx >= 0 ? keyIdx : first.findIndex((v, i) => i > 0 && norm(v) !== "");
  if (k > 0) {
    await moveTo(0, k);
    const b = await probe();
    if (!same(b, first[k] ?? "")) return false;
  }
  return true;
};
`

/** 改、追加、核对、撤销。 */
const BODY_MAIN = String.raw`
// 一行里要写的格子 → 连续的几段（列号相邻的拼成一段 TSV，一次粘贴）
const runsOf = (cells, idx) => {
  const cols = Object.keys(cells).map((name) => [idx[name], cells[name]]).filter(([i]) => i !== undefined).sort((a, b) => a[0] - b[0]);
  const runs = [];
  for (const [i, v] of cols) {
    const last = runs[runs.length - 1];
    if (last && last.start + last.values.length === i) last.values.push(v);
    else runs.push({ start: i, values: [v] });
  }
  return runs;
};
const clean = (v) => String(v == null ? "" : v).replace(/[\t\r\n]+/g, " ").trim();
const paste = async (values) => {
  await page.keyboard.paste(values.map(clean).join("\t"));
  mutations += 1;
  await wait(500);
};
// 写一行（gr = 表格行号）：每一段先探第一格，对得上才粘
const writeRow = async (gr, cells, idx, expectBlank, before) => {
  const written = [];
  for (const run of runsOf(cells, idx)) {
    await moveTo(gr, run.start);
    const now = await probe();
    const want = expectBlank ? "" : (before[run.start] ?? "");
    if (!same(now, want)) return { ok: false, why: "cell-mismatch", written };
    await paste(run.values);
    for (let j = 0; j < run.values.length; j += 1) written.push([run.start + j, clean(run.values[j])]);
  }
  return { ok: true, written };
};
// 多维表格：按「添加记录」多出一行空行（字样过白名单 / 黑名单）
const ADD = new RegExp(CFG.add_row, "i");
const FORBID = new RegExp(CFG.forbid, "i");
const addRowButton = async () => {
  const found = await page.evaluate((src) => {
    const re = new RegExp(src, "i");
    const all = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        all.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    for (const el of all) if (el.getAttribute && el.getAttribute("data-agentsws-add") === "t") el.removeAttribute("data-agentsws-add");
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    };
    const labels = (el) => [el.innerText || el.textContent || "", el.getAttribute("aria-label") || "", el.getAttribute("title") || ""].map((v) => String(v).replace(/\s+/g, " ").trim());
    const hit = all.filter((el) => visible(el) && labels(el).some((v) => re.test(v)));
    if (hit.length === 0) return null;
    const pick = hit.filter((el) => !hit.some((o) => o !== el && el.contains(o))).at(-1);
    pick.setAttribute("data-agentsws-add", "t");
    const ls = labels(pick);
    return { matched: ls.find((v) => re.test(v)) || "", all: ls.join(" ").slice(0, 200) };
  }, CFG.add_row);
  if (!found || !ADD.test(found.matched)) return false;
  if (FORBID.test(found.all)) throw new Error("refused-click: " + found.all.slice(0, 60));
  await page.click('[data-agentsws-add="t"]', { label: "add one table row" });
  mutations += 1;
  await wait(800);
  // 弹了记录卡片就 Esc 关掉（不填）
  await press("Escape");
  await wait(300);
  return true;
};

try {
  try {
    task = await taskSpace(CFG.space);
  } catch (e) {
    task = undefined;
    await done(HUMAN.test(msg(e)) && !/already exists|NAME_IN_USE/i.test(msg(e)) ? "needs_human" : "failed", msg(e));
  }
  if (task) {
    console.log("@@SPACE " + task.spaceId);
    page = task.page("p1");
    try {
      await page.goto(CFG.url, { timeout: 30000 });
    } catch (e) {
      report.open_error = msg(e);
    }
    await wait(CFG.settle_ms || 6000);
    const look = await page.evaluate(() => ({
      url: location.href,
      text: String((document.body && document.body.innerText) || "").slice(0, 20000),
      pw: document.querySelectorAll('input[type="password"]').length,
    }));
    let host = "";
    try {
      host = new URL(look.url).hostname;
    } catch {}
    canvas = await arm();
    if (LOGIN_HOSTS.test(host) || look.pw > 0) await done("login");
    else if (!canvas && NO_ACCESS.test(look.text)) await done("no_access");
    else if (!canvas) await done("unreadable", "no-canvas");
    else await run();
  }
} catch (e) {
  const m = msg(e);
  await done(HUMAN.test(m) ? "needs_human" : "failed", m);
}

async function run() {
  const g0 = await readGrid();
  if (!g0) return done("unreadable", "nothing-copied");
  report.kind = g0.kind;
  report.header = g0.header;
  report.before_rows = g0.rows;
  off = g0.kind === "sheet" ? 1 : 0;
  const idx = {};
  g0.header.forEach((h, i) => {
    if (idx[h] === undefined) idx[h] = i;
  });
  const wanted = new Set();
  for (const op of CFG.ops) for (const name of Object.keys(op.cells).concat(Object.keys(op.fallback || {}))) wanted.add(name);
  if (CFG.key_column) wanted.add(CFG.key_column);
  const missing = [...wanted].filter((n) => idx[n] === undefined);
  if (missing.length > 0) return done("columns_changed", "missing: " + missing.join(", "), { missing_columns: missing });
  const keyIdx = CFG.key_column ? idx[CFG.key_column] : -1;
  if (!(await anchor(g0, keyIdx))) return done("cannot_locate", "anchor");
  const rows = g0.rows;
  const before = (gr) => (gr < off ? g0.header : rows[gr - off] || []);
  const touched = new Map();
  const mark = (gr, written) => {
    const m = touched.get(gr) || new Map();
    for (const [c, v] of written) m.set(c, v);
    touched.set(gr, m);
  };
  const appends = [];

  // ① 改已有的行（按行号从上往下，少走几步）
  const updates = CFG.ops.filter((o) => o.op === "update").map((op) => {
    const hits = keyIdx < 0 ? [] : rows.map((r, i) => (norm(r[keyIdx]) === norm(op.key_text) ? i : -1)).filter((i) => i >= 0);
    return { op, hits };
  });
  updates.sort((a, b) => (a.hits[0] ?? 1e9) - (b.hits[0] ?? 1e9));
  for (const { op, hits } of updates) {
    const giveUp = (why) => {
      if (op.fallback) appends.push({ op, cells: op.fallback, fallback: why });
      else result(op, why);
    };
    if (hits.length === 0) {
      giveUp("not_found");
      continue;
    }
    if (hits.length > 1) {
      giveUp("ambiguous");
      continue;
    }
    const gr = hits[0] + off;
    try {
      await moveTo(gr, keyIdx);
      const k = await probe();
      if (!same(k, op.key_text)) {
        giveUp("locate_failed");
        continue;
      }
      const w = await writeRow(gr, op.cells, idx, false, before(gr));
      mark(gr, w.written);
      if (!w.ok) {
        if (w.written.length === 0) giveUp("locate_failed");
        else result(op, "partial", { row: hits[0], why: w.why });
        continue;
      }
      result(op, "updated", { row: hits[0] });
    } catch (e) {
      if (/too-many-moves/.test(msg(e))) giveUp("too_big");
      else throw e;
    }
  }

  // ② 追加：先用表尾的空行；电子表格数据下面本来就是空行；多维表格不够就点「添加记录」再读一遍确认
  for (const op of CFG.ops) if (op.op === "append") appends.push({ op, cells: op.cells });
  if (appends.length > 0) {
    let last = rows.length - 1;
    while (last >= 0 && rows[last].every((v) => norm(v) === "")) last -= 1;
    const free = [];
    for (let i = last + 1; i < rows.length; i += 1) free.push(i);
    let fresh = rows.length;
    if (g0.kind === "sheet") {
      while (free.length < appends.length) free.push(fresh++);
      report.tactic = "sheet";
    } else if (free.length < appends.length) {
      let tries = appends.length - free.length;
      let added = 0;
      while (tries > 0) {
        tries -= 1;
        if (!(await addRowButton())) break;
        added += 1;
      }
      if (added > 0) {
        const g1 = await readGrid();
        const grew = g1 ? g1.rows.length - rows.length : 0;
        for (let i = 0; i < grew; i += 1) {
          const r = g1.rows[rows.length + i] || [];
          if (r.every((v) => norm(v) === "")) free.push(rows.length + i);
        }
        report.tactic = "button";
        if (!(await anchor(g0, keyIdx))) return finishUp(g0, idx, touched, "cannot_locate");
      } else report.tactic = free.length > 0 ? "blank" : "none";
    } else report.tactic = "blank";
    for (const a of appends) {
      const target = free.shift();
      const r = (why) => result(a.op, why, a.fallback ? { fallback_for: a.fallback } : {});
      if (target === undefined) {
        r("no_new_row");
        continue;
      }
      try {
        const gr = target + off;
        const w = await writeRow(gr, a.cells, idx, true, []);
        mark(gr, w.written);
        if (!w.ok) r(w.written.length === 0 ? "no_new_row" : "partial");
        else result(a.op, a.fallback ? "fallback_appended" : "appended", { row: target, ...(a.fallback ? { fallback_for: a.fallback } : {}) });
      } catch (e) {
        if (/too-many-moves/.test(msg(e))) r("too_big");
        else throw e;
      }
    }
  }
  return finishUp(g0, idx, touched, "ok");
}

// ③ 再读一遍核对：写过的格子写进去没有；没写的格子一格都不许变——变了就把这一趟全撤掉
async function finishUp(g0, idx, touched, state) {
  if (mutations === 0) {
    report.after_rows = g0.rows;
    return done(state);
  }
  await wait(800);
  const g1 = (await readGrid(false)) || (await readGrid(true));
  if (!g1) return done("failed", "reread");
  report.after_rows = g1.rows;
  const collateral = [];
  const height = Math.max(g0.rows.length, g1.rows.length);
  for (let i = 0; i < height; i += 1) {
    const gr = i + off;
    const was = g0.rows[i] || [];
    const now = g1.rows[i] || [];
    const mine = touched.get(gr) || new Map();
    for (let c = 0; c < g0.header.length; c += 1) {
      if (mine.has(c)) continue;
      if (!same(was[c] ?? "", now[c] ?? "")) collateral.push([i, c]);
    }
  }
  const missed = [];
  for (const [gr, cells] of touched) for (const [c, v] of cells) if (!same((g1.rows[gr - off] || [])[c] ?? "", v)) missed.push([gr - off, c]);
  for (const r of results.values()) {
    if (r.row === undefined) continue;
    const bad = missed.filter(([i]) => i === r.row).map(([, c]) => g0.header[c]);
    if (bad.length > 0) {
      r.result = r.result === "updated" || r.result === "appended" || r.result === "fallback_appended" ? "verify_failed" : r.result;
      r.why = "not-landed: " + bad.join(", ");
    }
  }
  if (collateral.length === 0) return done(state);
  // 没写的格子变了：这一趟全撤掉（ControlOrMeta+Z 按写过的次数），再读一遍看撤干净没有
  for (let i = 0; i < mutations; i += 1) {
    await press("ControlOrMeta+Z");
    await wait(300);
  }
  await wait(800);
  const g2 = (await readGrid(false)) || (await readGrid(true));
  report.after_rows = g2 ? g2.rows : g1.rows;
  const restored = !!g2 && g0.rows.every((r, i) => r.every((v, c) => same(v, (g2.rows[i] || [])[c] ?? "")));
  for (const r of results.values()) if (r.result !== "not_found" && r.result !== "ambiguous") r.result = "undone";
  return done(restored ? "rolled_back" : "rollback_unsure", "collateral: " + collateral.slice(0, 5).map(([i, c]) => (i + 1) + ":" + g0.header[c]).join(", "), { collateral: collateral.length });
}
`
