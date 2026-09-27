/**
 * WP162：`read_skill(name)` 的执行器——按需技能真的读得到。
 *
 * 判定与取正文是 `@agentsws/learning` 的 `readSkillForRun`（纯逻辑）；这里只做三件
 * 这个进程才做得了的事：
 *
 * 1. **这次运行是谁**：岗位层要按这次运行的岗位叠（`runtime.ts` 的 `positionHit`），
 *    这个信息不在 RunRequest 上，所以由运行时开跑时登记、跑完注销（`actorOf`）；
 * 2. **认名字只认 RunRequest 的 `skills`**——就是这条职责（岗位入口的话是被路由到的那一条）
 *    的 effective skills。以后「这家店这条职责多挂一个技能」只需往那里多加一个名字；
 * 3. **失败说人话**：没登记的回「这条职责没有这个技能」，读不到的说为什么。
 *
 * 三个运行时共用它：stub / direct 经 `runtime.ts` 的工具链调过来，dsh 经 `dsh-adapter` 的
 * 只读工具桥（WP148 那一条）调过来——都是同一个 `executeTool`。
 */
import type { RunRequest } from '@agentsws/contracts'
import { readSkillForRun, type SkillPromptActor, type SkillResolver } from '@agentsws/learning'
import type { ToolExecution, ToolExecutor } from '@agentsws/stand-ins'
import { READ_SKILL_TOOL } from '@agentsws/stand-ins'

export interface SkillToolsOptions {
  registry: SkillResolver
  /** 这次运行解析技能用的「我是谁」（含岗位 / 职责）。 */
  actorOf(request: RunRequest): SkillPromptActor
}

const bareOf = (name: string): string =>
  name.includes('.') ? name.slice(name.indexOf('.') + 1) : name

/** 这个名字是不是读技能那个工具（带不带服务前缀都认）。 */
export const isReadSkillTool = (name: string): boolean => bareOf(name) === READ_SKILL_TOOL

export function createSkillToolExecutor(options: SkillToolsOptions): ToolExecutor {
  return async (call): Promise<ToolExecution> => {
    if (!isReadSkillTool(call.name)) {
      return { status: 'error', reason: `unsupported_tool：这个进程没接「${call.name}」。` }
    }
    const raw = call.input.name
    const name = typeof raw === 'string' ? raw.trim() : ''
    if (name === '') return { status: 'error', reason: '要给一个技能名（照索引里写的抄）' }
    try {
      const r = await readSkillForRun({
        name,
        skills: call.request.skills,
        actor: options.actorOf(call.request),
        registry: options.registry,
      })
      if (r.status === 'not_registered') {
        return { status: 'blocked', reason: `这条职责没有这个技能：${name}` }
      }
      if (r.status === 'unavailable') {
        return {
          status: 'error',
          reason: `读不到「${name}」：技能库里还没有它的正文，或者你把它排除了`,
        }
      }
      return { status: 'ok', data: r.markdown }
    } catch (e) {
      return { status: 'error', reason: `没读到：${e instanceof Error ? e.message : String(e)}` }
    }
  }
}
