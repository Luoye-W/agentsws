/**
 * 把 `src/page/entry.ts`（采集器 + 读一遍这一页的接线）打成**一段**能交给 `page.evaluate` 的脚本文本。
 * `build-page-script.mjs` 用它写 `src/page-script.generated.ts`；`test/page-script.test.ts` 用它查生成的那份没过期。
 */
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

export async function bundlePageScript() {
  const out = await build({
    absWorkingDir: ROOT,
    entryPoints: ['src/page/entry.ts'],
    bundle: true,
    format: 'iife',
    globalName: '__agentswsCreatorCapture',
    platform: 'browser',
    target: 'es2020',
    write: false,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
  })
  return out.outputFiles[0].text
}
