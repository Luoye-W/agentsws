/**
 * 跑 astro CLI 之前先把它默认的两处出网关掉（docs/42 红线 7 那条精神：默认打开的上报，一律显式关）：
 * 匿名遥测（`@astrojs/telemetry`，每次跑 CLI 都发）与 `astro dev` 每 12 天查一次 npm 上的新版本。
 * 用一个小脚本而不是在 package.json 里写 `ASTRO_TELEMETRY_DISABLED=1 astro …`——那种写法在 Windows 上不认。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const bin = join(dirname(require.resolve('astro/package.json')), 'bin', 'astro.mjs')
const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', ASTRO_DISABLE_UPDATE_CHECK: 'true' },
})
child.on('exit', (code) => process.exit(code ?? 1))
