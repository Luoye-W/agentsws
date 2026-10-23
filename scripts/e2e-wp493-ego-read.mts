/**
 * WP493 联调（Mac / Windows 都能跑）：**真的 ego**、**本机假页面**——把 ego 只读通道走一遍。
 *
 *   npx tsx scripts/e2e-wp493-ego-read.mts [--port 4963] [--ego <ego-browser 路径>]
 *
 * - 假页面开在 127.0.0.1:<port>：
 *   - 假 Reddit（`/api/me.json`、收件箱、版块新帖两页）——走产品里同一份 `egoRedditRead`（地址换成本机）；
 *   - 假 Google 表格：`/spreadsheets/d/g1/edit` + 导出 CSV（GET 能取）；`g2` 的导出只给「打开下载」（GET 不给）；
 *   - 假飞书表格：`/sheets/shtCANVAS`（画布，DOM 里没有格子；右上角「更多 → 下载为 → Excel (.xlsx)」下载一份 xlsx）、
 *     `/sheets/shtGRID`（DOM 里有 role=grid 的格子）；
 *   - 一张有「分享」菜单的页：验只读白名单拒点。
 * - **不碰任何真网站**；每一趟开一个新的 AI 空间，跑完 `finish({ keep: [] })` 收掉。
 * - 每个请求都记下来，最后核对：只有 GET、没有 POST；没有一次请求出这台电脑。
 */
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createEgoPageReader } from '../apps/server/src/ego-read/reader.ts'
import { egoRedditRead } from '../apps/server/src/ego-read/reddit.ts'
import { createEgoSheetReader, onlineSheetCall } from '../apps/server/src/ego-read/sheet.ts'
import { zipFiles } from '../packages/knowledge/src/zip.ts'

const args = process.argv.slice(2)
const val = (n: string, d?: string): string | undefined =>
  args.includes(n) ? args[args.indexOf(n) + 1] : d
const port = Number(val('--port', '4963'))
const egoPath = val('--ego', join(homedir(), '.local/bin/ego-browser')) as string
const origin = `http://127.0.0.1:${port}`

const seen: { method: string; path: string; mode?: string }[] = []

const xlsx = (rows: string[][]): Uint8Array => {
  const shared: string[] = []
  const idx = (s: string) => (shared.includes(s) ? shared.indexOf(s) : shared.push(s) - 1)
  const col = (c: number) => String.fromCharCode(65 + c)
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
    .map(
      (r, i) =>
        `<row r="${i + 1}">${r.map((v, c) => `<c r="${col(c)}${i + 1}" t="s"><v>${idx(v)}</v></c>`).join('')}</row>`,
    )
    .join('')}</sheetData></worksheet>`
  return zipFiles([
    { path: '[Content_Types].xml', content: '<?xml version="1.0"?><Types/>' },
    {
      path: 'xl/workbook.xml',
      content:
        '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="红人" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      content:
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    {
      path: 'xl/sharedStrings.xml',
      content: `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`,
    },
    { path: 'xl/worksheets/sheet1.xml', content: sheet },
  ])
}

const html = (title: string, body: string, script = ''): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
body{font-family:system-ui;margin:0} header{display:flex;justify-content:space-between;align-items:center;padding:8px 16px;border-bottom:1px solid #ddd}
.menu{position:absolute;right:16px;top:44px;background:#fff;border:1px solid #ccc;box-shadow:0 2px 8px #0002;padding:4px 0;min-width:180px}
.menu div{padding:6px 12px;cursor:pointer} .menu div:hover{background:#eef} [hidden]{display:none}
</style></head><body>${body}<script>${script}</script></body></html>`

const thing = (id: string, kind: 't1' | 't3', created: number) => ({
  kind,
  data: {
    id,
    name: `${kind}_${id}`,
    author: 'fan_1',
    subreddit: 'wp493test',
    created_utc: created,
    ...(kind === 't3'
      ? { title: `fake post ${id}`, selftext: 'hello' }
      : { body: `fake comment ${id}` }),
    permalink: `/r/wp493test/comments/${id}/x/`,
  },
})
const now = Math.floor(Date.now() / 1000)

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', origin)
  seen.push({
    method: req.method ?? '',
    path: `${url.pathname}${url.search}`,
    mode: String(req.headers['sec-fetch-mode'] ?? ''),
  })
  const send = (
    code: number,
    type: string,
    body: string | Uint8Array,
    extra: Record<string, string> = {},
  ) => {
    res.writeHead(code, { 'content-type': type, ...extra })
    res.end(body)
  }
  const json = (o: unknown) => send(200, 'application/json; charset=UTF-8', JSON.stringify(o))
  const p = url.pathname
  if (req.method !== 'GET') return send(405, 'text/plain', 'read only fake')
  // ── 假 Reddit
  if (p === '/api/me.json') return json({ kind: 't2', data: { name: 'wp493_tester' } })
  if (p === '/message/inbox/.json')
    return json({
      kind: 'Listing',
      data: {
        after: null,
        children: [
          {
            ...thing('c1', 't1', now - 600),
            data: { ...thing('c1', 't1', now - 600).data, type: 'comment_reply' },
          },
        ],
      },
    })
  if (p === '/r/wp493test/new/.json')
    return url.searchParams.get('after') === 't3_p1'
      ? json({ kind: 'Listing', data: { after: null, children: [thing('p2', 't3', now - 7200)] } })
      : json({
          kind: 'Listing',
          data: { after: 't3_p1', children: [thing('p1', 't3', now - 3600)] },
        })
  // ── 假 Google 表格
  if (/^\/spreadsheets\/d\/g[12]\/edit$/.test(p))
    return send(
      200,
      'text/html; charset=utf-8',
      html(
        'Fake Google Sheet',
        '<header><b>Fake Sheet</b><span>wp493@test</span></header><canvas width="800" height="400"></canvas>',
      ),
    )
  if (p === '/spreadsheets/d/g1/export')
    return send(
      200,
      'text/csv; charset=utf-8',
      'Name,Platform,Followers\nAlice,YouTube,12000\nBob,TikTok,800\n',
      {
        'content-disposition': 'attachment; filename="g1.csv"',
      },
    )
  if (p === '/spreadsheets/d/g2/export')
    // 只有「打开下载」给（fetch 不给）
    return req.headers['sec-fetch-mode'] === 'navigate'
      ? send(200, 'text/csv; charset=utf-8', 'Name,Status\nCarol,Shipped\n', {
          'content-disposition': 'attachment; filename="g2.csv"',
        })
      : send(403, 'text/html', '<p>no</p>')
  // ── 假飞书
  if (p === '/sheets/shtCANVAS')
    return send(
      200,
      'text/html; charset=utf-8',
      html(
        '假飞书表格',
        `<header><b>红人表</b><button id="more" aria-label="更多" title="更多">⋯</button></header>
<canvas width="900" height="500" style="display:block"></canvas>
<div class="menu" id="m1" hidden><div>分享</div><div id="dl">下载为</div><div>打印</div></div>
<div class="menu" id="m2" hidden style="right:200px"><div><a id="x" href="/download/redren.xlsx" style="color:inherit;text-decoration:none">Excel (.xlsx)</a></div><div>CSV (.csv)</div></div>`,
        `more.onclick=()=>{m1.hidden=!m1.hidden};dl.onclick=()=>{m2.hidden=false};`,
      ),
    )
  if (p === '/download/redren.xlsx')
    return send(
      200,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xlsx([
        ['名字', '平台', '状态'],
        ['Dora', 'Instagram', '已寄样'],
        ['Evan', 'YouTube', '洽谈中'],
      ]),
      { 'content-disposition': 'attachment; filename="redren.xlsx"' },
    )
  if (p === '/sheets/shtGRID')
    return send(
      200,
      'text/html; charset=utf-8',
      html(
        '假飞书表格（有格子）',
        `<div role="grid"><div role="row"><span role="columnheader">名字</span><span role="columnheader">粉丝</span></div>
<div role="row"><span role="gridcell">Fay</span><span role="gridcell">3万</span></div></div>`,
      ),
    )
  if (p === '/base/bascnFAKE') {
    // 假多维表格：格子画在画布上；选中一格后全选 + 复制 → 页面调 setData 写 TSV（不带表头）与 text/bitable（转义 JSON）
    const bit = JSON.stringify({
      baseId: 'bascnFAKE',
      tableId: 'tblFAKE',
      header: [
        { id: 'fld1', name: '名字', type: 1 },
        { id: 'fld2', name: '平台', type: 3 },
        { id: 'fld3', name: '粉丝', type: 2 },
      ],
    }).replace(/"/g, '&quot;')
    return send(
      200,
      'text/html; charset=utf-8',
      html(
        '假多维表格',
        '<header><b>红人库</b><span>表格 · 视图</span></header><canvas id="c" width="900" height="500" style="display:block"></canvas>',
        `const c=document.getElementById('c');const g=c.getContext('2d');g.font='14px sans-serif';
[['名字','平台','粉丝'],['Gus','YouTube','12000'],['Hana','TikTok','800']].forEach((r,i)=>r.forEach((v,j)=>g.fillText(v,20+j*200,30+i*40)));
let sel=false,all=false;c.addEventListener('mousedown',()=>{sel=true});
const write=(dt)=>{dt.setData('text/plain','Gus\\tYouTube\\t12000\\nHana\\tTikTok\\t800\\n');dt.setData('text/bitable',${JSON.stringify(bit)});};
document.addEventListener('keydown',(e)=>{const mod=e.metaKey||e.ctrlKey;const k=e.key.toLowerCase();
if(mod&&k==='a'&&sel){all=true;e.preventDefault();}
if(mod&&k==='c'&&all){e.preventDefault();write(new DataTransfer());}
if(e.key==='Escape'){sel=false;all=false;}});
document.addEventListener('copy',(e)=>{if(all){write(e.clipboardData);e.preventDefault();}});`,
      ),
    )
  }
  if (p === '/sheets/shtSHARE')
    return send(
      200,
      'text/html; charset=utf-8',
      html('只读拒点', '<button aria-label="分享">分享</button>'),
    )
  return send(404, 'text/plain', 'not found')
})

await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()))
console.log(`假页面：${origin}`)

const reader = createEgoPageReader({ egoPath: () => egoPath, timeoutMs: 120_000 })
const sheets = createEgoSheetReader({ ego: reader })
const out: Record<string, unknown> = {}
let bad = 0
const check = (name: string, ok: boolean, detail: unknown) => {
  if (!ok) bad += 1
  out[name] = { ok, detail }
  console.log(`${ok ? '✓' : '✗'} ${name}`, JSON.stringify(detail).slice(0, 400))
}

try {
  const t0 = Date.now()
  const r = await egoRedditRead(
    {
      id: 'rj_e2e',
      workspace_id: 'ws_e2e',
      expect_user: 'wp493_tester',
      reads: [
        { key: 'inbox', kind: 'inbox', max_pages: 1 },
        { key: 'sub_new:wp493test', kind: 'sub_new', subreddit: 'wp493test', max_pages: 2 },
      ],
      title: 'e2e',
      created_at: new Date().toISOString(),
    },
    { reader, origin, gapMs: 500 },
  )
  check('Reddit（收件箱 + 版块两页）', r.outcome === 'done' && r.parts[1]?.items.length === 2, {
    outcome: r.outcome,
    user: r.user,
    parts: r.parts.map((p) => [p.key, p.items.map((i) => i.name)]),
    ms: Date.now() - t0,
  })

  const g1 = await sheets.read(`${origin}/spreadsheets/d/g1/edit#gid=0`, { kind: 'google' })
  check('Google：GET 导出 CSV', g1.ok && g1.via === 'google_csv' && g1.rows.length === 3, g1)
  const g2 = await sheets.read(`${origin}/spreadsheets/d/g2/edit#gid=0`, { kind: 'google' })
  check('Google：打开导出地址下载', g2.ok && g2.rows[1]?.[0] === 'Carol', g2)
  const f1 = await sheets.read(`${origin}/sheets/shtGRID`, { kind: 'feishu' })
  check('飞书：页面上的格子', f1.ok && f1.via === 'page_cells', f1)
  if (process.env.WP493_DEBUG === '1') {
    const raw = await reader.run(onlineSheetCall(`${origin}/sheets/shtCANVAS`, 'feishu'))
    console.log(
      'DEBUG',
      JSON.stringify({
        ...raw,
        steps: raw.steps.map((x) => ({ ...x, page: undefined, file: x.file?.name })),
      }),
    )
  }
  const f2 = await sheets.read(`${origin}/sheets/shtCANVAS`, { kind: 'feishu' })
  check(
    '飞书：画布 → 更多 → 下载为 → Excel',
    f2.ok && f2.via === 'export_file' && f2.rows.length === 3,
    f2,
  )
  const b1 = await sheets.read(`${origin}/base/bascnFAKE?table=tblFAKE`, { kind: 'feishu' })
  check(
    '飞书多维表格：画布 → 截住复制（表头来自 text/bitable）',
    b1.ok && b1.via === 'copy' && b1.rows[0]?.[0] === '名字' && b1.rows.length === 3,
    b1,
  )
  const refuse = await reader.run({
    url: `${origin}/sheets/shtSHARE`,
    steps: [{ op: 'export', id: 'x', clicks: [{ attr: '^分享$' }], timeout_ms: 3000 }],
  })
  check(
    '只读：「分享」拒点',
    refuse.state === 'ok' && /refused-click/.test(refuse.steps[0]?.why ?? ''),
    refuse.steps[0],
  )
} finally {
  const posts = seen.filter((s) => s.method !== 'GET')
  check('只有 GET（没有任何写请求）', posts.length === 0, { requests: seen.length, non_get: posts })
  server.close()
}
console.log(bad === 0 ? '全部通过' : `${bad} 项没过`)
process.exit(bad === 0 ? 0 : 1)
