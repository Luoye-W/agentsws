/** 移植自 agentsws-extension `src/lib/kol/language.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/lib/language.ts` @ d25b877。 */
/**
 * Panel language.
 *
 * 移植自 KOLAgents 浏览器插件 `src/lib/language.ts` @ 5371c21。
 *
 * **改了什么**：旧仓在模块顶层 `new Storage()`（旧插件框架自带的存储包）并写死一个
 * key。这里换成 `src/lib/storage.ts` 的 {@link KeyValueStore}——由调用方注入，
 * 于是这个模块在 vitest 里 import 不会去摸浏览器 API，`pick()` 那条线（算法与
 * 导出列都靠它）仍然是纯函数。`detectBrowserLang` / `activeLang` / `setActiveLang`
 * / `pick` 一个字没动。
 *
 * ⚠️ 第二阶段接界面时要做的一件事：把语言选择存下来，等于给
 * `chrome.storage.local` 添了**第四个** key（原来只有端口、令牌、队列三样）。
 * `STORE.md` 与设置页那段隐私说明写的是"只存三样"，到时候三处一起改
 * （`storage.ts` 抬头、`STORE.md`、`options.tsx` 的 PrivacyCopy）。
 *
 * The panel shipped Chinese-only, which is wrong for a product whose creators
 * are mostly not Chinese-speaking: the person capturing a US YouTuber may well
 * be reading the page in English. First run follows the browser — Chinese if
 * the browser is Chinese, English otherwise — and an explicit choice is
 * remembered from then on. Same rule as the web app, so the two agree.
 */
import type { KeyValueStore } from "../storage.js"

export type Lang = "zh" | "en"

/** 旧仓叫 `influencerAssistantLanguage`；这里跟 `agentsws.settings` 一套命名。 */
const LANGUAGE_KEY = "agentsws.language"

export function detectBrowserLang(): Lang {
  const candidates = [
    ...(navigator.languages ?? []),
    navigator.language
  ].filter(Boolean)
  return candidates.some((tag) => /^zh\b/i.test(tag)) ? "zh" : "en"
}

/**
 * The language pure helpers read.
 *
 * Formatters, the export columns and the upload-regularity note are called
 * from scrapers and plain functions with no React context in reach, and
 * threading a locale parameter through every one of them would be noise. The
 * provider keeps this in step with the rendered tree and remounts the panel on
 * change, so nothing can render half-translated.
 */
let current: Lang = detectBrowserLang()

export function activeLang(): Lang {
  return current
}

export function setActiveLang(lang: Lang) {
  current = lang
}

/** Stored choice, or null when the user has never picked one. */
export async function loadStoredLang(store: KeyValueStore): Promise<Lang | null> {
  const stored = (await store.get([LANGUAGE_KEY]))[LANGUAGE_KEY]
  return stored === "zh" || stored === "en" ? stored : null
}

export async function saveLang(store: KeyValueStore, lang: Lang) {
  setActiveLang(lang)
  await store.set({ [LANGUAGE_KEY]: lang })
}

/** Pick between two per-language values without a table lookup. */
export function pick<T>(zh: T, en: T): T {
  return current === "zh" ? zh : en
}
