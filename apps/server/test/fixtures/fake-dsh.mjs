#!/usr/bin/env node
/**
 * WP136：一个假的 `dsh` 启动器（`test/dsh-scenes.test.ts` 用）。只认我们会传的那几种参数：
 *
 * - `--profile <n> --from-default-profile <t> --dump-default-config`：像真的一样建
 *   `$DSH_HOME/profiles/<n>/package.json`（bundles 按模板写）然后退出；
 * - `--profile <n> --no-open --host 127.0.0.1 --port 0`：按场景名决定怎么演——
 *   `crashy` 往 stderr 写一句就退出、`silent` 什么都不打（等超时）、其余起一个回环 HTTP 服务，
 *   打 `dsh web: <网址>`，收到 SIGTERM 就退出。
 *
 * 每次起网页都把自己看到的环境变量与工作目录写进 `$DSH_HOME/seen-<n>.json`，
 * 边界测试（交付 3）读它：其他场景的环境里不许有我们的任何密钥。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const TEMPLATES = {
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  sdk: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
  'sdk-minimal': ['@deepseek-ai/dsh-sdk-minimal'],
  acp: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
}

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const home = process.env.DSH_HOME
const profile = flag('--profile')
if (home === undefined || profile === undefined) {
  process.stderr.write('dsh: fake needs DSH_HOME and --profile\n')
  process.exit(2)
}

if (args.includes('--dump-default-config')) {
  const template = flag('--from-default-profile')
  if (template !== undefined) {
    const dir = join(home, 'profiles', profile)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dsh: { profile: { bundles: TEMPLATES[template] ?? [] } } }),
    )
  }
  process.stdout.write('[]\n')
  process.exit(0)
}

mkdirSync(home, { recursive: true })
writeFileSync(
  join(home, `seen-${profile}.json`),
  JSON.stringify({ env: process.env, cwd: process.cwd(), args }),
)

if (profile === 'crashy') {
  process.stderr.write('dsh: 假装起不来\n')
  process.exit(3)
}
if (profile === 'silent') {
  setInterval(() => undefined, 1000)
} else {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('fake dsh web')
  })
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    process.stdout.write(`dsh web: http://127.0.0.1:${port}/?token=fake-token-${profile}\n`)
  })
  process.on('SIGTERM', () => {
    server.close()
    process.exit(0)
  })
}
