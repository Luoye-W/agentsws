/**
 * 首启向导的界面（40 §1.3、41 §2.1：本机 / 公司服务器二选一）。
 *
 * 整个界面在 **preload** 里用 DOM API 搭出来，页面本身是 `about:blank`。
 * 为什么这么写：壳给所有响应盖的 CSP 是 `default-src 'self'`（见 `csp.ts`），
 * 页面里的内联脚本一律执行不了；而 preload 不受页面 CSP 管。这样既不用为一个
 * 只出现一次的问卷打包一份 HTML 资源，也不用为它在 CSP 上开口子。
 *
 * `sandbox: true` 的 preload 必须是 CommonJS，所以这个文件是 `.cts`。
 * 它不 require 除 electron 以外的任何东西，也不碰 fs / 密钥。
 */
import electron = require('electron')

const { ipcRenderer } = electron

const CHANNELS = {
  strings: 'agentsws:wizard-strings',
  choice: 'agentsws:wizard-choice',
} as const

interface WizardStrings {
  title: string
  body: string
  local: string
  remote: string
  urlLabel: string
  confirm: string
  cancel: string
  invalidUrl: string
}

const t = ipcRenderer.sendSync(CHANNELS.strings) as WizardStrings

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  return node
}

function render(): void {
  document.title = t.title
  const style = el('style')
  style.textContent = `
    body { font: 13px -apple-system, "Segoe UI", system-ui, sans-serif; margin: 0;
           padding: 24px; color: #18181b; background: #fafafa; }
    h1 { font-size: 16px; margin: 0 0 8px; }
    p { color: #52525b; line-height: 1.6; margin: 0 0 16px; }
    label { display: block; padding: 10px 12px; border: 1px solid #d4d4d8; border-radius: 8px;
            margin-bottom: 8px; cursor: pointer; background: #fff; }
    label:has(input:checked) { border-color: #18181b; }
    input[type="url"] { width: 100%; box-sizing: border-box; margin-top: 8px; padding: 6px 8px;
                        border: 1px solid #d4d4d8; border-radius: 6px; font: inherit; }
    .row { display: flex; gap: 8px; margin-top: 16px; }
    button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid #d4d4d8;
             background: #fff; cursor: pointer; }
    button.primary { background: #18181b; color: #fff; border-color: #18181b; }
    .error { color: #b91c1c; margin: 8px 0 0; }
  `
  document.head.append(style)

  const localRadio = el('input')
  localRadio.type = 'radio'
  localRadio.name = 'mode'
  localRadio.value = 'local'
  localRadio.checked = true
  localRadio.id = 'wizard-local'

  const remoteRadio = el('input')
  remoteRadio.type = 'radio'
  remoteRadio.name = 'mode'
  remoteRadio.value = 'remote'
  remoteRadio.id = 'wizard-remote'

  const url = el('input')
  url.type = 'url'
  url.id = 'wizard-url'
  url.placeholder = 'https://nas.company.lan:4317'
  url.disabled = true

  const localLabel = el('label')
  localLabel.append(localRadio, document.createTextNode(` ${t.local}`))

  const remoteLabel = el('label')
  remoteLabel.append(remoteRadio, document.createTextNode(` ${t.remote}`))
  const urlHint = el('div', t.urlLabel)
  urlHint.style.marginTop = '8px'
  urlHint.style.color = '#71717a'
  remoteLabel.append(urlHint, url)

  const error = el('p', '')
  error.className = 'error'
  error.hidden = true

  const confirm = el('button', t.confirm)
  confirm.className = 'primary'
  confirm.id = 'wizard-confirm'
  const cancel = el('button', t.cancel)
  cancel.id = 'wizard-cancel'
  const row = el('div')
  row.className = 'row'
  row.append(confirm, cancel)

  document.body.append(el('h1', t.title), el('p', t.body), localLabel, remoteLabel, error, row)

  const sync = (): void => {
    url.disabled = !remoteRadio.checked
    if (remoteRadio.checked) url.focus()
  }
  localRadio.addEventListener('change', sync)
  remoteRadio.addEventListener('change', sync)

  confirm.addEventListener('click', () => {
    if (!remoteRadio.checked) {
      ipcRenderer.send(CHANNELS.choice, { mode: 'local' })
      return
    }
    const value = url.value.trim()
    if (!/^https?:\/\/\S+$/i.test(value)) {
      error.textContent = t.invalidUrl
      error.hidden = false
      return
    }
    ipcRenderer.send(CHANNELS.choice, { mode: 'remote', serverUrl: value })
  })
  cancel.addEventListener('click', () => {
    ipcRenderer.send(CHANNELS.choice, { mode: 'cancelled' })
  })
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', () => {
    render()
  })
else render()
