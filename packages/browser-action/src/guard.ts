/**
 * 驱动层白名单（从 Reddit 通道抽出来的那一道闸，WP249 → WP313）。
 *
 * 执行器每一步先问 {@link checkStep}；不在这个动作白名单里的打开 / 点击 / 填写一律拒，
 * 填的字只能是审批卡上的那几段。白名单按**动作种类**算（{@link ActionAllowlist}），
 * 不按传进来的步骤算——步骤被人改了也绕不过去。
 *
 * 这里不引 `@agentsws/contracts`（插件打包不想把整份契约拖进去）：
 * {@link hostMatches} 与 contracts 的 `hostAllowed` 同一个语义，测试钉住。
 */

import type { ActionAllowlist, ActionStep } from './types.js'

/** 主机名在不在白名单里（`*.example.com` 认 example.com 本身和所有子域）。 */
export function hostMatches(host: string, allowed: readonly string[] | undefined): boolean {
  const h = host.toLowerCase().replace(/\.$/u, '')
  if (h === '') return false
  for (const raw of allowed ?? []) {
    const pattern = raw.trim().toLowerCase().replace(/\.$/u, '')
    if (pattern === '') continue
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2)
      if (h === suffix || h.endsWith(`.${suffix}`)) return true
      continue
    }
    if (h === pattern) return true
  }
  return false
}

/** 网址的主机名；不是 http(s) 或解析不了回空串（空串过不了任何白名单）。 */
export function hostOfUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : ''
  } catch {
    return ''
  }
}

export type StepVerdict = { ok: true } | { ok: false; why: string }

const notListed = (what: string, kind: string): StepVerdict => ({
  ok: false,
  why: `${what}不在「${kind}」这个动作的白名单里，已拦下。`,
})

/**
 * 这一步在不在这个动作的白名单里。不在就回一句人话（执行器停下、照实报）。
 *
 * `kind` 只用来拼那句人话。话术与 Reddit 通道原来的一字不差（那边的测试照旧过）。
 */
export function checkStep(step: ActionStep, allow: ActionAllowlist, kind: string): StepVerdict {
  switch (step.op) {
    case 'goto': {
      const host = hostOfUrl(step.url)
      if (!hostMatches(host, allow.hosts))
        return { ok: false, why: `要打开的页面不在白名单里：${host || step.url}` }
      // WP467：「就地填」时看的那一个也要写在白名单里（只看不动，但不让步骤表自己加）
      return step.need === undefined || (allow.wait ?? []).includes(step.need)
        ? { ok: true }
        : notListed('要看的那一个', kind)
    }
    case 'click':
      if (step.unless !== undefined && !(allow.wait ?? []).includes(step.unless))
        return notListed('要看的那一个', kind)
      return allow.click.includes(step.selector) ? { ok: true } : notListed('这一下点击', kind)
    case 'fill':
      if (!allow.fill.includes(step.selector)) return notListed('这个输入框', kind)
      return allow.values.includes(step.value)
        ? { ok: true }
        : { ok: false, why: '要填的字和审批卡上的不一样，已拦下。' }
    case 'wait':
      // WP467：等之前滚到眼前的那一个（只滚不点）也要在白名单里
      if (step.reveal !== undefined && !(allow.wait ?? []).includes(step.reveal))
        return notListed('要滚到眼前的那一个', kind)
      return { ok: true }
    case 'read':
    case 'expect_none':
      // 只看不动：不点、不填、不发东西。选择器是步骤表里写死的，这里只拦「看的还在不在后台里」
      // 这一类事交给每次打开页面后的主机检查，不再单列白名单。
      return { ok: true }
    case 'upload':
      return (allow.upload ?? []).includes(step.selector)
        ? { ok: true }
        : notListed('这个上传框', kind)
    case 'paste':
      return (allow.paste ?? []).includes(step.selector)
        ? { ok: true }
        : notListed('这个文本框', kind)
    case 'download':
      return (allow.download ?? []).includes(step.selector)
        ? { ok: true }
        : notListed('这个导出按钮', kind)
    case 'capture':
    case 'confirm':
    // 只看不动：等人自己点发送、读回那一条（插件不点发送）
    case 'await_sent':
      return { ok: true }
  }
}

/** 整张步骤表先过一遍（进队前、开跑前都查一次）。第一处不过就回它。 */
export function checkPlanSteps(
  steps: readonly ActionStep[],
  allow: ActionAllowlist,
  kind: string,
): { ok: true } | { ok: false; why: string; index: number } {
  for (const [index, step] of steps.entries()) {
    const v = checkStep(step, allow, kind)
    if (!v.ok) return { ok: false, why: v.why, index }
  }
  return { ok: true }
}
