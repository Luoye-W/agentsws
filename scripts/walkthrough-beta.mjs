#!/usr/bin/env node
/**
 * WP135：内测前走查——**新用户从装好到把活干完**，客服线与红人线从头点到尾。
 *
 * 与 `scripts/e2e-kol-sandbox.mjs`（WP117b）的区别：那个脚本证明**红人主线能走通**，
 * 一步不通就停；这个脚本是**走查**——每一步都记「期望 / 实际 / 通不通」，
 * 不通也往下走，最后给一张总表。它是给每次大合并之后回归用的：
 * 表里「通」变「不通」就是回归，「不通」变「通」就是修好了。
 *
 * 纪律（照 WP117b）：
 *
 * 1. **只点界面。** 除了拿一次登录令牌、查一次红人职责的分配 id，不打业务接口。
 *    唯一例外是 D 段最后那一条「demo 配额探针」，它明写是接口级诊断：
 *    先把限流额度打满，再等过一个窗口，看额度回没回来、页面还能不能用。
 * 2. **每一步一张图**，存 `docs/assets/walkthrough/NN-<名字>.png`；
 *    每一步顺带收集：控制台报错、页面异常、接口 4xx / 5xx、请求失败、
 *    屏幕上的**裸值**（snake_case 内部值、ISO 时间戳）。
 * 3. **一个 demo 跑完五段**（WP140）。WP135 那一版每段起一个全新的 demo，因为
 *    demo 的限流令牌桶挂在合成时钟上、用完永不回血（docs/78 阻断 #3）；WP140 把
 *    限流改成按墙钟回血之后，一个进程从向导点到最后一步都不该出「请求过于频繁」。
 *    这也更像真用户：向导里建的职责、关联的云账号，后面几段看得见。
 *    `--only` 仍可只跑某几段（同一个 demo 里按顺序跑）。
 * 4. **云账号那一跳在 demo 里是替身**（WP140）：「发登录信」不打生产云，默认就点。
 *
 * 用法：
 *
 * ```
 * npx tsc -b && pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/walkthrough-beta.mjs [--port 4420] [--only A,B,C,C2,D] [--headed]
 *                                   [--give-live-chat-range]
 * ```
 *
 * `--give-live-chat-range`（WP139）：C2 段向导建完之后，接口级给「网站在线客服」挂上种子店铺范围
 * ——向导建的职责范围为空是 WP138 在修的事；这一项让 WP139（独立页面挑身份）在那之前也能验。
 *
 * 退出码恒为 0（走查不是断言）；结果在控制台与 `docs/assets/walkthrough/results.json`。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/walkthrough')

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4420'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const ONLY = value('--only', 'A,B,C,C2,D').split(',')

/* ── 结果账本 ─────────────────────────────────────────────────────────── */

const results = []
let shotNo = 0
let page
let events = []

/** 一步的结果：`ok(实际)` = 通；`part(实际)` = 部分；抛错 = 不通。 */
const ok = (actual) => ({ status: '通', actual })
const part = (actual) => ({ status: '部分', actual })
class Fail extends Error {}
const fail = (what) => {
  throw new Fail(what)
}

/** 屏幕上的裸值：snake_case 内部值、ISO 时间戳。白名单是常见的正常词。 */
const RAW_ALLOW = new Set(['e_mail'])
async function rawValues() {
  const text = await page
    .locator('main, [data-testid="right-rail"]')
    .allInnerTexts()
    .then((a) => a.join('\n'))
    .catch(() => '')
  const snake = [...new Set(text.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/g) ?? [])].filter(
    (s) => !RAW_ALLOW.has(s),
  )
  const iso = [...new Set(text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[:.\dZ]*/g) ?? [])]
  return [...snake.slice(0, 8), ...iso.slice(0, 3)]
}

async function step(section, name, title, expect, fn) {
  shotNo += 1
  const file = `${String(shotNo).padStart(2, '0')}-${name}.png`
  events = []
  let status = '通'
  let actual = ''
  const t0 = Date.now()
  try {
    const r = await fn()
    if (typeof r === 'string') actual = r
    else if (r !== undefined) {
      status = r.status
      actual = r.actual
    }
  } catch (err) {
    status = '不通'
    actual =
      err instanceof Fail
        ? err.message
        : `脚本没点下去：${String(err?.message ?? err).split('\n')[0]}`
  }
  await page.waitForTimeout(300)
  try {
    await page.screenshot({ path: join(SHOTS, file), fullPage: true, timeout: 15_000 })
  } catch {
    await page.screenshot({ path: join(SHOTS, file), timeout: 15_000 }).catch(() => {})
  }
  const raw = await rawValues()
  const row = {
    no: shotNo,
    section,
    name,
    title,
    expect,
    actual,
    status,
    shot: `docs/assets/walkthrough/${file}`,
    ms: Date.now() - t0,
    errors: [...new Set(events)].slice(0, 12),
    raw,
  }
  results.push(row)
  const mark = status === '通' ? '✓' : status === '部分' ? '~' : '✗'
  console.log(`[${String(shotNo).padStart(2, '0')}] ${mark} ${section} ${title}\n     ${actual}`)
  if (row.errors.length > 0) console.log(`     ⚠ ${row.errors.join(' | ')}`)
  if (raw.length > 0) console.log(`     裸值：${raw.join(', ')}`)
  return row
}

/* ── demo 进程 ────────────────────────────────────────────────────────── */

async function startDemo() {
  // 端口上已经有一个 demo（上一次没关干净）就别起了——请求会打到那个额度早就用完的旧进程上
  const busy = await fetch(`${BASE}/app/bootstrap.json`).then(
    () => true,
    () => false,
  )
  if (busy)
    throw new Error(
      `端口 ${PORT} 上已经有服务在跑，先关掉它（pkill -f "agentsws.mjs demo --port ${PORT}"）`,
    )
  const child = spawn(
    process.execPath,
    [join(ROOT, 'apps/cli/bin/agentsws.mjs'), 'demo', '--port', String(PORT)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const log = []
  child.stdout.on('data', (b) => log.push(String(b)))
  child.stderr.on('data', (b) => log.push(String(b)))
  return { child, log }
}

async function waitForDemo(log) {
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(`${BASE}/app/bootstrap.json`)).ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`demo 没起来：\n${log.join('')}`)
}

async function stopDemo(child) {
  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 800))
}

async function login() {
  const post = async (p, body) =>
    (
      await fetch(`${BASE}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json()
  const link = await post('/v1/auth/magic-link', { email: OWNER })
  return (await post('/v1/auth/verify', { token: link.data.token })).data.session_token
}

async function assignmentOf(token, roleId) {
  const me = await (
    await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${token}` } })
  ).json()
  return me.data.assignments.find((a) => a.role_id === roleId && a.revoked_at == null)?.id
}

/* ── 小工具 ──────────────────────────────────────────────────────────── */

const T = (sel) => page.locator(`[data-testid="${sel}"]`)
const settle = (ms = 900) => page.waitForTimeout(ms)
async function go(path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'load' })
  await settle(1500)
}
/** 站内跳转（不整页刷新，保留「当前岗位」）——等于用户在工作台里点链接过去。 */
async function inApp(path) {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
  await settle(1800)
}
async function text(sel) {
  return (await T(sel).first().innerText()).trim()
}
const oneLine = (s, n = 160) => s.replace(/\s+/g, ' ').trim().slice(0, n)

/**
 * 一副牌一次只露一张（37 §1）。要找某一张，先看当前那张；不是就按「下一张」往后翻
 * （WP141：牌堆有了上一张 / 下一张与紧凑列表，**不决定前一张也能直接去后面的卡**）。
 * 翻牌不是决定，所以一张卡都不会被顺手批掉。找不到才退回老办法（卡型下拉），
 * 并在 `focusNote` 里记一句绕了路。
 */
async function focusCard(re) {
  focusNote = ''
  const card = () => T('deck-card').first()
  await card()
    .waitFor({ timeout: 15_000 })
    .catch(() => {})
  const hit = async () =>
    re.test(
      await card()
        .innerText()
        .catch(() => ''),
    )
  if (await hit()) return card()
  // 回到第一张，再一张一张往后翻
  for (let i = 0; i < 30; i += 1) {
    const prev = T('deck-prev').first()
    if (!(await prev.count()) || (await prev.isDisabled())) break
    await prev.click()
    await settle(200)
  }
  if (await hit()) return card()
  for (let i = 0; i < 30; i += 1) {
    const next = T('deck-next').first()
    if (!(await next.count()) || (await next.isDisabled())) break
    await next.click()
    await settle(300)
    if (await hit()) return card()
  }
  // 老办法：按卡型下拉逐个筛（WP141 之后下拉从全部牌算，选了一种别的还在）
  const sel = T('deck-filters').locator('select').first()
  const opts = await sel.locator('option').evaluateAll((o) => o.map((x) => x.value))
  for (const v of opts) {
    if (!v) continue
    const okSel = await sel.selectOption(v, { timeout: 3000 }).then(
      () => true,
      () => false,
    )
    if (!okSel) continue
    await settle(800)
    if (await hit()) {
      focusNote = '「下一张」翻不到，按卡型筛才看见'
      return card()
    }
  }
  await sel.selectOption('', { timeout: 3000 }).catch(() => {})
  fail(`牌堆里找不到「${re.source}」那张卡`)
}

/** 左栏某个岗位的职责条数（已展开就不再点，点了会收起）。 */
async function navDuties(name) {
  const row = page.locator('[data-testid="nav-position-row"]', { hasText: name }).first()
  if ((await row.locator('[data-testid="nav-duty"]').count()) === 0) {
    await row
      .locator('[data-testid="nav-position-toggle"]')
      .click()
      .catch(() => {})
    await settle(500)
  }
  return row.locator('[data-testid="nav-duty"]').allInnerTexts()
}

let pickedCreator = ''
/** focusCard 绕了路时留一句话，给那一步的「实际」用。 */
let focusNote = ''

/** 首页 / 岗位页上几处"还剩几张卡"的数字，拿来对账。 */
async function cardCounts() {
  const body = await page.locator('main').innerText()
  const pick = (re) => re.exec(body)?.[1]
  return {
    header: pick(/(\d+) 张卡等你决定/),
    all: pick(/全部\s*(\d+)/),
    pager: pick(/第 [\d–]+ \/ (\d+) 张/),
    today: pick(/还有 (\d+) 张卡等你定/),
  }
}

/* ── A. 新用户第一次 ─────────────────────────────────────────────────── */

async function sectionA() {
  await step(
    'A',
    'ob-ai',
    '向导 ① 接上 AI：三张卡 + 演示旁路',
    '工坊官方接口 / 自己的接口 / DeepSeek 账号登录 三张卡，外加「先逛逛演示数据」，一屏讲清',
    async () => {
      await go('/onboarding')
      await T('onboarding-ai').waitFor()
      const cards = await page
        .locator('[data-testid^="ai-card-"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
      const demo = await T('ai-demo').count()
      for (const want of ['ai-card-official', 'ai-card-own', 'ai-card-account'])
        if (!cards.includes(want)) fail(`缺卡：${want}（有：${cards.join('、')}）`)
      if (!demo) fail('没有「先逛逛演示数据」')
      return ok(`${cards.length} 张卡都在；「先逛逛演示数据」是卡下面一行灰字链接`)
    },
  )

  await step(
    'A',
    'ob-ai-official',
    '① 官方接口：填邮箱发登录信',
    '10 秒内有明确反馈（已发 / 看得懂的错误和下一步）',
    async () => {
      await T('ai-card-official').click()
      await T('ai-official-email').fill('tester@example.com')
      /*
       * WP140：demo 的云账号那一跳是替身（`cloudStandIn`，云地址是 `.invalid` 保留域），
       * 点「发登录信」不会打生产云——所以默认就点。替身过一小会儿替用户点信里的链接，
       * 向导每 3 秒问一次，于是能看到「已关联」。
       */
      const t0 = Date.now()
      await T('ai-official-send').click()
      await settle(1500)
      await page.screenshot({
        path: join(SHOTS, `${String(shotNo).padStart(2, '0')}b-ob-ai-official-pending.png`),
      })
      const sent = T('ai-official-sent')
      const err = T('ai-error')
      await Promise.race([
        sent.waitFor({ timeout: 25_000 }),
        err.waitFor({ timeout: 25_000 }),
      ]).catch(() => {})
      const secs = ((Date.now() - t0) / 1000).toFixed(1)
      if (await sent.count()) {
        const said = oneLine(await sent.innerText())
        const linked = await T('ai-official-linked')
          .waitFor({ timeout: 8000 })
          .then(
            () => true,
            () => false,
          )
        return ok(
          `${secs}s 后：${said}${linked ? '；替身点了信里的链接，几秒后显示「已关联」' : ''}`,
        )
      }
      if (await err.count())
        return part(
          `${secs}s 后才出错：「${oneLine(await err.innerText())}」；等待期间按钮变灰、没有转圈或文字`,
        )
      fail(`${secs}s 仍无任何反馈`)
    },
  )

  await step(
    'A',
    'ob-ai-own',
    '① 自己的接口：模板与表单',
    '模板一眼能分清；表单只问必须的',
    async () => {
      await T('ai-pick-own').click()
      await T('ai-own-templates').waitFor()
      const labels = await T('ai-own-templates').locator('button').allInnerTexts()
      const dup = labels.filter((l, i) => labels.indexOf(l) !== i)
      const fields = await T('onboarding-ai').locator('input').count()
      const msg = `模板 ${labels.length} 个（${labels.join(' / ')}）；表单 ${fields} 个输入框`
      return dup.length > 0 ? part(`${msg}；重名：${[...new Set(dup)].join('、')}`) : ok(msg)
    },
  )

  await step(
    'A',
    'ob-business-bare',
    '② 贴网址（用户常见写法，不带结尾斜杠）',
    '能分析出品牌档案',
    async () => {
      await T('ai-demo').click()
      await T('intake-url').waitFor()
      await T('intake-url').fill('https://nordvolt.example')
      await T('intake-start').click()
      await T('intake-working')
        .waitFor({ timeout: 3000 })
        .catch(() => {})
      await T('intake-working')
        .waitFor({ state: 'detached', timeout: 30_000 })
        .catch(() => {})
      await settle()
      const body = await text('onboarding-business')
      if (body.includes('品牌名')) return ok('出了品牌档案卡')
      return part(
        `没出档案卡：「${oneLine(body.split('\n').find((l) => l.includes('404') || l.includes('没')) ?? body, 80)}」（demo 夹具只认带结尾斜杠的网址；真环境不受影响，但错误话术对用户是「这个页面不存在」）`,
      )
    },
  )

  await step(
    'A',
    'ob-business',
    '② 贴网址分析 → 品牌档案卡',
    '品牌名 / 公司 / 一句话 / 邮箱 / 币种 / 社媒 / 产品；没有内部值；与下方表单不打架',
    async () => {
      // WP140：上一步（不带结尾斜杠）已经出了档案卡，就直接看这张；没出才带斜杠再贴一次
      const already = (await text('onboarding-business').catch(() => '')).includes('品牌名')
      if (!already) {
        await T('intake-url').fill('https://nordvolt.example/')
        await T('intake-start').click()
        await T('intake-working')
          .waitFor({ timeout: 3000 })
          .catch(() => {})
        await T('intake-working')
          .waitFor({ state: 'detached', timeout: 30_000 })
          .catch(() => {})
        await settle()
      }
      const body = await text('onboarding-business')
      if (!body.includes('品牌名')) fail(`没出档案卡：${oneLine(body)}`)
      const issues = []
      if ((body.match(/公司全称/g) ?? []).length > 1) {
        const form = await T('company-legal-name')
          .inputValue()
          .catch(() => '')
        issues.push(`「公司全称」出现两次，档案卡与下方表单值不同（表单：${form}）`)
      }
      const chips = ['zh-CN', 'instagram', 'tiktok'].filter((w) => body.includes(w))
      if (chips.length) issues.push(`标签是原始值：${chips.join(' / ')}`)
      if (/1299\.00/.test(body)) issues.push('价格没有币种符号')
      if (/（.*（404））/.test(body))
        issues.push('「有 3 个页面没读着（这个页面不存在（404））」括号套括号')
      return issues.length ? part(issues.join('；')) : ok('档案卡完整')
    },
  )

  await step(
    'A',
    'ob-confirm',
    '② 点「看着没问题」→ 保存并继续',
    '点了有回执；进第 ③ 步',
    async () => {
      await page.getByRole('button', { name: '看着没问题' }).click()
      await settle(1200)
      const before = await text('onboarding-business')
      const receipt = /已(确认|存|保存)|进知识库了/.test(before)
      await T('onboarding-next').click()
      await T('onboarding-roles').waitFor({ timeout: 15_000 })
      return receipt
        ? ok('有回执，进了第 ③ 步')
        : part('「看着没问题」点了只是按钮变淡，没有一句回执；进了第 ③ 步')
    },
  )

  await step(
    'A',
    'ob-roles',
    '③ 预勾岗位',
    '按网址预勾合理的岗位；红人营销为主的朋友能一眼找到并勾上',
    async () => {
      /*
       * WP142：第 ③ 步顶上先问「这次主要想让它干什么」。红人为主的朋友按一下「红人营销」，
       * 红人营销岗位就被勾上（默认是网址预勾的结果：官网 → 客服）。
       */
      const purpose = T('onboarding-purpose')
      const hasPurpose = (await purpose.count()) > 0
      const before = hasPurpose
        ? await purpose
            .locator('button[aria-pressed="true"]')
            .allInnerTexts()
            .catch(() => [])
        : []
      if (
        hasPurpose &&
        (await T('onboarding-purpose-kol').getAttribute('aria-pressed')) !== 'true'
      ) {
        await T('onboarding-purpose-kol').click()
        await settle(400)
      }
      const chips = T('onboarding-roles').locator('button[aria-pressed]')
      const state = await chips.evaluateAll((els) =>
        els.map((e) => ({
          t: e.textContent.trim(),
          on: e.getAttribute('aria-pressed') === 'true',
        })),
      )
      const on = state.filter((s) => s.on).map((s) => s.t)
      const custom = await page
        .locator(
          '#custom-position, [data-testid="onboarding-custom"] input, input[data-testid="onboarding-custom"]',
        )
        .first()
        .inputValue()
        .catch(() => '')
      const count = await text('onboarding-role-count')
      const notes = [
        hasPurpose
          ? `先问「这次主要想让它干什么」（默认按网址：${before.join('、') || '无'}），按「红人营销」后预勾：${on.join('、') || '无'}；${count}`
          : `预勾：${on.join('、') || '无'}；${count}`,
      ]
      const kol = on.some((t) => t.startsWith('红人营销'))
      if (!kol) notes.push('红人营销没有预勾')
      if (!hasPurpose) notes.push('没有「这次主要想让它干什么」那一问')
      if (custom) notes.push(`「自定义岗位叫什么」预填了「${custom}」——没有勾自定义岗位也有这一格`)
      return kol && hasPurpose && !custom ? ok(notes.join('；')) : part(notes.join('；'))
    },
  )

  await step(
    'A',
    'ob-plan',
    '③ 勾红人营销 → ④ 连接与开工',
    '只列必需的连接，可选的折起来；没有内部 id',
    async () => {
      // WP142：上一步已经按「红人营销」勾上了——再点一下就是取消，所以只在没勾时点
      const kolBtn = T('onboarding-roles')
        .getByRole('button', { name: /^红人营销/ })
        .first()
      if ((await kolBtn.getAttribute('aria-pressed')) !== 'true') {
        await kolBtn.click()
        await settle(400)
      }
      await T('onboarding-next').click()
      await T('onboarding-plan').waitFor({ timeout: 15_000 })
      await settle(600)
      const conns = await T('onboarding-plan-connector').count()
      const optional = await T('onboarding-plan-connector').filter({ hasText: '可选' }).count()
      const folded = await T('onboarding-plan-optional-toggle')
        .innerText()
        .catch(() => '')
      const skills = await T('onboarding-plan-skill').allInnerTexts()
      const rawSkill = skills.filter((s) => /^[a-z]+-[a-z-]+/.test(s.trim()))
      const notes = [
        folded
          ? `平铺 ${conns} 个必需的连接，可选的折成「${folded.trim()}」`
          : `列了 ${conns} 个连接，其中 ${optional} 个标「可选」，全部平铺`,
      ]
      notes.push(
        rawSkill.length
          ? `技能包显示内部名：${rawSkill.map((s) => s.split('\n')[0]).join('、')}`
          : `技能包：${skills.map((s) => s.split('\n')[0]).join('、') || '无'}`,
      )
      return optional > 0 || rawSkill.length ? part(notes.join('；')) : ok(notes.join('；'))
    },
  )

  await step(
    'A',
    'ob-done',
    '④ 完成 → 完成屏动效',
    '「一队上岗」动效；职责数与第 ③ 步一致',
    async () => {
      const planText = await T('onboarding-plan').innerText()
      const want = String(
        [...planText.matchAll(/已勾 (\d+) 条/g)].reduce((n, m) => n + Number(m[1]), 0),
      )
      await T('onboarding-finish').click()
      await T('onboarding-done').waitFor({ timeout: 20_000 })
      const phase1 = await T('onboarding-done-mark').getAttribute('data-phase')
      await settle(2000)
      const phase2 = await T('onboarding-done-mark').getAttribute('data-phase')
      const said = await text('onboarding-done')
      // WP142：完成屏按真建的说，已有的被跳过也说出来——建的 + 跳过的 = 第 ④ 步合计
      const allHeld = /你勾的 (\d+) 条职责本来就都有了/.exec(said)?.[1]
      const got = allHeld === undefined ? /(\d+) 条职责/.exec(said)?.[1] : '0'
      const skipped = allHeld ?? /另外 (\d+) 条你本来就有/.exec(said)?.[1] ?? '0'
      const total = String(Number(got ?? 0) + Number(skipped))
      const msg = `动效 ${phase1} → ${phase2}；完成屏说「${oneLine(said, 80)}」，第 ④ 步各岗位「已勾」合计 ${want} 条`
      return got !== undefined && want !== undefined && total !== want ? part(msg) : ok(msg)
    },
  )

  await step(
    'A',
    'home',
    '进工作台 → 首页',
    '首页一眼看清；几处"还剩几张卡"数字一致；没有测试数据与内部值',
    async () => {
      await T('onboarding-enter').click()
      await page.waitForURL(`${BASE}/`, { timeout: 15_000 }).catch(() => {})
      await settle(2500)
      const c = await cardCounts()
      const body = await page.locator('main').innerText()
      const notes = [
        `卡数：页头 ${c.header} / 筛选「全部」${c.all} / 翻页「第 1 / ${c.pager}」/ 今天栏「还有 ${c.today}」`,
      ]
      if (/假指派|per_[a-z]+/.test(body))
        notes.push(
          '「正在进行」里有测试剧本标题「假指派：在场的人 + 高风险动作（转账）」与人员 id「per_luo」',
        )
      if (/late_return_grace_days/.test(body))
        notes.push('首张卡「改之前 / 改之后」直接显示 late_return_grace_days: 0 → 7')
      if (/\bdate\b[\s\S]{0,20}\bsales\b/.test(body))
        notes.push('日报条上 date / sales / orders / low_stock 是英文字段名')
      const dup = (body.match(/Meta Ads\n昨天/g) ?? []).length
      if (dup > 1) notes.push(`右侧「Meta Ads」数据块出现 ${dup} 次`)
      if (/普通成员/.test(await page.locator('nav').first().innerText()))
        notes.push('左栏多了一个没勾过的「普通成员」岗位')
      const same = new Set([c.header, c.all, c.pager, c.today].filter(Boolean)).size <= 1
      return same && notes.length === 1 ? ok(notes[0]) : part(notes.join('；'))
    },
  )

  await step(
    'A',
    'nav-kol',
    '左栏：展开「红人营销」',
    '展开后职责条数 = 岗位页写的条数',
    async () => {
      const row = page.locator('[data-testid="nav-position-row"]', { hasText: '红人营销' }).first()
      await row.locator('[data-testid="nav-position-toggle"]').click()
      await settle(600)
      const duties = await row.locator('[data-testid="nav-duty"]').count()
      await row.locator('[data-testid="nav-position"]').click()
      await T('position-entry').waitFor({ timeout: 15_000 })
      await settle(1200)
      const said = /这个岗位下的 (\d+) 条职责/.exec(await text('position-entry'))?.[1]
      const msg = `左栏展开 ${duties} 条；岗位页写「这个岗位下的 ${said} 条职责」`
      return String(duties) === said ? ok(msg) : part(msg)
    },
  )

  await step(
    'A',
    'new-kol-duty',
    '向导新建的「Instagram 红人」→ 面板',
    '和 YouTube 红人一样，面板上有候选池 / 活动 / 合作线程 / 演练',
    async () => {
      const link = page
        .locator('[data-testid="nav-position-row"]', { hasText: '红人营销' })
        .locator('[data-testid="nav-duty"]', { hasText: 'Instagram' })
        .first()
      if (!(await link.count())) fail('左栏红人营销下没有 Instagram 红人')
      const asg = /\/positions\/([^/?]+)/.exec((await link.getAttribute('href')) ?? '')?.[1]
      await go(`/positions/${asg}?tab=view`)
      if (await T('no-range-card').count())
        fail(
          `面板整块换成「${oneLine(await text('no-range-card'), 60)}」——向导建的职责范围是空的（没连 Shopify 就挂空），红人工作台（候选池 / 活动 / 合作线程 / 演练）一样都看不见`,
        )
      await T('kol-panel').first().waitFor({ timeout: 10_000 })
      return ok('红人工作台在')
    },
  )
}

/* ── B. 红人营销 ─────────────────────────────────────────────────────── */

async function sectionB(assignment) {
  const panel = (view) => `/positions/${assignment}?tab=view&kol=${view}`

  await step(
    'B',
    'kol-position',
    '红人营销岗位页',
    '职责数三处一致；连接卡只列必需的；入口示例贴合红人',
    async () => {
      await go(`/positions/${assignment}`)
      await T('position-entry').waitFor()
      const entry = await text('position-entry')
      const conn = await T('position-connections')
        .first()
        .innerText()
        .catch(async () => page.locator('main').innerText())
      const notes = []
      const said = /这个岗位下的 (\d+) 条职责/.exec(entry)?.[1]
      const duties = (await navDuties('红人营销')).length
      notes.push(`岗位页「${said} 条职责」/ 左栏 ${duties} 条`)
      const need = /连上这 (\d+) 个就能开工/.exec(await page.locator('main').innerText())?.[1]
      const optional = (await page.locator('main').innerText()).split('可选').length - 1
      if (need) notes.push(`「连上这 ${need} 个就能开工」，其中 ${optional} 个标「可选」`)
      const ph = await T('position-entry-input').getAttribute('placeholder')
      if (ph?.includes('降价')) notes.push(`输入框示例是「${ph}」，与红人无关`)
      void conn
      return part(notes.join('；'))
    },
  )

  await step(
    'B',
    'kol-ask',
    '交给它「找 20 个 1 万到 10 万粉的频道」',
    '跳到事项页；列出找到的人（或说清为什么不够 20 个、下一步怎么补）',
    async () => {
      await T('position-entry-input').fill('找 20 个 1 万到 10 万粉的 YouTube 频道')
      await T('position-entry-submit').click()
      await page.waitForURL(/\/matters\//, { timeout: 20_000 })
      await settle(4000)
      const body = await page.locator('main').innerText()
      const found = /找人[:：]\s*(\d+)/.exec(body)?.[1] ?? /找到 (\d+) 个/.exec(body)?.[1]
      const notes = [`找到 ${found ?? '?'} 个`]
      const issues = []
      if (/search_creators/.test(body)) issues.push('摘要里露出工具名 search_creators')
      if (/\byoutube 这条渠道/.test(body)) issues.push('「youtube」小写原始值')
      const names = [...new Set(body.match(/Gadget Jonas|Desk Rosa/g) ?? [])]
      // WP142：回话点名前 5 个 + 去候选池的链接；不够数说原因 + 两个动作
      const pool = await page.getByRole('link', { name: '去候选池看全部' }).count()
      const why = /库里只有 \d+ 个|这次只找到 \d+ 个/.exec(body)?.[0]
      const actions = ['关联官方数据接口', '导入一张表'].filter((w) => body.includes(w))
      if (names.length) notes.push(`点名：${names.join('、')}`)
      if (pool) notes.push('有「去候选池看全部」链接')
      if (why) notes.push(`不够 20 个的原因：「${why}」`)
      if (actions.length) notes.push(`下一步：${actions.join(' / ')}`)
      if (!names.length || !pool)
        issues.push('时间线只写「找人：N 条」，不列是谁、没有去候选池的链接')
      if (Number(found) < 20 && (!why || actions.length < 2))
        issues.push('没说为什么不到 20 个、也没给下一步')
      if (Number(found) < 1) fail([...notes, ...issues].join('；'))
      return issues.length ? part([...notes, ...issues].join('；')) : ok(notes.join('；'))
    },
  )

  await step(
    'B',
    'kol-pool',
    '候选池：关键词搜 + 回车',
    '回车就搜；结果或"没搜到"的原因与下一步',
    async () => {
      await go(panel('pool'))
      await T('kol-panel').first().waitFor()
      await T('kol-search-input').fill('charger')
      await T('kol-search-input').press('Enter')
      await settle(2500)
      const res = await T('kol-search-results')
        .first()
        .innerText()
        .catch(() => '')
      const blocked = await T('kol-search-blocked')
        .first()
        .innerText()
        .catch(() => '')
      if (res) return ok(`搜到：${oneLine(res, 120)}`)
      if (blocked) {
        // WP142：没接数据源时两句话 + 两个按钮（关联官方账号 / 接自己的数据接口）
        const sentences = blocked.split('。').filter((x) => x.trim() !== '').length
        const buttons = await T('kol-search-blocked-box')
          .first()
          .locator('[data-testid^="kol-search-entry-"]')
          .allInnerTexts()
          .catch(() => [])
        const msg = `没搜：「${oneLine(blocked, 160)}」（${sentences} 句）；按钮：${buttons.join(' / ') || '无'}`
        return sentences <= 2 && buttons.length === 2 ? ok(msg) : part(msg)
      }
      return part(
        `回车后没有可见结果区：${oneLine(
          await T('kol-discovery')
            .first()
            .innerText()
            .catch(() => ''),
          120,
        )}`,
      )
    },
  )

  await step(
    'B',
    'kol-campaign-plan',
    '活动：填目标 → 出清单',
    '出一份按渠道分组的清单，带理由',
    async () => {
      await go(panel('campaign'))
      await T('kol-campaign').waitFor()
      await T('kol-campaign-goal').fill('65W 充电器新品，找桌搭类频道')
      await T('kol-campaign-budget')
        .fill('3000')
        .catch(() => {})
      await T('kol-campaign-headcount')
        .fill('5')
        .catch(() => {})
      const ch = T('kol-campaign-channel')
        .filter({ hasText: /youtube|YouTube/ })
        .first()
      if ((await ch.getAttribute('aria-pressed')) !== 'true') await ch.click().catch(() => {})
      await T('kol-campaign-go').click()
      await T('kol-campaign-plan').waitFor({ timeout: 20_000 })
      await settle()
      return ok(oneLine(await text('kol-campaign-plan'), 200))
    },
  )

  await step(
    'B',
    'kol-campaign-accept',
    '活动：接受这份清单',
    '有回执：建了几条、去哪看',
    async () => {
      const btn = T('kol-campaign-accept').first()
      if (!(await btn.count())) fail('清单上没有「接受」按钮')
      // WP142：清单一出来就说不够数的原因（想要几个、库里只有几个、几个已在合作里）
      const short = await T('kol-campaign-short')
        .first()
        .innerText()
        .catch(() => '')
      await btn.click()
      await settle(2500)
      const body = await T('kol-campaign').innerText()
      const line = body.split('\n').find((l) => /建了|没新建|没建|合作线程/.test(l))
      if (!line) fail('接受之后没有回执')
      const next = await T('kol-campaign-receipt')
        .first()
        .locator('button')
        .allInnerTexts()
        .catch(() => [])
      const explained = /已经在合作里/.test(line) && next.length > 0
      const msg = `${short ? `清单上：「${oneLine(short, 80)}」；` : ''}接受后：「${oneLine(line)}」${next.length ? `；下一步：${next.join(' / ')}` : ''}`
      if (/没新建|没建/.test(line) && !explained)
        return part(`${msg}——想要 5 个只出了 2 个，且都已在合作里，接受等于什么都没发生`)
      return ok(msg)
    },
  )

  await step(
    'B',
    'kol-sandbox-on',
    '打开「演练」',
    '铺 24 个合成红人；顶上一直挂「演练中」',
    async () => {
      await go(panel('pool'))
      await T('kol-sandbox-toggle').first().click()
      await T('kol-sandbox-banner').first().waitFor({ timeout: 20_000 })
      await settle()
      return ok(oneLine(await text('kol-sandbox-counts')))
    },
  )

  await step(
    'B',
    'kol-creator',
    '选一个合成红人（只谈钱那一类）',
    '详情里看得到联系方式、打分、起草入口',
    async () => {
      const target = page.locator('[data-creator="sbx_syn_kol_005"]').first()
      if (!(await target.count())) fail('库里没有 sbx_syn_kol_005')
      await target.scrollIntoViewIfNeeded()
      await target.click()
      await T('kol-creator-detail').first().waitFor({ timeout: 15_000 })
      await settle()
      const detail = await text('kol-creator-detail')
      pickedCreator = detail.split('\n')[0].trim()
      const key = /kol\.contact\.[a-z.]+/.exec(detail)?.[0]
      return key
        ? part(`${oneLine(detail, 100)}；联系方式来源处露出 i18n 键「${key}」`)
        : ok(oneLine(detail, 160))
    },
  )

  await step('B', 'kol-outreach', '起草开发信', '出一张待批的卡；回执说「批了才发」', async () => {
    await T('kol-outreach-pitch').first().fill('我们做桌面快充配件')
    await T('kol-outreach-product').first().fill('NordVolt 65W 充电器')
    await T('kol-outreach-go').first().click()
    await T('kol-outreach-draft').first().waitFor({ timeout: 20_000 })
    await settle()
    return ok(oneLine(await text('kol-detail-receipt').catch(() => text('kol-outreach-draft'))))
  })

  await step(
    'B',
    'kol-card-approve',
    '「卡片」tab 批准开发信卡',
    '卡上看得到信的正文与收件人；批了卡消失并有回执',
    async () => {
      await go(`/positions/${assignment}?tab=cards`)
      const first = oneLine(
        await T('deck-card')
          .first()
          .innerText()
          .catch(() => ''),
        40,
      )
      const card = await focusCard(/开发信/)
      const detour = focusNote
      const body = oneLine(await card.innerText(), 140)
      await card.locator('[data-action="approve"]').first().click()
      await settle(2500)
      // WP141：挡在前面的卡不用先决定——「下一张」翻过去就是；绕了路（按卡型筛）才算部分
      if (detour) return part(`牌堆第一张是「${first}」，${detour}；卡面：${body}`)
      return /开发信/.test(first)
        ? ok(`卡面：${body}`)
        : ok(`牌堆第一张是「${first}」，按「下一张」翻到开发信卡（前一张没动）；卡面：${body}`)
    },
  )

  await step('B', 'kol-sent', '回面板看「已发」', '已发 ≥ 1', async () => {
    await go(panel('pool'))
    const c = await text('kol-sandbox-counts')
    const n = Number(/已发\s*(\d+)/.exec(c)?.[1])
    return n >= 1 ? ok(oneLine(c)) : fail(`批了还是：${oneLine(c)}`)
  })

  await step('B', 'kol-jump', '跳到 3 天后、7 天后', '回信 ≥ 1', async () => {
    for (const d of [3, 7]) {
      await page.locator(`[data-testid="kol-sandbox-jump"][data-days="${d}"]`).first().click()
      await settle(2500)
    }
    const c = await text('kol-sandbox-counts')
    const n = Number(/回信\s*(\d+)/.exec(c)?.[1])
    return n >= 1 ? ok(oneLine(c)) : fail(`跳完：${oneLine(c)}`)
  })

  await step(
    'B',
    'kol-messages',
    '回信进「消息」',
    '「消息」里看得到红人的回信（与合作线程是同一件事）',
    async () => {
      await go('/messages')
      await T('messages-page').waitFor()
      const folders = await T('messages-folder').allInnerTexts()
      const kolFolder = T('messages-folder')
        .filter({ hasText: /红人|kol/i })
        .first()
      let list = ''
      if (await kolFolder.count()) {
        await kolFolder.click()
        await settle(1500)
        list = await T('messages-list')
          .first()
          .innerText()
          .catch(() => '')
      }
      const hasSbx = pickedCreator !== '' && list.includes(pickedCreator.split(' ')[0])
      const msg = `文件夹：${folders.map((f) => oneLine(f, 20)).join(' / ')}；红人文件夹里：${oneLine(list, 120) || '（空）'}`
      return hasSbx ? ok(msg) : part(`${msg}——演练回信只在合作线程上，「消息」里看不到`)
    },
  )

  await step(
    'B',
    'kol-thread',
    '合作线程：筛「有回音」→ 点开',
    '往来里看得到我们发的与他回的，回信带意向分类与跟进节奏',
    async () => {
      await go(panel('threads'))
      await T('kol-collab-row').first().waitFor({ timeout: 15_000 })
      await page.locator('[data-testid="kol-collab-filter"][data-stage="replied"]').first().click()
      await settle()
      if (!(await T('kol-collab-row').count())) fail('筛「有回音」之后一条都没有')
      await T('kol-collab-open').first().click()
      await T('kol-thread-exchanges').first().waitFor({ timeout: 15_000 })
      await settle()
      const out = await page
        .locator('[data-testid="kol-thread-exchange"][data-direction="out"]')
        .count()
      const back = await page
        .locator('[data-testid="kol-thread-exchange"][data-direction="in"]')
        .count()
      const klass = await text('kol-thread-reply-class').catch(() => '?')
      return out >= 1 && back >= 1
        ? ok(`出 ${out} 封 / 回 ${back} 封，判成「${klass}」`)
        : fail(`出 ${out} / 回 ${back}`)
    },
  )

  await step(
    'B',
    'kol-quote',
    '报价 800 → 议价卡 → 批准',
    '出一张钱款排版的议价卡；批了合作到「谈条件中」并带预算',
    async () => {
      await T('kol-thread-budget').first().fill('800')
      await T('kol-thread-quote-go').first().click()
      await T('kol-thread-receipt').first().waitFor({ timeout: 15_000 })
      await go(`/positions/${assignment}?tab=cards`)
      const money = await focusCard(/议价/)
      const detour = focusNote
      await page.screenshot({
        path: join(SHOTS, `${String(shotNo).padStart(2, '0')}b-kol-quote-card.png`),
        fullPage: true,
      })
      await money.locator('[data-action="approve"]').first().click()
      await settle(2500)
      await go(panel('threads'))
      await page
        .locator('[data-testid="kol-collab-filter"][data-stage="negotiating"]')
        .first()
        .click()
      await settle()
      const n = await T('kol-collab-row').count()
      const budget = await text('kol-collab-budget').catch(() => '')
      const note = detour ? `；${detour}` : ''
      if (!(n >= 1 && budget.includes('800'))) fail(`谈条件中 ${n} 条，预算「${budget}」${note}`)
      return detour
        ? part(`谈条件中 ${n} 条，预算 ${budget}${note}`)
        : ok(`谈条件中 ${n} 条，预算 ${budget}`)
    },
  )

  await step('B', 'kol-stage', '推阶段：谈成 → 交付中', '每推一步有回执', async () => {
    await T('kol-collab-open').first().click()
    await T('kol-thread-stage').first().waitFor({ timeout: 15_000 })
    for (const next of ['agreed', 'delivering']) {
      await page.locator(`[data-testid="kol-thread-next"][data-next="${next}"]`).first().click()
      await settle(1500)
    }
    // WP141：「现在到哪一步」先说现在（推到交付中之后就该写交付中），再给「推到」哪几步
    const now = await text('kol-thread-stage-now').catch(() => '')
    const receipt = await text('kol-thread-receipt').catch(() => '')
    const msg = `${oneLine(await text('kol-thread-stage'))}；回执：${oneLine(receipt, 60)}`
    return now === '交付中'
      ? ok(msg)
      : part(`现在那一格是「${now}」，与推到的「交付中」对不上；${msg}`)
  })

  await step(
    'B',
    'kol-deliverable',
    '登记交付物 → 验收通过',
    '交付物出现在线程上；验收出回执',
    async () => {
      await T('kol-thread-deliverable-url')
        .first()
        .fill('https://www.youtube.com/watch?v=walkthrough')
      await T('kol-thread-deliverable-add').first().click()
      await T('kol-thread-deliverable').first().waitFor({ timeout: 15_000 })
      await page
        .locator('[data-testid="kol-thread-review"][data-review="approved"]')
        .first()
        .click()
      await settle(2000)
      const receipt = oneLine(await text('kol-thread-receipt'))
      // WP141：卡在「卡片」tab 里，回执不该说「待办」（左栏另有一个叫「待办」的页）
      return /待办/.test(receipt) ? part(`回执说「待办」：${receipt}`) : ok(receipt)
    },
  )

  await step('B', 'kol-link', '建追踪链接', '线程上出现一条带 UTM 的链接', async () => {
    await T('kol-thread-link-url').first().fill('https://nordvolt.example/p/charger-65w')
    await T('kol-thread-link-add').first().click()
    await T('kol-thread-link').first().waitFor({ timeout: 15_000 })
    return ok(oneLine(await text('kol-thread-link'), 140))
  })

  await step(
    'B',
    'kol-funnel',
    '面板：演练漏斗',
    '「建联漏斗」不含演练；「演练漏斗」有数；表格里没有原始值',
    async () => {
      await go(`/positions/${assignment}?tab=view`)
      await settle(1500)
      const body = await page.locator('main').innerText()
      const i = body.indexOf('演练漏斗')
      const seg = i >= 0 ? oneLine(body.slice(i, i + 120)) : '（没找到演练漏斗）'
      const notes = [seg]
      if (/\d{4}-\d{2}-\d{2}T/.test(body)) notes.push('「待审交付物」交付期限是 ISO 时间戳')
      // 只看表格的格子：线程里贴的 www.youtube.com 链接不算原始值
      const cells = await page.locator('[data-testid="block-table"] td').allInnerTexts()
      const raw = cells.filter((c) => /^(youtube|instagram|tiktok|video|post)$/.test(c.trim()))
      if (raw.length) notes.push(`表格里还有原始值：${[...new Set(raw)].join(' / ')}`)
      return notes.length > 1 ? part(notes.join('；')) : ok(seg)
    },
  )

  await step(
    'B',
    'kol-design-md',
    '右栏「设计规范」面板',
    '面板能打开；没有规范时告诉你去哪弄',
    async () => {
      await go(`/positions/${assignment}`)
      await T('rail-icon-design-md').click()
      await settle(1500)
      const p = await T('design-md-panel')
        .first()
        .innerText()
        .catch(() => '')
      const empty = await T('design-md-panel-empty')
        .first()
        .innerText()
        .catch(() => '')
      const err = await T('rail-error')
        .first()
        .innerText()
        .catch(() => '')
      if (err) fail(`面板报错：${oneLine(err)}`)
      if (p || empty) return ok(oneLine(p || empty, 140))
      fail('面板没内容')
    },
  )

  await step(
    'B',
    'kol-extension',
    '连接页「浏览器插件」配对码',
    '点一下出配对码，说清去哪粘',
    async () => {
      await go('/connections')
      await T('connections-page').waitFor()
      const sec = T('extension-section').first()
      await sec.scrollIntoViewIfNeeded()
      await T('extension-generate').first().click()
      await T('extension-code').first().waitFor({ timeout: 15_000 })
      return ok(oneLine(await sec.innerText(), 160))
    },
  )
}

/* ── C. 客服 ─────────────────────────────────────────────────────────── */

async function sectionC(careAssignment) {
  await step(
    'C',
    'chat-direct',
    '直接打开「试聊」页（⌘K / 书签进，当前身份是店主）',
    '要么能用，要么说清「先去网站在线客服那条职责」',
    async () => {
      await go('/chat')
      await settle(1500)
      const body = await page.locator('main').innerText()
      if (/没有装在线客服/.test(body))
        return part(
          '页面说「这个服务进程没有装在线客服」——其实是店主身份没有 customer.read 被 403，话说错了',
        )
      return ok(oneLine(body, 100))
    },
  )

  await step(
    'C',
    'msg-inbox',
    '「消息」收件箱与标签',
    '左侧文件夹 / 标签，中间列表，点开有正文',
    async () => {
      await go('/messages')
      await T('messages-page').waitFor()
      const folders = await T('messages-folder').allInnerTexts()
      const labels = await T('messages-label').allInnerTexts()
      const rows = await T('messages-thread').count()
      if (rows > 0) {
        await T('messages-thread').first().click()
        await settle(1500)
      }
      const reader = await T('messages-reader')
        .first()
        .innerText()
        .catch(() => '')
      const msg = `文件夹 ${folders.length} 个、标签 ${labels.length} 个、列表 ${rows} 条；点开：${oneLine(reader, 80) || '（没有阅读区）'}`
      return rows > 0 && reader ? ok(msg) : part(msg)
    },
  )

  await step(
    'C',
    'care-position',
    '客服岗位页：职责与连接',
    '四条职责都启用（含网站在线客服）；连接只列必需的',
    async () => {
      await go(`/positions/${careAssignment}`)
      await T('position-entry').waitFor()
      const said = /这个岗位下的 (\d+) 条职责/.exec(await text('position-entry'))?.[1]
      const duties = await navDuties('客服')
      const main = await page.locator('main').innerText()
      const need = /连上这 (\d+) 个就能开工/.exec(main)?.[1]
      const msg = `岗位页「${said} 条」/ 左栏 ${duties.length} 条（${duties.join('、')}）；连接卡「连上这 ${need ?? '?'} 个」`
      return duties.some((d) => d.includes('在线')) && String(duties.length) === said
        ? ok(msg)
        : part(msg)
    },
  )

  await step(
    'C',
    'care-reply-card',
    '客服信的回复草稿卡',
    '卡面：客户问题摘要、AI 拟答、依据；没有裸枚举',
    async () => {
      await go(`/positions/${careAssignment}?tab=cards`)
      const card = await focusCard(/回复草稿|拟答|回复/)
      await card.scrollIntoViewIfNeeded()
      const body = await card.innerText()
      return ok(oneLine(body, 200))
    },
  )

  await step(
    'C',
    'care-instruct',
    '在回复卡上「指导」→ 教一句',
    '先选作用域（这一封 / 同类 / 全局），再一句话；提交有回执',
    async () => {
      const card = T('deck-card').first()
      const btn = card.locator('[data-action="instruct"]').first()
      if (!(await btn.count())) {
        await card
          .locator('[data-testid="deck-more"]')
          .first()
          .click()
          .catch(() => {})
        await settle(400)
      }
      await page.locator('[data-action="instruct"]').first().click()
      await T('deck-panel-instruct').first().waitFor({ timeout: 10_000 })
      const scopes = await T('deck-scopes')
        .first()
        .innerText()
        .catch(() => '')
      await T('deck-panel-instruct')
        .locator('textarea')
        .first()
        .fill('退货超过 30 天的，先道歉再给店铺余额方案')
      const examples = await T('deck-panel-instruct')
        .locator('[data-testid="task-example"]')
        .allInnerTexts()
      // WP141：点一条示例不该把写好的指导整段换掉（接在后面）
      let overwrote = false
      if (examples.length) {
        const box = T('deck-panel-instruct').locator('textarea').first()
        await T('deck-panel-instruct').locator('[data-testid="task-example"]').first().click()
        const v = await box.inputValue()
        overwrote = !v.includes('退货超过 30 天的')
        await box.fill('退货超过 30 天的，先道歉再给店铺余额方案')
      }
      await T('deck-panel-instruct')
        .getByRole('button', { name: '提交', exact: true })
        .first()
        .click()
      await settle(2000)
      const after = await page.locator('main').innerText()
      const receipt = after.split('\n').find((l) => /记下了|已(记|收|交)|下次|沉淀|记住/.test(l))
      const ex = overwrote
        ? `；抽屉里的「示例任务」（${examples.join(' / ')}）点一下会把写好的指导整段换掉`
        : examples.length
          ? '；点「示例任务」是接在写好的指导后面，不覆盖'
          : ''
      const header = /(\d+) 张待审/.exec(after)?.[1]
      const empty = /队列清空了/.test(after)
      const clash = empty && header !== undefined && header !== '0'
      const msg = `作用域：${oneLine(scopes, 60)}；${receipt ? `回执：${oneLine(receipt, 80)}` : '提交后没看到明确回执'}${ex}${clash ? `；牌堆说「队列清空了」而页头写「${header} 张待审」` : ''}`
      return receipt && !overwrote && !clash ? ok(msg) : part(msg)
    },
  )

  await step(
    'C',
    'care-policy',
    '边界问题选择题卡：选一项 → 批准',
    '三个选项单选；没选不能批；批了沉淀成策略并有回执；卡面没有内部字段名',
    async () => {
      await go(`/positions/${careAssignment}?tab=cards`)
      const card = await focusCard(/怎么办|选一个/)
      const body = await card.innerText()
      const approve = card.locator('[data-action="approve"]').first()
      const disabled = await approve.isDisabled().catch(() => false)
      await card.locator('button[role="radio"]').first().click()
      await settle(300)
      await approve.click()
      await settle(2500)
      const notes = [`没选时批准按钮${disabled ? '是灰的' : '可点'}`]
      if (/late_return_grace_days/.test(body))
        notes.push('卡面「改之前 / 改之后」是 late_return_grace_days: 0 → 7')
      const still = await T('deck-card').filter({ hasText: '超过退货窗口一周' }).count()
      notes.push(still ? '批了之后卡还在' : '批了卡消失')
      const receipt = await text('deck-receipt').catch(() => '')
      if (receipt) notes.push(`回执：${oneLine(receipt, 60)}`)
      else notes.push('批完没有「以后按这个办」的回执')
      return notes.length > 3 || still || !receipt ? part(notes.join('；')) : ok(notes.join('；'))
    },
  )

  await step(
    'C',
    'knowledge',
    '知识库与待补知识',
    '看得到资料来源、待补知识（缺口），能从缺口一键补',
    async () => {
      await go('/knowledge')
      await settle(1500)
      const gaps = await T('knowledge-gap').count()
      const sources = await T('knowledge-sources')
        .first()
        .innerText()
        .catch(() => '')
      const empty = await T('knowledge-sources-empty').count()
      const msg = `待补知识 ${gaps} 条；资料来源：${empty ? '空' : oneLine(sources, 100)}`
      return gaps > 0 ? ok(msg) : part(msg)
    },
  )
}

async function sectionC2(token) {
  let liveChat
  await step(
    'C',
    'care-onboarding',
    '（前置）新用户向导里勾「客服」',
    '勾了客服之后「网站在线客服」这条职责在我名下',
    async () => {
      await go('/onboarding')
      await T('ai-demo').click()
      await T('onboarding-business').waitFor()
      await T('intake-no-site')
        .click()
        .catch(() => {})
      await settle(500)
      await T('onboarding-next').click()
      await T('onboarding-roles').waitFor()
      await T('onboarding-roles').getByRole('button', { name: /^客服/ }).first().click()
      await T('onboarding-next').click()
      await T('onboarding-plan').waitFor()
      await T('onboarding-finish').click()
      await T('onboarding-enter').click({ timeout: 20_000 })
      await settle(1500)
      const duties = await navDuties('客服')
      const link = page
        .locator('[data-testid="nav-position-row"]', { hasText: '客服' })
        .locator('[data-testid="nav-duty"]', { hasText: '在线' })
        .first()
      if (await link.count())
        liveChat = /\/positions\/([^/?]+)/.exec((await link.getAttribute('href')) ?? '')?.[1]
      // WP139：--give-live-chat-range 时给它挂上种子店铺范围（WP138 修好向导之前的验证办法）
      if (liveChat && flag('--give-live-chat-range') && token) {
        const owner = await assignmentOf(token, 'common.owner')
        await fetch(`${BASE}/v1/assignments/${liveChat}`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${token}`,
            'x-assignment': owner,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ ranges: [{ kind: 'store', id: 'store_main' }] }),
        })
        await page.reload({ waitUntil: 'load' })
        await settle(1500)
      }
      return liveChat
        ? ok(`左栏客服下：${duties.join('、')}`)
        : part(`左栏客服下：${duties.join('、')}——没有「网站在线客服」`)
    },
  )

  let entryNote = ''
  await step(
    'C',
    'chat-entry',
    '从「网站在线客服」这条职责找到聊天窗入口',
    '职责的面板上有「聊天窗」「试聊」两个入口',
    async () => {
      if (!liveChat) fail('名下没有「网站在线客服」职责，进不了聊天窗')
      await go(`/positions/${liveChat}?tab=view`)
      if (await T('no-range-card').count()) {
        entryNote = '入口被「这个岗位还没分配店铺 / 品牌 / 产品线」挡住'
        fail(
          `${entryNote}：向导建的职责范围是空的（没连 Shopify 就挂空），面板整块被这张提示替换，聊天窗 / 试聊入口都看不见；全站也没有别的链接通到 /chat-window`,
        )
      }
      await T('chat-window-entry').waitFor({ timeout: 10_000 })
      return ok('两个入口都在')
    },
  )

  await step(
    'C',
    'chat-window',
    '聊天窗设置页：转发方式、嵌入代码、测试连接',
    '三种转发方式看得懂可选；一段能复制的嵌入代码；测试连接给下一步',
    async () => {
      if (!liveChat) fail('名下没有「网站在线客服」职责')
      // WP139：职责面板上的入口被挡住时，走左栏「消息」下面那个常驻入口；都没有才手输网址
      let via = '职责面板入口'
      if (await T('chat-window-entry').count())
        await T('chat-window-entry').locator('a').first().click()
      else if (await T('nav-chat-window').count()) {
        via = '左栏「聊天窗」'
        await T('nav-chat-window').click()
      } else {
        via = '手输网址'
        await go('/chat-window')
      }
      await T('chat-window-page').waitFor({ timeout: 15_000 })
      await settle(1500)
      const relay = await T('relay-mode')
        .first()
        .innerText()
        .catch(() => '')
      const code = await T('chat-embed-code')
        .first()
        .innerText()
        .catch(async () =>
          T('chat-embed-code')
            .first()
            .inputValue()
            .catch(() => ''),
        )
      let test = ''
      if (await T('relay-test').count()) {
        await T('relay-test').first().click()
        await settle(3000)
        test = oneLine(
          (await page.locator('main').innerText())
            .split('\n')
            .filter((l) => /通|连不上|失败|在线|不在线|转发器/.test(l))
            .slice(-2)
            .join(' / '),
          120,
        )
      }
      const body = await page.locator('main').innerText()
      const modes = ['官方', '自建', '本机'].filter((w) => body.includes(w))
      const convo = oneLine(
        await T('chat-conversations-empty')
          .or(T('chat-conversations'))
          .or(T('chat-duty-needed'))
          .or(T('chat-sessions-error'))
          .first()
          .innerText()
          .catch(() => '（对话区没内容）'),
        80,
      )
      const msg = `从${via}进；转发方式区块：${oneLine(relay, 60)}；页面出现的方式词：${modes.join('/')}；嵌入代码 ${code ? `${code.length} 字` : '没有'}；测试连接：${test || '（无回执）'}；对话区：${convo}`
      const convoOk =
        (await T('chat-conversations-empty').count()) + (await T('chat-conversations').count()) > 0
      return code && modes.length >= 2 && via !== '手输网址' && convoOk ? ok(msg) : part(msg)
    },
  )

  await step(
    'C',
    'chat-try',
    '试聊：访客问「运费多少」',
    '几秒内 AI 答；教一句有回执',
    async () => {
      if (!liveChat) fail('名下没有「网站在线客服」职责')
      await go(`/positions/${liveChat}?tab=view`)
      const entry = T('chat-sandbox-entry').locator('a').first()
      if (await entry.count()) await entry.click()
      else await inApp('/chat')
      await settle(1500)
      if (!(await T('chat-sandbox').count())) {
        const said = oneLine(await page.locator('main').innerText(), 60)
        fail(`试聊页没打开，只有一句「${said}」`)
      }
      await T('chat-visitor-input').fill('运费多少？')
      await T('chat-visitor-send').click()
      await settle(5000)
      const status = await text('chat-status').catch(() => '')
      const convo = oneLine(await text('chat-sandbox'), 220)
      let teach = ''
      if (await T('chat-teach-input').count()) {
        await T('chat-teach-input').fill('美国满 49 美元包邮')
        await T('chat-teach-send').click()
        await settle(2000)
        teach = await text('chat-teach-outcome').catch(() => '')
      }
      return ok(`状态：${status || '—'}；${convo}；教一句：${teach || '（无回执）'}`)
    },
  )
}

/* ── D. 通用 ─────────────────────────────────────────────────────────── */

async function sectionD(kolAssignment) {
  await step(
    'D',
    'account',
    '账号与积分页',
    '三块分组、充值四档、增值服务卡；没连云时说清怎么连',
    async () => {
      await go('/settings/credits')
      await settle(1500)
      /*
       * WP142：这一页要在**两种状态**下都看得到价——已关联（A 段第 2 步关联过）与没关联。
       * 先看已关联那一面（附图 44b），顺手点一档充值看 demo 那一句；再「解除关联」，
       * 看没关联那一面（本步主图）：三块、充值四档、增值服务卡照常在，按钮是「先关联」。
       * 「模型增值卡」（`model-cloud-card`）在设置「通用」那一档里，不是增值服务，不在这一页数。
       */
      const look = async () => {
        await settle(1200)
        const blocks = await T('credits-block').count()
        const tiers = await T('credits-tier').count()
        const kol = await T('kol-cloud-card').count()
        const linkFirst = await T('credits-tier-link-first').count()
        const pricingOpen = await T('credits-pricing-block').count()
        if (!pricingOpen)
          await T('credits-pricing')
            .getByText('价目表')
            .first()
            .click()
            .catch(() => {})
        await settle(500)
        const pricing = await T('credits-pricing-block').count()
        return { blocks, tiers, kol, linkFirst, pricing }
      }
      const notes = []
      let linkedOk = true
      const wasLinked =
        (await T('credits-panel')
          .getAttribute('data-linked')
          .catch(() => '')) === 'true'
      if (wasLinked) {
        const a = await look()
        await T('credits-tier').first().click()
        await settle(1500)
        const demoSaid = await T('credits-tier-error')
          .first()
          .innerText()
          .catch(() => '')
        await page.screenshot({
          path: join(SHOTS, `${String(shotNo).padStart(2, '0')}b-account-linked.png`),
          fullPage: true,
        })
        linkedOk = a.blocks === 3 && a.tiers === 4 && a.kol > 0
        notes.push(
          `已关联：分组 ${a.blocks} 块、充值档 ${a.tiers} 个、红人增值卡 ${a.kol}、价目 ${a.pricing} 块${demoSaid ? `；demo 里点充值：「${oneLine(demoSaid, 60)}」` : ''}`,
        )
        await page.getByRole('button', { name: '解除关联' }).first().click()
        await page
          .locator('[data-testid="credits-panel"][data-linked="false"]')
          .waitFor({ timeout: 15_000 })
          .catch(() => {})
      }
      const b = await look()
      const notLinked = await T('credits-not-linked')
        .first()
        .innerText()
        .catch(() => '')
      const local = await T('credits-pricing-local').count()
      await T('credits-link-first')
        .first()
        .click()
        .catch(() => {})
      await settle(800)
      const focused = await page.evaluate(
        () => document.activeElement?.closest('[data-testid="cloud-account"]') !== null,
      )
      await page.evaluate(() => window.scrollTo(0, 0))
      notes.push(
        `没关联：分组 ${b.blocks} 块、充值档 ${b.tiers} 个（「先关联」${b.linkFirst} 个）、红人增值卡 ${b.kol}、价目 ${b.pricing} 块${local ? '、标了「以关联后显示为准」' : ''}；「先关联」${focused ? '把光标送进了上面的邮箱框' : '没带到关联那张卡'}；「${oneLine(notLinked, 60)}」`,
      )
      const unlinkedOk =
        b.blocks === 3 && b.tiers === 4 && b.kol > 0 && b.linkFirst === 4 && b.pricing === 3
      return linkedOk && unlinkedOk ? ok(notes.join('；')) : part(notes.join('；'))
    },
  )

  await step(
    'D',
    'settings-models',
    '设置「模型」：文字与看图 / 生图两块',
    '两块都在，分别能配',
    async () => {
      await go('/settings')
      await settle(1500)
      const body = await page.locator('main').innerText()
      const text1 = /文字|看图/.test(body)
      const image = /生图|图片生成|出图/.test(body)
      const msg = `「文字 / 看图」${text1 ? '有' : '没有'}；「生图」${image ? '有' : '没有'}`
      return text1 && image ? ok(msg) : part(msg)
    },
  )

  await step(
    'D',
    'rail-all',
    '右栏各面板能开',
    '每个图标点开都有内容或一句说清为什么空，不报错',
    async () => {
      await go(`/positions/${kolAssignment}`)
      const ids = await page
        .locator('[data-testid^="rail-icon-"]')
        .evaluateAll((els) =>
          els.map((e) => e.getAttribute('data-testid').replace('rail-icon-', '')),
        )
      const bad = []
      const todo = []
      for (const id of ids) {
        await T(`rail-icon-${id}`).click()
        await settle(1200)
        const frame = await T('rail-panel-frame')
          .first()
          .innerText()
          .catch(() => '')
        const err = await T('rail-error').count()
        const title = await T('rail-panel-title')
          .first()
          .innerText()
          .catch(() => id)
        if (err || frame.trim() === '') bad.push(`${title}${err ? '（报错）' : '（空白）'}`)
        else if ((await T('rail-placeholder').count()) || /还没做/.test(frame)) todo.push(title)
        await page.screenshot({
          path: join(SHOTS, `${String(shotNo).padStart(2, '0')}-rail-${id}.png`),
        })
      }
      await T(`rail-icon-${ids[0]}`)
        .click()
        .catch(() => {})
      const msg = `${ids.length} 个面板都点得开${bad.length ? `；有问题：${bad.join('、')}` : ''}${todo.length ? `；其中 ${todo.length} 个是「这个面板还没做」占位：${todo.join('、')}` : ''}`
      return bad.length || todo.length ? part(msg) : ok(msg)
    },
  )

  await step(
    'D',
    'role-persona',
    '右栏「岗位角色」面板（红人营销）',
    '看得到六段角色定位，能改',
    async () => {
      await T('rail-icon-role').click()
      await T('role-panel').first().waitFor({ timeout: 10_000 })
      await settle()
      const persona = await text('role-persona').catch(() => '')
      const edit = await T('role-edit').count()
      return persona
        ? ok(`${oneLine(persona, 120)}${edit ? '；有「编辑」' : ''}`)
        : part(oneLine(await text('role-panel'), 120))
    },
  )

  await step('D', 'dark', '深色模式', '账号菜单里切深色；首页与红人面板都能看清', async () => {
    await go('/')
    await T('account-toggle').click()
    await T('account-theme').click()
    await settle(1200)
    const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
    await page
      .screenshot({ path: join(SHOTS, `${String(shotNo).padStart(2, '0')}b-dark-kol.png`) })
      .catch(() => {})
    await go(`/positions/${kolAssignment}?tab=view&kol=pool`)
    return dark ? ok('切到深色了') : fail('点了没切')
  })

  await step('D', 'cmdk', '⌘K 命令面板', '⌘K 打开；输「红人」能跳到岗位', async () => {
    await go('/')
    await page.keyboard.press('Meta+k')
    await settle(600)
    const input = page.locator('[cmdk-input], [role="dialog"] input').first()
    await input.waitFor({ timeout: 5000 })
    await input.fill('红人')
    await settle(600)
    const items = await page.locator('[cmdk-item], [role="option"]').allInnerTexts()
    await page.keyboard.press('Enter')
    await settle(1500)
    const url = page.url().replace(BASE, '')
    await page.keyboard.press('Meta+k')
    await settle(400)
    return url.startsWith('/positions')
      ? ok(
          `候选：${items
            .slice(0, 4)
            .map((s) => oneLine(s, 20))
            .join(' / ')} → 跳到 ${url}`,
        )
      : part(`候选 ${items.length} 个，回车后在 ${url}`)
  })

  await step('D', 'dark-reset', '（收尾）切回浅色', '—', async () => {
    await page.keyboard.press('Escape').catch(() => {})
    await T('account-toggle').click()
    await T('account-theme').click()
    await settle(600)
    return ok('切回浅色')
  })
}

/**
 * 接口级诊断：demo 的限流桶用完之后**过一个窗口能不能回血**。不是界面步骤，单独列。
 *
 * WP140：限流改成按墙钟回血（`packages/api` 默认 session 档 240 突发、每秒 8 个）。
 * 探针先把额度打满（出现第一个 429），再等 `RECOVER_WAIT_MS`——够回血一整页首页的
 * 请求量——然后接口应当回 200，页面应当照常能用。
 */
const RECOVER_WAIT_MS = 12_000
async function rateLimitProbe(token) {
  const hit = async () =>
    (await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${token}` } })).status
  let first429 = -1
  for (let i = 0; i < 600; i += 1) {
    if ((await hit()) === 429) {
      first429 = i
      break
    }
  }
  const stillLimited = first429 >= 0 ? await hit() : undefined
  await new Promise((r) => setTimeout(r, RECOVER_WAIT_MS))
  const after = await hit()
  return { first429, stillLimited, waitedMs: RECOVER_WAIT_MS, after }
}

/* ── main ─────────────────────────────────────────────────────────────── */

function checkBuild() {
  const dist = join(ROOT, 'apps/workstation/dist/index.html')
  try {
    const built = statSync(dist).mtimeMs
    const newest = (dir) => {
      let m = 0
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, f.name)
        m = Math.max(m, f.isDirectory() ? newest(p) : statSync(p).mtimeMs)
      }
      return m
    }
    if (newest(join(ROOT, 'apps/workstation/src')) > built)
      console.warn(
        '⚠ apps/workstation/src 比 dist 新——先 `pnpm -F @agentsws/workstation exec vite build`，否则测到的是旧界面',
      )
  } catch {
    console.warn('⚠ 没有 apps/workstation/dist——先 vite build')
  }
}

async function main() {
  checkBuild()
  mkdirSync(SHOTS, { recursive: true })
  for (const f of readdirSync(SHOTS))
    if (f.endsWith('.png') || f === 'results.json') rmSync(join(SHOTS, f))

  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const browser = await chromium.launch({ headless: !flag('--headed') })
  let probe

  const sections = [
    ['A', async () => sectionA()],
    ['B', async (tok) => sectionB(await assignmentOf(tok, 'kol.youtube'))],
    ['C', async (tok) => sectionC(await assignmentOf(tok, 'dtc.support'))],
    ['C2', async (tok) => sectionC2(tok)],
    [
      'D',
      async (tok) => {
        await sectionD(await assignmentOf(tok, 'kol.youtube'))
        probe = await rateLimitProbe(tok)
        await step(
          'D',
          'demo-quota',
          `demo 配额用完之后（接口级探针打满额度，再等 ${RECOVER_WAIT_MS / 1000} 秒）`,
          '用完时回 429；过了窗口额度恢复，页面照常能用',
          async () => {
            await go('/')
            const body = await page.locator('body').innerText()
            const secs = probe.waitedMs / 1000
            if (probe.first429 < 0) return part('探针 600 次都没打满额度，没验到「用完」那一刻')
            const msg = `探针第 ${probe.first429} 次起 429（紧接着再打仍 ${probe.stillLimited}），等 ${secs} 秒后 → ${probe.after}`
            if (/请求过于频繁/.test(body)) fail(`${msg}；整个工作台变成「出错了：请求过于频繁」`)
            if (probe.after !== 200) fail(`${msg}；过了窗口额度没回来`)
            return ok(`${msg}；首页照常打开`)
          },
        )
      },
    ],
  ]

  /*
   * WP140：**一个 demo 跑完所有段**（限流按墙钟回血之后不再需要每段重起）。
   * 每段仍各开一个新的浏览器上下文（本机存储干净），但后端是同一个进程：
   * 向导里建的、批过的、关联过的，后面几段都看得见——这才是一个真用户的一次使用。
   */
  const { child, log } = await startDemo()
  try {
    await waitForDemo(log)
    const token = await login()
    console.log(`\n=== 一个 demo 跑到底：${BASE}（段：${ONLY.join(' / ')}）===`)
    for (const [id, run] of sections) {
      if (!ONLY.includes(id)) continue
      await runSection(browser, id, run, token)
    }
  } catch (err) {
    console.error(`demo 没起来或中途断了：${err?.stack ?? err}`)
  } finally {
    await stopDemo(child)
  }
  await browser.close()
  report(probe)
}

/** 一段：新浏览器上下文（带同一个登录令牌）→ 跑 → 关。一段中断不影响下一段。 */
async function runSection(browser, id, run, token) {
  try {
    const context = await browser.newContext({
      viewport: { width: 1360, height: 900 },
      locale: 'zh-CN',
    })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 无痕 */
      }
    }, token)
    page = await context.newPage()
    page.setDefaultTimeout(15_000)
    page.on('console', (m) => {
      if (m.type() === 'error') events.push(`console: ${m.text().slice(0, 140)}`)
    })
    page.on('pageerror', (e) => events.push(`pageerror: ${e.message.slice(0, 140)}`))
    page.on('response', (r) => {
      if (r.status() >= 400)
        events.push(
          `${r.status()} ${r.request().method()} ${r.url().replace(BASE, '').split('?')[0]}`,
        )
    })
    page.on('requestfailed', (r) =>
      events.push(`失败 ${r.url().replace(BASE, '').slice(0, 80)} ${r.failure()?.errorText ?? ''}`),
    )
    console.log(`\n=== ${id} 段 ===`)
    await run(token)
    await context.close()
  } catch (err) {
    console.error(`${id} 段中断：${err?.stack ?? err}`)
  }
}

function report(probe) {
  const tally = { 通: 0, 部分: 0, 不通: 0 }
  for (const r of results) tally[r.status] += 1
  writeFileSync(
    join(SHOTS, 'results.json'),
    `${JSON.stringify({ at: new Date().toISOString(), tally, probe, results }, null, 2)}\n`,
  )
  console.log(`\n总计：通 ${tally['通']} · 部分 ${tally['部分']} · 不通 ${tally['不通']}`)
  if (probe)
    console.log(
      `demo 配额探针：第 ${probe.first429} 次起 429；等 ${probe.waitedMs / 1000} 秒后再打一次 → ${probe.after}`,
    )
  console.log('结果：docs/assets/walkthrough/results.json')
}

await main()
