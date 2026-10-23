/**
 * WP483（决策 1658 / 1660）：**在 ego 里发帖 / 回帖的那一段脚本**（交给 `ego-browser nodejs` 跑）。
 *
 * 步骤沿用 WP464 `scripts/bench-browser/social-fill.mjs` 摸出来的那一套（FB / IG 在 Luoye 的号上验证到「已填好」，
 * 主会话 10-23 真机），加了三样：
 *
 * 1. **点发送**（`cfg.submit`，决策 1660：不再强制人点最后一下）。岗位开了「发之前让我看一眼」时 `submit = false`：
 *    只填好、`finish({ keep: ['p1'] })` 把页面留给人。
 * 2. **读回**：点完在页面上认出新出现的那一条（正文含草稿开头那一截、不在输入框里），读它的链接 / 编号；
 *    `mode: 'readback'` 是单独一趟只读（「看一眼」那条：人点了没有）。
 * 3. **不绕**：登录墙 → `needs_login`；验证码 / 风控字样 → `blocked`；浏览器自己的权限框（「显示通知」）ego 会硬停、
 *    把 Space 交给人——那一段是 ego 自己打印的，子进程那一侧认（`runner.ts`）。
 *
 * 每一步打印 `@@STEP {json}`，最后一行 `@@FINAL {json}`（形状 = `EgoWriteResult`）。
 *
 * 选择器全是「按字 / 按 aria / 按常见 css」找（穿透 open shadow root），**只有 FB / IG 的发帖框在真号上验证过到填好**；
 * Reddit / X / LinkedIn / TikTok 与各家评论框按公开页面结构写，没在登录后的真页面上跑过（WP483 报告里的真发清单就是验它）。
 * 改版对不上 → `failed`（没点过发送）→ 自动退插件路。
 *
 * 这一段是**纯文本模板**：`CFG` 用 JSON 注进去，正文用 `String.raw` 写（正则里的反斜杠原样到 ego 那一侧）。
 */
import type { EgoWritePlatform } from '@agentsws/contracts'

export interface EgoWriteScriptConfig {
  platform: EgoWritePlatform
  /** 这次的 Space 名（同名 = 续上自己那一个）。 */
  space: string
  /** 交给人之后接着做：续上这个 Space（`takeOverTaskSpace`）。 */
  resume?: number
  /** `write` 填（+ 发）；`readback` 只读一趟：页面上有没有发出去的那一条。 */
  mode: 'write' | 'readback'
  /** 要打开的页面（回帖 = 帖子 / 评论链接；发帖 = 主页或发帖页；读回 = 去哪儿找）。 */
  url?: string
  /** 发帖后去哪儿读回（主页链接）；不给就只认页面上的成功提示。 */
  readback_url?: string
  /** Reddit 回评论：那条评论的 `t1_…`。 */
  parent?: string
  /** 标题（Reddit 发新帖）。 */
  title?: string
  text: string
  /** 本机绝对路径（挂图 / 视频）。 */
  files?: string[]
  /** 点不点发送（`false` = 「发之前让我看一眼」）。 */
  submit: boolean
  /** 结束前截一张图存到这里（本机绝对路径；真机核对用，产品里不给）。 */
  shot?: string
}

/** 草稿开头那一截（认「发出去的那一条」用）：去掉空白、小写、最多 60 字。 */
export function egoSnippet(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLowerCase().slice(0, 60)
}

/** 拼一段完整脚本。 */
export function egoWriteScript(cfg: EgoWriteScriptConfig): string {
  return `const CFG = ${JSON.stringify({ ...cfg, snippet: egoSnippet(cfg.title ?? cfg.text) })};\n${BODY}`
}

const BODY = String.raw`
const t0 = Date.now();
const steps = [];
const step = (name, ok, extra) => {
  const s = { name, ok, ms: Date.now() - t0, ...(extra || {}) };
  steps.push(s);
  console.log("@@STEP " + JSON.stringify(s));
};
let task;
let page;
let clicked = false;
const say = (o) => console.log("@@FINAL " + JSON.stringify({ platform: CFG.platform, duration_ms: Date.now() - t0, steps, clicked, ...(task ? { space_id: task.spaceId } : {}), ...o }));
const end = async (state, extra, keep) => {
  if (CFG.shot && page) {
    try {
      await page.screenshot({ path: CFG.shot });
    } catch {}
  }
  say({ state, ...(extra || {}) });
  try {
    if (task) await task.finish({ keep: keep || [] });
  } catch {}
};
const dump = async () => {
  try {
    console.log("@@SNAPSHOT\n" + String(await page.snapshot()).slice(0, 4000));
  } catch {}
};

// 在页面里找一个元素（穿透 open shadow root），打上 data-agentsws 记号；回 true / false
const mark = async (key, want) =>
  page.evaluate(
    ({ key, want }) => {
      const all = [];
      const walk = (root) => {
        for (const el of root.querySelectorAll("*")) {
          all.push(el);
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(document);
      for (const el of all) if (el.getAttribute && el.getAttribute("data-agentsws") === key) el.removeAttribute("data-agentsws");
      let scope = all;
      if (want.within) {
        const roots = all.filter((el) => el.matches && el.matches(want.within));
        if (roots.length === 0) return false;
        const inAny = (el) => {
          for (let n = el; n; n = n.parentNode || n.host || null) if (roots.includes(n)) return true;
          return false;
        };
        scope = all.filter(inAny);
      }
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
      };
      const textRe = want.text ? new RegExp(want.text, "i") : undefined;
      const attrRe = want.attr ? new RegExp(want.attr, "i") : undefined;
      const hit = scope.filter((el) => {
        if (want.css && !want.css.some((c) => el.matches && el.matches(c))) return false;
        if (textRe && !textRe.test((el.innerText || el.textContent || "").trim())) return false;
        if (attrRe) {
          const a = [el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("aria-placeholder"), el.getAttribute("data-placeholder"), el.getAttribute("data-testid")].filter(Boolean).join(" ");
          if (!attrRe.test(a)) return false;
        }
        if (want.visible !== false && !visible(el)) return false;
        return true;
      });
      if (hit.length === 0) return false;
      const pick = textRe ? hit.filter((el) => !hit.some((o) => o !== el && el.contains(o))).at(-1) : want.first ? hit[0] : hit.at(-1);
      pick.setAttribute("data-agentsws", key);
      return true;
    },
    { key, want },
  );
const SEL = (key) => '[data-agentsws="' + key + '"]';
const waitMark = async (key, want, ms) => {
  const until = Date.now() + (ms || 10000);
  while (Date.now() < until) {
    if (await mark(key, want)) return true;
    await page.waitForTimeout(500);
  }
  return false;
};
const disabled = (key) =>
  page.evaluate((key) => {
    const find = (root) => root.querySelector('[data-agentsws="' + key + '"]') || [...root.querySelectorAll("*")].map((n) => n.shadowRoot && find(n.shadowRoot)).find(Boolean);
    const el = find(document);
    return !!el && (el.disabled === true || el.getAttribute("aria-disabled") === "true");
  }, key);
const textIn = (key) =>
  page.evaluate((key) => {
    const find = (root) => root.querySelector('[data-agentsws="' + key + '"]') || [...root.querySelectorAll("*")].map((n) => n.shadowRoot && find(n.shadowRoot)).find(Boolean);
    const el = find(document);
    if (!el) return "";
    return el.tagName === "TEXTAREA" || el.tagName === "INPUT" ? el.value : el.innerText || "";
  }, key);
// 换行一律 Shift+Enter（评论框、私信框里单按 Enter 就是发送）；Reddit 的编辑器（Lexical）用粘贴，换行成段
const typeInto = async (key, text) => {
  await page.click(SEL(key), { label: "focus the text box" });
  if (CFG.platform.startsWith("reddit")) {
    try {
      await page.keyboard.paste(String(text));
      await page.waitForTimeout(500);
      if (String(await textIn(key)).trim() !== "") return;
    } catch {}
  }
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) await page.keyboard.press("Shift+Enter");
    if (lines[i]) await page.keyboard.insertText(lines[i]);
  }
};
// 没登录：登录页地址 / 密码框 / 右上角还是「登录」按钮
const loginWall = () =>
  page.evaluate(() => {
    const p = location.pathname;
    if (/\/(login|signin|accounts\/login|i\/flow\/login|checkpoint|uas\/login)/i.test(p)) return "login_url";
    if (document.querySelectorAll("input[type=password]").length > 0) return "password_box";
    const loginBtn = [...document.querySelectorAll("a, button, [role=button]")].some((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.top < 120 && /^(log in|sign in|登录|登入)$/i.test((e.innerText || "").trim());
    });
    return loginBtn ? "login_button" : undefined;
  });
// 平台拦了（验证码 / 风控 / 频率）：只认看得见的，不认页面里悄悄加载的验证脚本（WP467：Reddit 每次都加载 reCAPTCHA）
const blockedNow = () =>
  page.evaluate(() => {
    const t = ((document.body && document.body.innerText) || "").slice(0, 6000);
    const m = t.match(/verify (that )?you('| a)re (a )?human|are you a robot|unusual (traffic|activity)|suspicious activity|temporarily (blocked|restricted|locked)|we limit how often|you'?re doing that too much|confirm (it'?s|that it'?s) you|security check|complete the captcha|人机验证|安全验证|异常活动|暂时被限制|操作过于频繁/i);
    if (m) return m[0];
    const frames = [...document.querySelectorAll("iframe")].filter((f) => {
      const r = f.getBoundingClientRect();
      return r.width > 100 && r.height > 100 && /recaptcha\/api2\/bframe|hcaptcha\.com.*challenge|arkoselabs|funcaptcha|challenges\.cloudflare/i.test(f.src || "");
    });
    return frames.length > 0 ? "captcha" : undefined;
  });
const go = async (url) => {
  try {
    await page.goto(url, { timeout: 30000 });
  } catch (e) {
    step("goto-slow", true, { note: String((e && e.message) || e).slice(0, 120) });
  }
  await page.waitForTimeout(3000);
};
const fail = async (why) => {
  step(why, false);
  await dump();
  await end("failed", { why });
};
const guard = async () => {
  let w = await loginWall();
  for (let i = 0; i < 3 && !w; i += 1) {
    await page.waitForTimeout(1000);
    w = await loginWall();
  }
  if (w) {
    step("login-wall", false, { kind: w });
    await end("needs_login", { why: w }, ["p1"]);
    return true;
  }
  const b = await blockedNow();
  if (b) {
    step("blocked", false, { said: b });
    await end("blocked", { why: b }, ["p1"]);
    return true;
  }
  return false;
};
const attach = async (within) => {
  if (!CFG.files || CFG.files.length === 0) return true;
  const ok = (await mark("file", { css: ['input[type="file"]'], within, visible: false })) || (await mark("file", { css: ['input[type="file"]'], visible: false }));
  if (!ok) return false;
  await page.setInputFiles(SEL("file"), CFG.files);
  await page.waitForTimeout(5000);
  step("media-attached", true, { n: CFG.files.length });
  return true;
};

// 页面上找「发出去的那一条」：正文含草稿开头、不在输入框里；读它的链接 / 编号
const findPosted = (linkRe) =>
  page.evaluate(
    ({ snippet, linkRe }) => {
      const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const all = [];
      const walk = (root) => {
        for (const el of root.querySelectorAll("*")) {
          all.push(el);
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(document);
      const up = (el) => el.parentNode || el.host || null;
      const editable = (el) => {
        for (let n = el; n && n.nodeType === 1; n = up(n)) {
          if (n.isContentEditable || n.tagName === "TEXTAREA" || n.tagName === "INPUT") return true;
          if (n.getAttribute && (n.getAttribute("role") === "dialog" || n.getAttribute("contenteditable") === "true")) return true;
        }
        return false;
      };
      const re = new RegExp(linkRe, "i");
      const hits = all.filter((el) => el.children.length < 40 && norm(el.innerText || el.textContent).includes(snippet) && !editable(el));
      const inner = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
      const out = [];
      for (const el of inner) {
        let link;
        let id;
        for (let n = el, d = 0; n && n.nodeType === 1 && d < 25; n = up(n), d += 1) {
          if (!id && n.getAttribute && n.getAttribute("thingid")) id = n.getAttribute("thingid");
          if (!link && n.getAttribute && n.getAttribute("permalink")) link = new URL(n.getAttribute("permalink"), location.href).href;
          if (!link && n.querySelectorAll) {
            const a = [...n.querySelectorAll("a[href]")].map((x) => x.href).find((h) => re.test(h));
            if (a) link = a;
          }
          if (link && (id || d > 3)) break;
        }
        out.push({ link, id, text: (el.innerText || el.textContent || "").slice(0, 10000) });
      }
      return out;
    },
    { snippet: CFG.snippet, linkRe },
  );
const LINK = {
  reddit: "/comments/[a-z0-9]+/",
  x: "/status/[0-9]+",
  facebook: "/posts/|story_fbid=|/permalink/|/videos/|/photos?/|comment_id=",
  instagram: "/p/[A-Za-z0-9_-]+|/reel/[A-Za-z0-9_-]+",
  linkedin: "/feed/update/urn:li:",
  tiktok: "/video/[0-9]+",
};
const net = CFG.platform.split("-")[0];
const idOf = (link) => {
  if (!link) return undefined;
  const c = /\/comment\/([a-z0-9]+)/i.exec(link) || /\/comments\/[a-z0-9]+\/[^/]*\/([a-z0-9]+)\/?(\?|$)/i.exec(link);
  if (net === "reddit" && c) return "t1_" + c[1].toLowerCase();
  const p = /\/comments\/([a-z0-9]+)/i.exec(link);
  if (net === "reddit" && p) return "t3_" + p[1].toLowerCase();
  const m = /\/status\/([0-9]+)|\/p\/([A-Za-z0-9_-]+)|\/reel\/([A-Za-z0-9_-]+)|\/video\/([0-9]+)|urn:li:[a-zA-Z]+:([0-9]+)|\/posts\/([A-Za-z0-9]+)/.exec(link);
  return m ? m.slice(1).find(Boolean) : undefined;
};
const sentResult = (hit) => ({
  ...(hit && hit.link ? { link: hit.link, readback: "link" } : { readback: "clicked" }),
  ...(hit && (hit.id || idOf(hit.link)) ? { external_id: hit.id || idOf(hit.link) } : {}),
  ...(hit && hit.text ? { sent_text: hit.text } : {}),
});
// 点发送：只在 CFG.submit 时；点完不论读没读回，都不再退插件（clicked = true）
const pressSend = async (key, label) => {
  if (await disabled(key)) {
    step("send-disabled", false);
    return false;
  }
  clicked = true;
  await page.click(SEL(key), { label: label || "send" });
  step("send-clicked", true);
  return true;
};
// 发送前：页面上已经有的同样正文（不把老的那一条认成刚发的）
let baseline = new Set();
const takeBaseline = async () => {
  try {
    baseline = new Set((await findPosted(LINK[net] || "$^")).map((h) => h.link || h.id || h.text));
  } catch {}
};
const awaitPosted = async (ms) => {
  const until = Date.now() + (ms || 25000);
  while (Date.now() < until) {
    const hit = (await findPosted(LINK[net] || "$^")).find((h) => !baseline.has(h.link || h.id || h.text));
    if (hit) return hit;
    await page.waitForTimeout(1500);
  }
  return undefined;
};
// 填好之后：要发就点、读回；不发就把页面留给人
const finishWrite = async (sendKey, after) => {
  if (!CFG.submit) {
    step("filled-for-review", true);
    await end("filled", { button_found: !!sendKey }, ["p1"]);
    return;
  }
  if (!sendKey) return await fail("send-button-not-found");
  await takeBaseline();
  if (!(await pressSend(sendKey))) return await fail("send-button-disabled");
  const b = await blockedNow();
  if (b) {
    step("blocked-after-send", false, { said: b });
    return await end("blocked", { why: b }, ["p1"]);
  }
  const hit = await after();
  if (hit === false) return await fail("no-success-sign-after-send");
  step("sent", true, { link: hit && hit.link });
  await end("sent", sentResult(hit || undefined));
};
// 发帖之后去主页读回（给了主页链接才读）；读不到就照实标「点了、没读回」
const readbackOnProfile = async () => {
  if (!CFG.readback_url) return undefined;
  await go(CFG.readback_url);
  for (let i = 0; i < 3; i += 1) {
    const hit = (await findPosted(LINK[net] || "$^"))[0];
    if (hit) return hit;
    await page.waitForTimeout(3000);
  }
  return undefined;
};
const gone = async (key, ms) => {
  const until = Date.now() + (ms || 30000);
  while (Date.now() < until) {
    if (!(await mark(key + "-still", { css: [SEL(key)] }))) return true;
    await page.waitForTimeout(1000);
  }
  return false;
};

const flows = {
  "reddit-reply": async () => {
    await go(CFG.url);
    if (await guard()) return;
    const row = 'shreddit-comment-action-row[comment-id="' + CFG.parent + '"]';
    await page.evaluate((t1) => {
      const c = document.querySelector('shreddit-comment[thingid="' + t1 + '"]');
      if (c) c.scrollIntoView({ block: "center" });
    }, CFG.parent);
    if (!(await waitMark("trigger", { css: ["button"], within: row + ' [slot="comment-reply"]' }, 15000)) && !(await waitMark("trigger", { css: ["button"], within: row, text: "^(reply|回复)$" }, 3000)))
      return await fail("reply-button-not-found");
    await page.click(SEL("trigger"), { label: "open reply box" });
    if (!(await waitMark("box", { css: ['div[contenteditable="true"]'], within: row }, 6000))) {
      await page.click(SEL("trigger"), { label: "open reply box" });
      if (!(await waitMark("box", { css: ['div[contenteditable="true"]'], within: row }, 8000))) return await fail("reply-box-not-found");
    }
    await typeInto("box", CFG.text);
    step("reply-filled", true);
    const send = (await mark("send", { css: ['button[slot="submit-button"]', 'button[type="submit"]'], within: row })) || (await mark("send", { css: ["button"], within: row, text: "^(comment|reply|评论|回复)$" }));
    await finishWrite(send ? "send" : undefined, () => awaitPosted(25000));
  },
  "reddit-comment": async () => {
    await go(CFG.url);
    if (await guard()) return;
    const host = "comment-composer-host:not([parent-id])";
    const opened = (await waitMark("trigger", { css: ["textarea", "faceplate-textarea-input", "[role=textbox]", "button", "div"], attr: "join the conversation|add a comment|加入对话|添加评论|发表评论", within: host }, 15000)) || (await waitMark("trigger", { css: ["faceplate-textarea-input"], within: host }, 3000));
    if (opened) {
      if (await disabled("trigger")) return await fail("comment-box-disabled (post archived / locked, or this account cannot comment)");
      await page.click(SEL("trigger"), { label: "open comment box" });
    }
    if (!(await waitMark("box", { css: ['div[contenteditable="true"]'], within: host }, 10000))) return await fail("comment-box-not-found");
    await typeInto("box", CFG.text);
    step("comment-filled", true);
    const send = (await mark("send", { css: ['button[slot="submit-button"]', 'button[type="submit"]'], within: host })) || (await mark("send", { css: ["button"], within: host, text: "^(comment|评论)$" }));
    await finishWrite(send ? "send" : undefined, () => awaitPosted(25000));
  },
  "reddit-post": async () => {
    await go(CFG.url);
    if (await guard()) return;
    if (!(await waitMark("title", { css: ['textarea[name="title"]', 'input[name="title"]'] }, 15000))) return await fail("title-box-not-found");
    await page.click(SEL("title"), { label: "focus post title" });
    await page.keyboard.insertText(CFG.title || "");
    step("title-filled", true);
    if (CFG.text) {
      const ok = (await waitMark("body", { css: ['div[contenteditable="true"]'], within: 'shreddit-composer[name="body"], shreddit-composer, form' }, 8000)) || (await mark("body", { css: ['div[contenteditable="true"]'] }));
      if (!ok) return await fail("body-box-not-found");
      await typeInto("body", CFG.text);
      step("body-filled", true);
    }
    const send = (await mark("send", { css: ["#inner-post-submit-button"] })) || (await mark("send", { css: ["button"], text: "^(post|发帖|发布|发表)$" }));
    await finishWrite(send ? "send" : undefined, async () => {
      try {
        await page.waitForFunction(() => /\/comments\/[a-z0-9]+\//i.test(location.pathname), undefined, { timeout: 30000 });
      } catch {
        return false;
      }
      const link = await page.url();
      return { link, id: idOf(link), text: CFG.title };
    });
  },
  "facebook-post": async () => {
    await go(CFG.url || "https://www.facebook.com/");
    if (await guard()) return;
    if (!(await waitMark("composer", { css: ['[role="button"]', "span", "div"], text: "^(what's on your mind.*|在想什么.*|分享新鲜事.*|写点什么.*|create post|创建帖子|write something.*)$" }, 15000)))
      return await fail("composer-trigger-not-found");
    await page.click(SEL("composer"), { label: "open post composer" });
    if (!(await waitMark("editor", { css: ['[contenteditable="true"][role="textbox"]', '[contenteditable="true"]'], within: '[role="dialog"]' }, 12000)))
      return await fail("composer-editor-not-found");
    await typeInto("editor", CFG.text);
    step("text-filled", true);
    if (CFG.files && CFG.files.length > 0) {
      if (!(await mark("file", { css: ['input[type="file"]'], within: '[role="dialog"]', visible: false }))) {
        if (await mark("photobtn", { css: ['[role="button"]', "[aria-label]"], attr: "photo/video|照片/视频|照片|photo", within: '[role="dialog"]' })) await page.click(SEL("photobtn"), { label: "add photo" });
        await page.waitForTimeout(1500);
      }
      if (!(await attach('[role="dialog"]'))) return await fail("image-input-not-found");
    }
    const findSend = async () =>
      (await mark("send", { css: ['[role="button"]', "button"], attr: "^(post|发帖|发布)$", within: '[role="dialog"]' })) ||
      (await mark("send", { css: ['[role="button"]', "button"], text: "^(post|发帖|发布)$", within: '[role="dialog"]' }));
    // 主页发帖有时先「下一步」再「发布」（「下一步」不是发出去）
    if (!(await findSend()) && CFG.submit && (await mark("next", { css: ['[role="button"]', "button"], text: "^(next|下一步)$", within: '[role="dialog"]' }))) {
      await page.click(SEL("next"), { label: "next step" });
      await page.waitForTimeout(2000);
    }
    const send = await findSend();
    await finishWrite(send ? "send" : undefined, async () => {
      if (!(await gone("editor", 40000))) return false;
      return (await readbackOnProfile()) || null;
    });
  },
  "instagram-post": async () => {
    if (!CFG.files || CFG.files.length === 0) return await fail("instagram-post-needs-image");
    await go(CFG.url || "https://www.instagram.com/");
    if (await guard()) return;
    if (!(await waitMark("create", { css: ["a", '[role="link"]', '[role="button"]', "svg"], attr: "^(new post|create|创建|新帖子|发帖)$" }, 12000))) return await fail("create-button-not-found");
    await page.click(SEL("create"), { label: "open create menu" });
    await page.waitForTimeout(1500);
    if (await mark("postitem", { css: ["a", '[role="link"]', '[role="button"]', "span"], text: "^(post|帖子|贴文)$" })) await page.click(SEL("postitem"), { label: "choose post" });
    await page.waitForTimeout(1500);
    if (!(await attach('[role="dialog"]'))) return await fail("image-input-not-found");
    // 裁剪 → 滤镜 → 写说明：「下一步」两次（这两步不是发布）
    for (let i = 0; i < 2; i += 1)
      if (await waitMark("next", { css: ['[role="button"]', "button", "div"], text: "^(next|下一步)$", within: '[role="dialog"]' }, 8000)) {
        await page.click(SEL("next"), { label: "next step" });
        await page.waitForTimeout(2000);
      }
    const ok = (await waitMark("caption", { css: ['[contenteditable="true"]', "textarea"], attr: "caption|说明|配文|文案", within: '[role="dialog"]' }, 8000)) || (await mark("caption", { css: ['[contenteditable="true"]'], within: '[role="dialog"]' }));
    if (!ok) return await fail("caption-box-not-found");
    await typeInto("caption", CFG.text);
    step("caption-filled", true);
    const send = await mark("send", { css: ['[role="button"]', "button", "div"], text: "^(share|分享|发布)$", within: '[role="dialog"]' });
    await finishWrite(send ? "send" : undefined, async () => {
      const shared = await waitMark("shared", { css: ["span", "div", "h2", "h3"], text: "^(your (post|reel) has been shared\\.?|帖子已分享|已分享你的帖子|已分享)$" }, 90000);
      if (!shared) return false;
      return (await readbackOnProfile()) || null;
    });
  },
  "x-post": async () => {
    await go(CFG.url || "https://x.com/compose/post");
    if (await guard()) return;
    if (!(await waitMark("box", { css: ['[data-testid="tweetTextarea_0"]', '[contenteditable="true"][role="textbox"]'] }, 15000))) return await fail("compose-box-not-found");
    await typeInto("box", CFG.text);
    step("text-filled", true);
    if (CFG.files && CFG.files.length > 0 && !(await attach())) return await fail("media-input-not-found");
    const send = (await mark("send", { css: ['[data-testid="tweetButton"]', '[data-testid="tweetButtonInline"]'] })) || (await mark("send", { css: ["button", '[role="button"]'], text: "^(post|发帖|发布)$" }));
    await finishWrite(send ? "send" : undefined, async () => {
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        const link = await page.evaluate(() => {
          const a = [...document.querySelectorAll('[data-testid="toast"] a[href*="/status/"], [role="alert"] a[href*="/status/"]')][0];
          return a ? a.href : undefined;
        });
        if (link) return { link, id: idOf(link) };
        await page.waitForTimeout(1000);
      }
      if (!(await gone("box", 5000))) return false;
      return (await readbackOnProfile()) || null;
    });
  },
  "linkedin-post": async () => {
    await go(CFG.url || "https://www.linkedin.com/feed/");
    if (await guard()) return;
    if (!(await waitMark("composer", { css: ["button", '[role="button"]'], text: "^(start a post|发布动态|开始发帖|分享动态)$" }, 15000))) return await fail("composer-trigger-not-found");
    await page.click(SEL("composer"), { label: "open post composer" });
    if (!(await waitMark("editor", { css: [".ql-editor", '[contenteditable="true"][role="textbox"]', '[contenteditable="true"]'], within: '[role="dialog"]' }, 12000))) return await fail("composer-editor-not-found");
    await typeInto("editor", CFG.text);
    step("text-filled", true);
    if (CFG.files && CFG.files.length > 0) {
      if (await mark("mediabtn", { css: ["button", '[role="button"]'], attr: "add media|add a photo|照片|媒体", within: '[role="dialog"]' })) {
        await page.click(SEL("mediabtn"), { label: "add media" });
        await page.waitForTimeout(1500);
      }
      if (!(await attach())) return await fail("media-input-not-found");
      if (await waitMark("next", { css: ["button"], text: "^(next|下一步|done|完成)$", within: '[role="dialog"]' }, 8000)) {
        await page.click(SEL("next"), { label: "confirm media" });
        await page.waitForTimeout(1500);
      }
    }
    const send = await mark("send", { css: ["button"], text: "^(post|发布|发帖)$", within: '[role="dialog"]' });
    await finishWrite(send ? "send" : undefined, async () => {
      const until = Date.now() + 25000;
      while (Date.now() < until) {
        const link = await page.evaluate(() => {
          const a = [...document.querySelectorAll('a[href*="/feed/update/urn:li:"]')].find((x) => /view post|查看帖子|查看动态/i.test(x.innerText || ""));
          return a ? a.href : undefined;
        });
        if (link) return { link, id: idOf(link) };
        await page.waitForTimeout(1000);
      }
      if (!(await gone("editor", 5000))) return false;
      return (await readbackOnProfile()) || null;
    });
  },
  "tiktok-post": async () => {
    if (!CFG.files || CFG.files.length === 0) return await fail("tiktok-post-needs-video");
    await go(CFG.url || "https://www.tiktok.com/tiktokstudio/upload");
    if (await guard()) return;
    if (!(await waitMark("file", { css: ['input[type="file"]'], visible: false }, 15000))) return await fail("upload-input-not-found");
    await page.setInputFiles(SEL("file"), CFG.files);
    step("media-attached", true);
    if (!(await waitMark("caption", { css: [".public-DraftEditor-content", '[contenteditable="true"]'] }, 60000))) return await fail("caption-box-not-found");
    await page.click(SEL("caption"), { label: "focus caption" });
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await typeInto("caption", CFG.text);
    step("caption-filled", true);
    // 视频还在上传时「发布」是灰的：最多等两分钟
    let send = false;
    for (let i = 0; i < 60 && !send; i += 1) {
      send = (await mark("send", { css: ['[data-e2e="post_video_button"]', "button"], text: "^(post|发布)$" })) && !(await disabled("send"));
      if (!send) await page.waitForTimeout(2000);
    }
    await finishWrite(send ? "send" : undefined, async () => {
      const ok = await waitMark("done", { css: ["span", "div", "h2"], text: "^(your video (has been|is being) (uploaded|posted).*|manage your posts|视频已发布.*|管理你的作品)$" }, 60000);
      if (!ok) return false;
      return (await readbackOnProfile()) || null;
    });
  },
  "x-reply": async () => {
    await go(CFG.url);
    if (await guard()) return;
    if (!(await waitMark("box", { css: ['[data-testid="tweetTextarea_0"]', '[contenteditable="true"][role="textbox"]'] }, 15000))) return await fail("reply-box-not-found");
    await typeInto("box", CFG.text);
    step("reply-filled", true);
    const send = (await mark("send", { css: ['[data-testid="tweetButtonInline"]', '[data-testid="tweetButton"]'] })) || (await mark("send", { css: ["button"], text: "^(reply|回复)$" }));
    await finishWrite(send ? "send" : undefined, () => awaitPosted(20000).then((h) => h || null));
  },
  "facebook-comment": async () => {
    await go(CFG.url);
    if (await guard()) return;
    if (!(await waitMark("box", { css: ['[contenteditable="true"][role="textbox"]', '[contenteditable="true"]'], attr: "write a (public )?comment|comment as|写评论|发表评论|发表公开评论|评论" }, 15000))) return await fail("comment-box-not-found");
    await typeInto("box", CFG.text);
    step("comment-filled", true);
    // 有发送按钮就点；没有就在框里按 Enter（Facebook 评论框的发送就是 Enter）
    const btn = await mark("send", { css: ['[role="button"]', "button"], attr: "^(comment|post comment|press enter to post\\.?|评论|发布)$" });
    if (!CFG.submit) return await finishWrite(btn ? "send" : "box", () => null);
    if (btn) return await finishWrite("send", () => awaitPosted(20000).then((h) => h || null));
    await takeBaseline();
    clicked = true;
    await page.focus(SEL("box"));
    await page.keyboard.press("Enter");
    step("send-clicked", true, { via: "enter" });
    const hit = await awaitPosted(20000);
    step("sent", true, { link: hit && hit.link });
    await end("sent", sentResult(hit));
  },
  "instagram-comment": async () => {
    await go(CFG.url);
    if (await guard()) return;
    if (!(await waitMark("box", { css: ["textarea", '[contenteditable="true"]'], attr: "add a comment|添加评论|评论" }, 15000))) return await fail("comment-box-not-found");
    await typeInto("box", CFG.text);
    step("comment-filled", true);
    const send = await mark("send", { css: ['[role="button"]', "button", "div"], text: "^(post|发布)$" });
    await finishWrite(send ? "send" : undefined, () => awaitPosted(20000).then((h) => h || null));
  },
  "linkedin-comment": async () => {
    await go(CFG.url);
    if (await guard()) return;
    if (!(await mark("box", { css: [".ql-editor", '[contenteditable="true"]'], attr: "add a comment|添加评论|评论" }))) {
      if (await waitMark("open", { css: ["button"], text: "^(comment|评论)$" }, 10000)) await page.click(SEL("open"), { label: "open comment box" });
    }
    if (!(await waitMark("box", { css: [".ql-editor", '[contenteditable="true"]'], attr: "add a comment|添加评论|评论" }, 10000)) && !(await mark("box", { css: [".comments-comment-box .ql-editor", '.comments-comment-box [contenteditable="true"]'] })))
      return await fail("comment-box-not-found");
    await typeInto("box", CFG.text);
    step("comment-filled", true);
    const send = (await mark("send", { css: [".comments-comment-box__submit-button", ".comments-comment-box__submit-button--cr"] })) || (await mark("send", { css: ["button"], text: "^(comment|post|评论|发布)$", within: "form" }));
    await finishWrite(send ? "send" : undefined, () => awaitPosted(20000).then((h) => h || null));
  },
  "tiktok-comment": async () => {
    await go(CFG.url);
    if (await guard()) return;
    if (!(await waitMark("box", { css: ['[contenteditable="true"]'], within: '[data-e2e="comment-input"], [class*="CommentInput"]' }, 15000)) && !(await mark("box", { css: ['[contenteditable="true"]'], attr: "add comment|添加评论" })))
      return await fail("comment-box-not-found");
    await typeInto("box", CFG.text);
    step("comment-filled", true);
    const send = (await mark("send", { css: ['[data-e2e="comment-post"]'] })) || (await mark("send", { css: ["div", "button", '[role="button"]'], text: "^(post|发布)$" }));
    await finishWrite(send ? "send" : undefined, () => awaitPosted(20000).then((h) => h || null));
  },
};

// 「看一眼」那条：人点了没有——只读，开页面找那一条
const readback = async () => {
  await go(CFG.url);
  const w = await loginWall();
  if (w) return await end("needs_login", { why: w });
  for (let i = 0; i < 3; i += 1) {
    const hit = (await findPosted(LINK[net] || "$^"))[0];
    if (hit) {
      step("seen", true, { link: hit.link });
      return await end("sent", sentResult(hit));
    }
    await page.waitForTimeout(3000);
  }
  await end("failed", { why: "not-seen-yet" });
};

try {
  try {
    task = CFG.resume ? await takeOverTaskSpace(CFG.resume) : await taskSpace(CFG.space);
  } catch (e) {
    const msg = String((e && e.message) || e);
    // 同名的 Space 已经是用户的（上一趟把页面留给了人）：不是「交给人」，名字撞了——照实失败（不去认领用户的 Space）
    const human = !/already exists|NAME_IN_USE/i.test(msg) && /controls|control of|inactive|unassigned/i.test(msg);
    say({ state: human ? "needs_human" : "failed", why: msg.slice(0, 200), ...(CFG.resume ? { space_id: CFG.resume } : {}) });
    task = undefined;
  }
  if (task) {
    console.log("@@SPACE " + task.spaceId);
    page = task.page("p1");
    if (CFG.mode === "readback") await readback();
    else if (!flows[CFG.platform]) await fail("unknown-platform " + CFG.platform);
    else await flows[CFG.platform]();
  }
} catch (e) {
  const msg = String((e && e.message) || e);
  step("error", false, { error: msg.slice(0, 400) });
  if (/user (now )?controls|permission prompt|handed (off|over)|inactive|unassigned/i.test(msg)) {
    say({ state: "needs_human", why: msg.slice(0, 200) });
  } else {
    await dump();
    await end("failed", { why: "script error: " + msg.slice(0, 200) });
  }
}
`
