/**
 * shadcn 的 `cn`：radix-nova 组件从 `cn` 包里导入，这里再导出一份给应用层用同一实现。
 * WP461：实现在 `./cn`（认得工坊的字号 / 圆角 / 阴影档位）；vite 把裸 `'cn'` 也指到那里。
 */
export { cn } from './cn'
