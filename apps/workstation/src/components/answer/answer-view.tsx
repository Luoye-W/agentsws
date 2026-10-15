/**
 * WP291（决策 356；docs/96 §3 P4、§4.2）：当场回答的组件——按契约 `AnswerComponent` 的 `kind` 画，
 * 模型不吐 HTML；认不得的 `kind` 不画。
 *
 * WP336（决策 810–812、823）：只剩两种——一段字（安全 markdown）与一块 `genui`（```dsh-ui 白名单过滤后
 * 交给 dsh-genui 渲染层画）。WP291 的表格 / 数字组件已删（不留 ```answer 回退）。
 */
import { type AnswerComponent, type GenuiSpecLite, genuiToText } from '@agentsws/contracts'
import type { ReactNode } from 'react'
import { SafeMarkdown } from '@/components/ui/safe-markdown'
import { GenuiBlockView } from './genui/genui-block'

/** 一块 genui：渲染层画；还没下载完 / 画不了 / 抛错都退回几行 markdown（表格 / 数字 / 字）。 */
function GenuiAnswer({ spec }: { spec: GenuiSpecLite }): ReactNode {
  return (
    <GenuiBlockView
      spec={spec}
      fallback={
        <SafeMarkdown text={genuiToText(spec)} variant="reply" testId="answer-genui-fallback" />
      }
    />
  )
}

export function AnswerComponents({
  components,
}: {
  components: readonly AnswerComponent[]
}): ReactNode {
  if (components.length === 0) return null
  return (
    <div className="flex flex-col gap-3" data-testid="answer-components">
      {components.map((c, i) => {
        const key = `${c.kind}-${i}`
        /*
         * WP295：一段字走同一份安全 markdown（时间线也用它）。回话里的站内链接能点；
         * 仍不解析 HTML（`<b>` 照旧是三个字）。
         */
        if (c.kind === 'text')
          return (
            <SafeMarkdown
              key={key}
              text={c.text}
              variant="reply"
              className="text-[14px] leading-[1.7] text-ws-body"
              testId="answer-text"
            />
          )
        if (c.kind === 'genui') return <GenuiAnswer key={key} spec={c.spec} />
        return null
      })}
    </div>
  )
}
