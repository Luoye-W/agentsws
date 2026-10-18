/**
 * WP409（内测真机 10-18 #2）：安装器换范围时收拾另一份。NSIS 只在 Windows CI 上真编、真装
 * （`scripts/win-install-smoke.mjs` 的「换范围重装」那一条）；这里钉住几条不能丢的写法。
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 这里比对的是 NSIS 源码里的 ${…} 写法，不是 JS 模板
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const raw = readFileSync(new URL('../build/installer.nsh', import.meta.url))
const text = raw.toString('utf8')

/** 某个宏的正文。 */
function macroBody(name: string): string {
  const start =
    text.indexOf(`!macro ${name}\n`) >= 0
      ? text.indexOf(`!macro ${name}\n`)
      : text.indexOf(`!macro ${name}\r\n`)
  expect(start, `找不到宏 ${name}`).toBeGreaterThanOrEqual(0)
  return text.slice(start, text.indexOf('!macroend', start))
}

describe('installer.nsh：换安装范围', () => {
  it('还带着 UTF-8 BOM（makensis 才按 UTF-8 读中文）', () => {
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })

  it('新变量只在安装程序里声明（卸载程序那一遍不用，-WX 下没引用的变量会报错）', () => {
    expect(text).toMatch(
      /!ifndef BUILD_UNINSTALLER\s+Var agentswsUserDir\s+Var agentswsMachineDir\s+!endif/,
    )
  })

  it('electron-builder 卸掉按用户那一份之前先记下它在哪（customInit 里读登记）', () => {
    const init = macroBody('customInit')
    expect(init).toContain(
      'ReadRegStr $agentswsUserDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation',
    )
    expect(init).toContain(
      'ReadRegStr $agentswsMachineDir HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation',
    )
    // 要在「只摆不装」那条提前 Quit 的分支之前
    expect(init.indexOf('agentswsUserDir')).toBeLessThan(init.indexOf('--agentsws-stage'))
  })

  it('装完（不论版本目录还是平铺）都收拾另一份', () => {
    const install = macroBody('customInstall')
    expect(install.trimEnd().endsWith('!insertmacro agentswsOtherScope')).toBe(true)
  })

  it('只删认得出是我们的：版本目录要有我们的 exe、平铺要根上有 exe；按机器那份只问、静默装默认不卸', () => {
    const scope = macroBody('agentswsOtherScope')
    expect(scope).toContain('${If} ${FileExists} "$R1\\$R3\\${APP_EXECUTABLE_FILENAME}"')
    expect(scope).toContain('${If} ${FileExists} "$R1\\${APP_EXECUTABLE_FILENAME}"')
    expect(scope).toContain('${If} $R1 != $INSTDIR')
    expect(scope).toContain('/SD IDNO IDYES')
    // 不碰数据目录
    expect(scope).not.toMatch(/\$APPDATA/)
    expect(scope).not.toContain('--delete-app-data')
  })
})
