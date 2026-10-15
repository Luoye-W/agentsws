/**
 * WP341（决策 847）：genui 块所在的**这段对话**能做什么——由对话那一层（随便聊、事项 / 线程、当场回答、问 AI）给。
 *
 * - `say`：把一句话（或表单交上来的结构化回话）作为用户的话发进当前对话；不给 = 这段对话不收话，按钮画成禁用的；
 * - `matterId` + `runId`：事项里才有工具按钮（走工具执行器；出的审批卡挂进这件事的时间线）。没有就把按钮那句话发进对话；
 * - 嵌套时里层覆盖外层（事项页给 `say` / `matterId`，每条 AI 回话再给自己的 `runId`）。
 *
 * 只是一份上下文：主包里只有这几行，渲染层仍是用到才加载的那一块。
 */
import { createContext, type ReactNode, useContext, useMemo } from 'react'

export interface GenuiHost {
  say?: ((text: string) => void) | undefined
  matterId?: string | undefined
  runId?: string | undefined
  /** 对话正忙（上一句还在答）：按钮先不收。 */
  busy?: boolean | undefined
  /** 工具按钮跑完（时间线 / 卡片要刷新）。 */
  onToolDone?: (() => void) | undefined
}

const GenuiHostContext = createContext<GenuiHost>({})

export function GenuiHostProvider({
  value,
  children,
}: {
  value: GenuiHost
  children: ReactNode
}): ReactNode {
  const outer = useContext(GenuiHostContext)
  const merged = useMemo(() => {
    const out: GenuiHost = { ...outer }
    for (const [k, v] of Object.entries(value)) if (v !== undefined) Object.assign(out, { [k]: v })
    return out
  }, [outer, value])
  return <GenuiHostContext.Provider value={merged}>{children}</GenuiHostContext.Provider>
}

export const useGenuiHost = (): GenuiHost => useContext(GenuiHostContext)
