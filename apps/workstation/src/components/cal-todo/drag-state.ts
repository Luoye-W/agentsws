/**
 * WP469：正在拖的是哪一件待办（拖到一半时日历要按它的长短画那一格高亮）。
 *
 * 浏览器的拖放在 `dragover` 里读不到 `dataTransfer` 里的内容（只看得到类型），所以起拖的那一处
 * （清单一行、「还没排期的」一行、日历上的一块）顺手在这里记一笔，松手 / 取消时清掉。
 */
export interface DraggingTodo {
  id: string
  /** 现在占多长（分钟）；没钟点的按默认一小时画 */
  minutes: number
}

let current: DraggingTodo | undefined

export function setDragging(next: DraggingTodo | undefined): void {
  current = next
}

export function getDragging(): DraggingTodo | undefined {
  return current
}
