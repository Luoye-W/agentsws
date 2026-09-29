/**
 * 跑 astro CLI 之前先把它的匿名遥测关掉（docs/42 红线 7 那条精神：默认打开的上报，一律显式关）。
 * 用一个小脚本而不是在 package.json 里写 `ASTRO_TELEMETRY_DISABLED=1 astro …`——那种写法在 Windows 上不认。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const bin = join(dirname(require.resolve('astro/package.json')), 'bin', 'astro.mjs')
const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
})
child.on('exit', (code) => process.exit(code ?? 1))
