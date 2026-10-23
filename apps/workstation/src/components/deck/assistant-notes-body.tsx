/**
 * WP350（决策 900）：助理把一份资料拆给几个岗位时，「要记的 N 条」那张确认卡的主体——
 * 按岗位（品牌公共也是一组）列每条正文，下面一行灰字是原文出处。按钮就是卡上的通过 / 不要，不在这里画。
 */
import type { AssistantNotesPayload } from '@agentsws/contracts'

export function AssistantNotesBody({
  payload,
}: {
  payload: AssistantNotesPayload
}): React.ReactNode {
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="deck-layout-assistant-notes">
      {payload.groups.map((g) => (
        <section
          key={g.name}
          className="flex flex-col gap-1 rounded-lg bg-ws-surface p-3 text-[13px] leading-5"
          data-testid="assistant-notes-group"
        >
          <p className="text-xs font-medium text-ws-muted-fg">{g.name}</p>
          {g.notes.map((n) => (
            <div key={n.text} className="min-w-0">
              <p className="text-ws-ink">{n.text}</p>
              {n.quote === undefined || n.quote === n.text ? null : (
                <p className="truncate text-[12px] text-ws-muted-fg" title={n.quote}>
                  “{n.quote}”
                </p>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}
