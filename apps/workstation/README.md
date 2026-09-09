# apps/workstation

工作台最小版（36）。Vite + React 19 + react-router + shadcn/ui（radix-nova / neutral）+ Tailwind v4
+ lucide + recharts + TanStack Query。只经 `/v1` 一个后端，**不引入任何模型 SDK**。

- 首页 = 卡片收件箱 + 每岗位核心数据条 + 摘要 + 「预计 X 分钟」；无图表无表格
- 岗位页 = 卡片 / 面板 / 记录 三个 Tab；面板按数据源分块，没接的出「去连接」
- 对话入口只有三处：卡片里的「指导」抽屉、「问 AI」单轮面板、⌘K 命令面板；**没有全局聊天框**

```bash
pnpm --filter @agentsws/workstation dev     # 起在 127.0.0.1:4318，/v1 代到 127.0.0.1:4317
pnpm --filter @agentsws/workstation build   # 产物在 dist/，由 apps/server 在 / 托管
pnpm dev:demo                               # 用合成世界当后端，一条命令看全套
```

卡片类型与积木的算数在 `@agentsws/deck`（纯逻辑，六端共用）；这里只渲染。
