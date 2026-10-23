/**
 * WP493（决策 1718 / 1708）：**在 ego 里只读一页**的那一段脚本（交给 `ego-browser nodejs` 跑）。
 *
 * 和 `ego-write/script.ts` 分开写，为的是这一份能被一眼审完、被测试逐字查：**只读**。
 *
 * 一趟 = 开一个新的 AI 空间（名字每趟不同）→ 打开一个地址 → 按顺序做几步 → `finish({ keep: [] })` 收掉
 * （不留标签页给人关）。能做的只有这几样：
 *
 * | 步 | 做什么 | 只读怎么保证 |
 * |---|---|---|
 * | `read` | 取正文 / 原文 / 表格（`<table>` 与无障碍表格 `role=grid`）/ 密码框个数 / 可选无障碍快照 | 只在页面里读（`evaluate` 只读 DOM） |
 * | `fetch` | 用这一页的登录态 GET 几个同源地址（Reddit 的 `.json`、Google 的导出 CSV） | 只 GET；跨源的一律不发 |
 * | `download_url` | 打开一个「直接下载」的地址，把下下来的文件存到给定位置 | 只是打开一个地址 |
 * | `copy` | 画布表格（飞书多维表格 / 表格）：先在页面里截住「复制」写出的内容，点一下画布里的一格 → 全选 → 复制 → Esc | 只按 {@link EGO_READ_KEYS} 这三个键（不打字）；截住的 `setData` 不调原来那一个——**不改用户的剪贴板**；点的是格子（单击只是选中，不进编辑） |
 * | `export` | 依次点几个菜单项（「更多 → 下载为 → Excel」）等下载 | 每一点都过白名单（{@link EGO_READ_SAFE_CLICK}），碰到黑名单字样（发送 / 提交 / 删除 / 分享…）拒点 |
 *
 * 脚本里**没有** `fill` / `type` / `insertText` / `paste` / `selectOption` / `setInputFiles` / 对话框处理；
 * `click` 只出现在 `safeClick` 一处、`mouse.click` 只出现在 `copy` 一处，按键只走 `pressKey`（白名单三个键）——测试逐字查。
 *
 * 结果写进 `CFG.out`（本机临时文件；Reddit 一页 `.json` 动辄几百 KB，标准输出会被截）；最后一行打印
 * `@@FINAL {state, why?, space_id?}`。ego 自己硬停（浏览器权限框、人接管）时不 `finish`（那时空间已归人）。
 */

/** 允许点的字样（菜单项的字 / aria-label / title 合在一起认）。 */
export const EGO_READ_SAFE_CLICK =
  '^\\s*(更多|更多操作|更多选项|More|More actions|More options|…|⋯|\\.\\.\\.|下载|下载为|下载副本|导出|导出为|Download|Download as|Export|Export as|文件|File|Excel|Microsoft Excel|CSV)(\\b|\\s|\\(|（|$)|\\.xlsx|\\.csv'

/** 一律不点的字样（就算白名单认了也拒）。 */
export const EGO_READ_FORBID_CLICK =
  '发送|发布|提交|删除|分享|邀请|评论|回复|保存|确定|同意|购买|支付|登录|注销|退出|Send|Post|Publish|Submit|Delete|Remove|Share|Invite|Comment|Reply|Save(?!\\s*as)|Confirm|Accept|Agree|Buy|Pay|Sign in|Log in|Log out|Sign out'

/** `copy` 那一步只许按的键（全选、复制、取消选中）。 */
export const EGO_READ_KEYS: readonly string[] = ['ControlOrMeta+A', 'ControlOrMeta+C', 'Escape']

/** 找菜单项：字 / aria 各一条正则（不区分大小写）。 */
export interface EgoReadTarget {
  text?: string
  attr?: string
  /** 字或 aria 有一条对上就算（缺省两条都要对上）。 */
  either?: boolean
}

export type EgoReadStep =
  | {
      op: 'read'
      id: string
      /** 要页面原文（最多 `max_html` 字）。 */
      html?: boolean
      /** 要一份无障碍快照（整页）。 */
      snapshot?: boolean
      /** 读到至少一张 ≥2 行 ≥2 列的表才算成（在线表格那一路）。 */
      need_grid?: boolean
      max_text?: number
      max_html?: number
      unless?: string[]
    }
  | {
      op: 'fetch'
      id: string
      /** 同源地址（相对 / 绝对都行；跨源的不发）。 */
      urls: string[]
      gap_ms?: number
      max_chars?: number
      /** 认「成了」的 content-type（正则）；不给 = 2xx 就算成。 */
      expect?: string
      /** 碰到 429 / 401 / 跳登录页就不再往下读。 */
      stop_on_wall?: boolean
      unless?: string[]
    }
  | {
      op: 'download_url'
      id: string
      url: string
      save_as: string
      timeout_ms?: number
      unless?: string[]
    }
  | {
      /** 画布表格：截住「复制」写出来的内容（飞书：`text/plain` = TSV，`text/bitable` = 带表头的 JSON）。 */
      op: 'copy'
      id: string
      /** 点画布里哪一格（相对最大那块画布左上角，CSS 像素；缺省 220 / 90，避开表头与行号）。 */
      at?: { x: number; y: number }
      unless?: string[]
    }
  | {
      op: 'export'
      id: string
      clicks: EgoReadTarget[]
      save_as: string
      timeout_ms?: number
      unless?: string[]
    }

export interface EgoReadScriptConfig {
  /** 这一趟的空间名（每趟不同）。 */
  space: string
  /** 先打开哪一页。 */
  url: string
  /** 结果写到哪（本机绝对路径）。 */
  out: string
  /** 打开后再等多久（毫秒，缺省 2500；飞书这种重页面给长一点）。 */
  settle_ms?: number
  steps: EgoReadStep[]
}

/** 拼一段完整脚本。 */
export function egoReadScript(cfg: EgoReadScriptConfig): string {
  const injected = {
    ...cfg,
    safe: EGO_READ_SAFE_CLICK,
    forbid: EGO_READ_FORBID_CLICK,
    keys: EGO_READ_KEYS,
  }
  return `const CFG = ${JSON.stringify(injected)};\n${BODY}`
}

const BODY = String.raw`
const fs = await import("node:fs/promises");
const t0 = Date.now();
const results = [];
const okIds = new Set();
let task;
let page;
const step = (r) => {
  results.push(r);
  if (r.ok) okIds.add(r.id);
  console.log("@@STEP " + JSON.stringify({ id: r.id, op: r.op, ok: r.ok, ms: Date.now() - t0, ...(r.why ? { why: String(r.why).slice(0, 160) } : {}) }));
};
const msg = (e) => String((e && e.message) || e).slice(0, 300);
const HUMAN = /user (now )?controls|permission prompt|handed (off|over)|inactive|unassigned|takeOverTaskSpace/i;
const done = async (state, why) => {
  let closed = false;
  if (task && state !== "needs_human") {
    try {
      await task.finish({ keep: [] });
      closed = true;
    } catch {}
  }
  const final = { state, ...(why ? { why: String(why).slice(0, 300) } : {}), ...(task ? { space_id: task.spaceId } : {}), closed, duration_ms: Date.now() - t0 };
  try {
    await fs.writeFile(CFG.out, JSON.stringify({ ...final, steps: results }));
  } catch (e) {
    final.write_error = msg(e);
  }
  console.log("@@FINAL " + JSON.stringify(final));
};

// 页面里只读：正文、原文、表格（<table> 与 role=grid）、密码框个数
const extract = (opts) =>
  page.evaluate((opts) => {
    const all = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        all.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    const clip = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
    const MAX_ROWS = 5000;
    const MAX_COLS = 50;
    const tables = [];
    const push = (rows, source) => {
      const kept = rows.filter((r) => r.some((c) => c !== ""));
      if (kept.length > 0 && tables.length < 12) tables.push({ source, rows: kept.slice(0, MAX_ROWS) });
    };
    for (const t of all.filter((el) => el.tagName === "TABLE")) {
      const rows = [];
      for (const tr of t.querySelectorAll("tr")) {
        if (tr.closest("table") !== t) continue;
        const cells = [];
        for (const c of tr.children) {
          if (c.tagName !== "TD" && c.tagName !== "TH") continue;
          const text = clip(c.innerText || c.textContent, 4000);
          const span = Math.min(Number(c.getAttribute("colspan") || "1") || 1, MAX_COLS);
          for (let i = 0; i < span && cells.length < MAX_COLS; i += 1) cells.push(text);
        }
        rows.push(cells);
      }
      push(rows, "table");
    }
    for (const g of all.filter((el) => /^(grid|treegrid|table)$/i.test(el.getAttribute("role") || ""))) {
      const rows = [];
      for (const r of g.querySelectorAll('[role="row"]')) {
        const cells = [...r.querySelectorAll('[role="gridcell"],[role="cell"],[role="columnheader"],[role="rowheader"]')]
          .slice(0, MAX_COLS)
          .map((c) => clip(c.innerText || c.textContent, 4000));
        rows.push(cells);
      }
      push(rows, "aria");
    }
    const body = document.body;
    return {
      final_url: location.href,
      title: document.title,
      text: String((body && body.innerText) || "").slice(0, opts.max_text || 400000),
      ...(opts.html ? { html: document.documentElement.outerHTML.slice(0, opts.max_html || 4000000) } : {}),
      password_inputs: all.filter((el) => el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password").length,
      canvases: all.filter((el) => el.tagName === "CANVAS").length,
      tables,
    };
  }, opts);

// 认菜单项：打上 data-agentsws-read 记号（只认看得见的；字 / aria 各一条正则）
const mark = (want) =>
  page.evaluate((want) => {
    const all = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        all.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    for (const el of all) if (el.getAttribute && el.getAttribute("data-agentsws-read") === "t") el.removeAttribute("data-agentsws-read");
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    };
    const textRe = want.text ? new RegExp(want.text, "i") : undefined;
    const attrRe = want.attr ? new RegExp(want.attr, "i") : undefined;
    const hit = all.filter((el) => {
      if (!visible(el)) return false;
      const t = textRe ? textRe.test((el.innerText || el.textContent || "").trim()) : true;
      // aria-label / title / data-testid 各认一遍（两样写同一个字时合起来认不出 ^…$）
      const a = attrRe ? [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("data-testid")].some((v) => v && attrRe.test(v)) : true;
      return want.either ? (textRe && t) || (attrRe && a) : t && a;
    });
    if (hit.length === 0) return undefined;
    const pick = hit.filter((el) => !hit.some((o) => o !== el && el.contains(o))).at(-1);
    pick.setAttribute("data-agentsws-read", "t");
    return [(pick.innerText || pick.textContent || "").trim(), pick.getAttribute("aria-label") || "", pick.getAttribute("title") || ""].join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
  }, want);
const SAFE = new RegExp(CFG.safe, "i");
const FORBID = new RegExp(CFG.forbid, "i");
// 只读通道里唯一的一处点击：点之前再认一遍字样，白名单外 / 黑名单内一律拒
const safeClick = async (said) => {
  if (!said || !SAFE.test(said) || FORBID.test(said)) throw new Error("refused-click: " + String(said).slice(0, 80));
  await page.click('[data-agentsws-read="t"]', { label: "open export menu" });
};
const waitMark = async (want, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const said = await mark(want);
    // ego 把 undefined 回成 null
    if (said !== undefined && said !== null) return said;
    await page.waitForTimeout(400);
  }
  return undefined;
};
const header = (h, name) => {
  if (!h) return "";
  if (typeof h.get === "function") return h.get(name) || "";
  if (Array.isArray(h)) {
    const hit = h.find((x) => Array.isArray(x) ? String(x[0]).toLowerCase() === name : String(x && x.name).toLowerCase() === name);
    return hit ? String(Array.isArray(hit) ? hit[1] : hit.value) : "";
  }
  for (const k of Object.keys(h)) if (k.toLowerCase() === name) return String(h[k]);
  return "";
};
// 只许按白名单里的键（全选 / 复制 / Esc）
const pressKey = async (key) => {
  if (!CFG.keys.includes(key)) throw new Error("refused-key: " + key);
  await page.keyboard.press(key);
};
const arm = (ms) =>
  page.waitForEvent("download", { timeout: ms }).then(
    (d) => ({ d }),
    (e) => ({ e: msg(e) }),
  );

const ops = {
  async read(s) {
    const got = await extract({ html: !!s.html, max_text: s.max_text, max_html: s.max_html });
    if (s.snapshot) {
      try {
        got.snapshot = String(await page.snapshot({ scope: "full_page" })).slice(0, 200000);
      } catch (e) {
        got.snapshot_error = msg(e);
      }
    }
    const grid = got.tables.some((t) => t.rows.length >= 2 && t.rows.some((r) => r.filter((c) => c !== "").length >= 2));
    step({ id: s.id, op: "read", ok: s.need_grid ? grid : true, ...(s.need_grid && !grid ? { why: "no-grid" } : {}), page: got });
  },
  async fetch(s) {
    const here = new URL(await Promise.resolve().then(() => page.url()));
    const out = [];
    let first = true;
    for (const u of s.urls) {
      let target;
      try {
        target = new URL(u, here);
      } catch {
        out.push({ url: u, error: "bad-url" });
        continue;
      }
      if (target.origin !== here.origin) {
        out.push({ url: target.href, error: "cross-origin" });
        continue;
      }
      if (!first && s.gap_ms) await page.waitForTimeout(s.gap_ms);
      first = false;
      try {
        const r = await page.fetch(target.href, { method: "GET", timeout: 30000 });
        const ct = header(r.headers, "content-type");
        const body = typeof r.body === "string" ? r.body : r.body == null ? "" : JSON.stringify(r.body);
        out.push({ url: target.href, status: r.status, final_url: r.url || target.href, content_type: ct, body: body.slice(0, s.max_chars || 4000000) });
        if (s.stop_on_wall && (r.status === 429 || r.status === 401 || /\/(login|register)\b/i.test(String(r.url || "")))) break;
      } catch (e) {
        out.push({ url: target.href, error: msg(e) });
      }
    }
    const firstOk = out[0] && !out[0].error && out[0].status >= 200 && out[0].status < 300 && (!s.expect || new RegExp(s.expect, "i").test(out[0].content_type || ""));
    step({ id: s.id, op: "fetch", ok: !!firstOk, responses: out });
  },
  async download_url(s) {
    const wait = arm(s.timeout_ms || 30000);
    let navErr;
    try {
      await page.goto(s.url, { timeout: s.timeout_ms || 30000 });
    } catch (e) {
      navErr = msg(e);
    }
    // 打开后不是下载（登录页 / 没权限）：最多再等 3 秒
    const got = await Promise.race([wait, page.waitForTimeout(3000).then(() => ({ e: "no-download" }))]);
    if (got.d) {
      await got.d.saveAs(s.save_as);
      step({ id: s.id, op: "download_url", ok: true, saved: s.save_as, name: got.d.suggestedFilename() });
    } else step({ id: s.id, op: "download_url", ok: false, why: got.e || navErr || "no-download", final_url: await Promise.resolve().then(() => page.url()).catch(() => "") });
  },
  async copy(s) {
    // 1. 截住「复制」：记下 (type, value)，不调原来的 setData / writeText（用户的剪贴板不动）
    const where = await page.evaluate(() => {
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
    if (!where) {
      step({ id: s.id, op: "copy", ok: false, why: "no-canvas" });
      return;
    }
    const at = s.at || { x: 220, y: 90 };
    // 2. 单击画布里的一格（只是选中）→ 全选 → 复制 → Esc 取消选中
    await page.mouse.click(where.x + Math.min(at.x, where.w - 10), where.y + Math.min(at.y, where.h - 10), { label: "select a table cell" });
    await page.waitForTimeout(500);
    await pressKey("ControlOrMeta+A");
    await page.waitForTimeout(400);
    await pressKey("ControlOrMeta+C");
    await page.waitForTimeout(1200);
    const copied = await page.evaluate(() => window.__agentswsCopy || []);
    await pressKey("Escape");
    const ok = copied.some(([type, value]) => /^text\/(plain|bitable)/i.test(type) && String(value).trim() !== "");
    step({ id: s.id, op: "copy", ok, ...(ok ? {} : { why: "nothing-copied" }), copied });
  },
  async export(s) {
    const wait = arm(s.timeout_ms || 60000);
    const said = [];
    for (const c of s.clicks) {
      const label = await waitMark(c, 8000);
      if (label === undefined) {
        step({ id: s.id, op: "export", ok: false, why: "not-found " + (c.text || c.attr || ""), clicked: said });
        return;
      }
      await safeClick(label);
      said.push(label);
      await page.waitForTimeout(800);
    }
    const got = await Promise.race([wait, page.waitForTimeout(s.timeout_ms || 60000).then(() => ({ e: "no-download" }))]);
    if (got.d) {
      await got.d.saveAs(s.save_as);
      step({ id: s.id, op: "export", ok: true, saved: s.save_as, name: got.d.suggestedFilename(), clicked: said });
    } else step({ id: s.id, op: "export", ok: false, why: got.e || "no-download", clicked: said });
  },
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
      step({ id: "open", op: "open", ok: false, why: msg(e) });
    }
    await page.waitForTimeout(CFG.settle_ms || 2500);
    for (const s of CFG.steps) {
      if (s.unless && s.unless.some((id) => okIds.has(id))) continue;
      if (!ops[s.op]) {
        step({ id: s.id, op: s.op, ok: false, why: "unknown-op" });
        continue;
      }
      try {
        await ops[s.op](s);
      } catch (e) {
        if (HUMAN.test(msg(e))) throw e;
        step({ id: s.id, op: s.op, ok: false, why: msg(e) });
      }
    }
    await done("ok");
  }
} catch (e) {
  const m = msg(e);
  await done(HUMAN.test(m) ? "needs_human" : "failed", m);
}
`
