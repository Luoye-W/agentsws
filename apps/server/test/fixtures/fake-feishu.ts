/**
 * WP509：**本机假飞书表格页**——照主会话 10-23 真机摸到的样子写（只在 127.0.0.1 上，不碰任何真网站）：
 *
 * - 格子画在 `<canvas>` 上，DOM 里没有格子；
 * - 点一格 = 选中；**再点已选中的那一格 = 进格内编辑**（方向键在编辑里不走格子，Esc 退出不提交）；
 * - 方向键走格子，ControlOrMeta + 方向键跳到边上；ControlOrMeta+A 全选；
 * - 复制：页面在 `copy` 事件里调 `setData`——全选时写 `text/plain`（TSV；多维表格不带表头）与
 *   `text/bitable`（HTML 转义过的 JSON 表头：字段名、类型编号、单选项）；只选一格时写这一格的字；
 * - 粘贴：`paste` 事件里读 `text/plain`，从选中那一格起按 TSV 铺开；行不够自动加行、列不够自动加列；
 *   单选列粘一个已有选项就选它，**没有的选项会被新建**（真飞书没测，假页面按最坏的来，测试钉住我们不粘不存在的选项）；
 * - ControlOrMeta+Z 撤销上一笔；多维表格可选一个「+ 添加记录」按钮（DOM），点一下表尾多一行空行；
 * - 每改一笔把整张表 POST 回本机服务（下一次打开页面接着用：读表头那一趟与写那一趟是两次打开）。
 *
 * 另有登录页（有密码框）与没权限页。
 */
import { createServer, type Server } from 'node:http'

export interface FakeField {
  name: string
  /** 飞书字段类型编号：1 文本、2 数字、3 单选、15 超链接、20 公式（写不进）。 */
  type: number
  options?: string[]
}

export interface FakeTable {
  kind: 'bitable' | 'sheet'
  title: string
  /** 多维表格的字段（电子表格不用；表头就是第一行）。 */
  fields?: FakeField[]
  /** 多维表格：数据行；电子表格：第 0 行是表头。 */
  rows: string[][]
  /** 多维表格表尾的「+ 添加记录」按钮。 */
  addButton?: boolean
  /** 打开就是登录页 / 没权限页。 */
  gate?: 'login' | 'no_access'
  /** 测试用：粘贴落格往右偏几列（模拟「定位以为对了、其实粘歪了」）。 */
  pasteDrift?: number
}

export interface FakeFeishu {
  origin: string
  /** 页面地址（`/base/<token>?table=tbl1` 或 `/sheets/<token>`）。 */
  pathOf(token: string): string
  table(token: string): FakeTable
  /** 每一次 POST 回来的改动（谁改了几笔）。 */
  saves: number
  close(): Promise<void>
}

const esc = (s: string) => s.replace(/</gu, '\\u003c')

export function fakeFeishuHtml(token: string, t: FakeTable): string {
  if (t.gate === 'login')
    return `<!doctype html><html><head><meta charset="utf-8"><title>登录 - 飞书</title></head><body><h1>登录飞书</h1><input type="password"></body></html>`
  if (t.gate === 'no_access')
    return `<!doctype html><html><head><meta charset="utf-8"><title>飞书云文档</title></head><body><p>你没有权限访问这个文档，可以向所有者申请权限</p></body></html>`
  return `<!doctype html><html><head><meta charset="utf-8"><title>${t.title} - 飞书云文档</title>
<style>body{margin:0;font-family:system-ui;background:#fff} header{height:44px;display:flex;align-items:center;padding:0 16px;border-bottom:1px solid #ddd;gap:12px}
#c{display:block} #add{margin:6px 0 0 40px;border:0;background:none;color:#3370ff;font-size:13px;cursor:pointer} #edit{position:absolute;display:none;border:2px solid #3370ff;background:#fff;font:13px system-ui;padding:6px}</style></head>
<body><header><b>${t.title}</b><span>${t.kind === 'bitable' ? '多维表格 · 表格视图' : '电子表格'}</span></header>
<canvas id="c" width="900" height="480"></canvas>${t.addButton === true ? '<button id="add" type="button">+ 添加记录</button>' : ''}<div id="edit"></div>
<script>
const TOKEN = ${JSON.stringify(token)};
const S = ${esc(JSON.stringify(t))};
const bit = S.kind === 'bitable';
if (bit && !S.fields) S.fields = [];
const width = () => (bit ? S.fields.length : Math.max(1, ...S.rows.map((r) => r.length)));
const H0 = bit ? 32 : 24, RH = 32, X0 = 40, CW = 130;
let sel = null, editing = false, buf = '', all = false, scrollRow = 0;
const undo = [];
window.__copyEvents = 0;
const cv = document.getElementById('c'), g = cv.getContext('2d');
const visibleRows = () => Math.floor((cv.height - H0) / RH);
const rowCount = () => (bit ? S.rows.length : Math.max(S.rows.length + 40, 60));
const cellOf = (r, c) => ((S.rows[r] || [])[c] ?? '');
const save = () => fetch('/__save/' + TOKEN, { method: 'POST', body: JSON.stringify(S) }).catch(() => {});
const snap = () => { undo.push(JSON.stringify({ rows: S.rows, fields: S.fields })); if (undo.length > 200) undo.shift(); };
function draw() {
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
  g.font = '13px system-ui'; g.fillStyle = '#666';
  for (let c = 0; c < width(); c++) g.fillText(bit ? S.fields[c].name : String.fromCharCode(65 + c), X0 + c * CW + 6, H0 - 10);
  for (let i = 0; i < visibleRows(); i++) {
    const r = scrollRow + i; if (r >= rowCount()) break;
    const y = H0 + i * RH;
    g.fillStyle = '#999'; g.fillText(String(r + 1), 6, y + 20);
    for (let c = 0; c < width(); c++) {
      g.strokeStyle = '#eee'; g.strokeRect(X0 + c * CW, y, CW, RH);
      g.fillStyle = '#222'; g.fillText(String(cellOf(r, c)).slice(0, 16), X0 + c * CW + 6, y + 20);
    }
  }
  if (sel && sel.r >= scrollRow && sel.r < scrollRow + visibleRows()) { g.strokeStyle = all ? '#9cf' : '#3370ff'; g.lineWidth = 2; g.strokeRect(X0 + sel.c * CW, H0 + (sel.r - scrollRow) * RH, CW, RH); g.lineWidth = 1; }
  const ed = document.getElementById('edit');
  if (editing && sel) { const rc = cv.getBoundingClientRect(); ed.style.display = 'block'; ed.style.left = rc.left + X0 + sel.c * CW + 'px'; ed.style.top = rc.top + window.scrollY + H0 + (sel.r - scrollRow) * RH + 'px'; ed.textContent = buf; } else ed.style.display = 'none';
}
const keepVisible = () => { if (!sel) return; if (sel.r < scrollRow) scrollRow = sel.r; if (sel.r >= scrollRow + visibleRows()) scrollRow = sel.r - visibleRows() + 1; };
cv.addEventListener('mousedown', (e) => {
  const rc = cv.getBoundingClientRect();
  const x = e.clientX - rc.left, y = e.clientY - rc.top;
  if (y < H0 || x < X0) return;
  const r = scrollRow + Math.floor((y - H0) / RH), c = Math.floor((x - X0) / CW);
  if (r >= rowCount() || c >= width()) return;
  if (sel && sel.r === r && sel.c === c && !editing && !all) { editing = true; buf = String(cellOf(r, c)); }
  else { editing = false; sel = { r, c }; all = false; }
  draw();
});
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (editing) { if (e.key === 'Escape') { editing = false; draw(); } return; }
  if (mod && (e.key === 'a' || e.key === 'A')) { if (sel) { all = true; draw(); } e.preventDefault(); return; }
  if (mod && (e.key === 'z' || e.key === 'Z')) { const u = undo.pop(); if (u) { const o = JSON.parse(u); S.rows = o.rows; S.fields = o.fields; save(); draw(); } e.preventDefault(); return; }
  if (e.key === 'Escape') { all = false; draw(); return; }
  if (!sel) return;
  const last = bit ? S.rows.length - 1 : Math.max(0, S.rows.length - 1);
  const mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
  if (!mv) return;
  all = false;
  if (mod) { if (mv[0] < 0) sel.r = 0; if (mv[0] > 0) sel.r = last; if (mv[1] < 0) sel.c = 0; if (mv[1] > 0) sel.c = width() - 1; }
  else { sel.r = Math.min(Math.max(0, sel.r + mv[0]), rowCount() - 1); sel.c = Math.min(Math.max(0, sel.c + mv[1]), width() - 1); }
  keepVisible(); draw(); e.preventDefault();
});
const tsv = (rows) => rows.map((r) => r.map((v) => (/[\\t\\n"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)).join('\\t')).join('\\n');
document.addEventListener('copy', (e) => {
  window.__copyEvents += 1;
  if (editing) { e.clipboardData.setData('text/plain', buf); e.preventDefault(); return; }
  if (!sel) return;
  if (all) {
    if (bit) {
      e.clipboardData.setData('text/plain', tsv(S.rows.map((r) => S.fields.map((_, i) => r[i] ?? ''))));
      const head = { header: S.fields.map((f, i) => ({ id: 'fld' + i, name: f.name, type: f.type, property: f.options ? { options: f.options.map((n, j) => ({ id: 'opt' + i + '_' + j, name: n })) } : null })) };
      e.clipboardData.setData('text/bitable', JSON.stringify(head).replace(/"/g, '&quot;'));
    } else {
      let n = S.rows.length; while (n > 0 && S.rows[n - 1].every((v) => v === '')) n--;
      e.clipboardData.setData('text/plain', tsv(S.rows.slice(0, n)));
    }
  } else e.clipboardData.setData('text/plain', String(cellOf(sel.r, sel.c)));
  e.preventDefault();
});
const parse = (t) => { const out = []; let row = [], cell = '', q = false; t = t.replace(/\\r\\n?/g, '\\n'); for (let i = 0; i < t.length; i++) { const ch = t[i]; if (q) { if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; } if (ch === '"' && cell === '') q = true; else if (ch === '\\t') { row.push(cell); cell = ''; } else if (ch === '\\n') { row.push(cell); out.push(row); row = []; cell = ''; } else cell += ch; } if (cell !== '' || row.length) { row.push(cell); out.push(row); } return out; };
document.addEventListener('paste', (e) => {
  const text = e.clipboardData && e.clipboardData.getData('text/plain');
  e.preventDefault();
  if (editing) { buf += text; draw(); return; }
  if (!sel || text == null) return;
  snap();
  const block = parse(text);
  block.forEach((line, i) => line.forEach((v, j) => {
    const r = sel.r + i, c = sel.c + j + (S.pasteDrift || 0);
    while (S.rows.length <= r) S.rows.push(new Array(width()).fill(''));
    if (bit) {
      while (S.fields.length <= c) { S.fields.push({ name: '字段 ' + (S.fields.length + 1), type: 1 }); S.rows.forEach((row) => row.push('')); }
      const f = S.fields[c];
      if (f.type === 20) return;
      if (f.type === 3 && v !== '' && !(f.options || []).includes(v)) f.options = (f.options || []).concat([v]);
    }
    while (S.rows[r].length <= c) S.rows[r].push('');
    S.rows[r][c] = v;
  }));
  save(); draw();
});
const add = document.getElementById('add');
if (add) add.addEventListener('click', () => { snap(); S.rows.push(new Array(width()).fill('')); save(); draw(); });
window.__fakeFeishu = () => S;
draw();
</script></body></html>`
}

/** 起一个本机假飞书（端口 0 = 随机；只听 127.0.0.1）。 */
export async function startFakeFeishu(
  tables: Record<string, FakeTable>,
  port = 0,
): Promise<FakeFeishu> {
  const state = new Map(Object.entries(tables).map(([k, v]) => [k, structuredClone(v)]))
  let saves = 0
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    const save = /^\/__save\/([\w-]+)$/u.exec(u.pathname)
    if (save !== null && req.method === 'POST') {
      let body = ''
      req.on('data', (d) => {
        body += d
      })
      req.on('end', () => {
        const t = state.get(save[1] as string)
        if (t !== undefined) {
          const next = JSON.parse(body) as FakeTable
          state.set(save[1] as string, { ...t, rows: next.rows, ...(next.fields === undefined ? {} : { fields: next.fields }) })
          saves += 1
        }
        res.writeHead(204).end()
      })
      return
    }
    const m = /^\/(base|sheets|wiki)\/([\w-]+)/u.exec(u.pathname)
    const t = m === null ? undefined : state.get(m[2] as string)
    if (m === null || t === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(fakeFeishuHtml(m[2] as string, t))
  })
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()))
  const addr = server.address()
  const origin = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : port}`
  return {
    origin,
    pathOf: (token) => {
      const t = state.get(token)
      return t?.kind === 'sheet' ? `/sheets/${token}` : `/base/${token}?table=tbl1`
    },
    table: (token) => state.get(token) as FakeTable,
    get saves() {
      return saves
    },
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r())
        server.closeAllConnections?.()
      }),
  }
}
