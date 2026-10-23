#!/usr/bin/env node
/**
 * 重出 `src/page-script.generated.ts`（采集器改了就跑一次：`pnpm --filter @agentsws/creator-capture build:page-script`）。
 * 生成的文件进仓库——桌面版运行时不带打包器；`test/page-script.test.ts` 会查它与源码对得上。
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bundlePageScript } from './page-bundle.mjs'

const text = await bundlePageScript()
const target = fileURLToPath(new URL('../src/page-script.generated.ts', import.meta.url))
writeFileSync(
  target,
  `/* 生成的文件，别手改：\`node scripts/build-page-script.mjs\` 从 src/page/entry.ts 打出来（采集器 + 读一遍这一页的接线）。 */\n` +
    `/** 页面脚本本体（IIFE，跑完在局部变量 \`__agentswsCreatorCapture\` 上露出 \`capturePage\`）。 */\n` +
    `export const CREATOR_CAPTURE_PAGE_BUNDLE: string = ${JSON.stringify(text)}\n`,
)
console.log(`写好了 ${target}（${text.length} 字）`)
