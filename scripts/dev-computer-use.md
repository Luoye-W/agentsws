# 本机手工验证：电脑操控（WP144 / docs/80）

> **要人在场。** 下面第 4、5 步会真的让 AI 看你的屏幕、点你的电脑。实现方（WP144）**没有**跑这几步，
> 留给 Luoye / Fable 在自己的电脑上跑一遍。CI 与自动测试里**不启动真驱动**。

自动化那一层测到哪为止：

| 层 | 谁测 | 测到哪 |
|---|---|---|
| 提供方挂载、工具报上来、独占槽、批过才挂、没装好不挂、坏驱动不打死我们、卸载时驱动退出、两个开关进驱动环境 | `packages/dsh-adapter/test/computer-use-seam.test.ts`（**真提供方 + 假 MCP 驱动**） | 自动 |
| 门禁：一律按写、没授权 / 过期 / 交还给人即拒、查更新与写文件硬拒、截图不进模型、两档都能出卡 | 同上 | 自动 |
| 钉版本 + sha256 安装、校验不过什么都不留、自检只调 `check_permissions {prompt:false}` | `apps/server/test/computer-use-install.test.ts`（假 release 服务器 + 假驱动） | 自动 |
| 三层开关、一次授权只用一回、停止 / 关总开关即停 | `apps/server/test/computer-use.test.ts` | 自动 |
| profile 默认关、叠 opt-in 才开 | `packages/dsh-adapter/test/profile-lockdown.test.ts` | 自动 |
| **真的装驱动、真的授权系统权限、让它截一张图、点一下** | 下面这份 | **手工** |

实现方只做过两件只读的事：下载 `cua-driver-rs-0.28.0-darwin-universal-binary.tar.gz` 与
`…-windows-x86_64-binary.zip` 核对 sha256 与包内结构；在临时 HOME 下跑过一次
`cua-driver --version`（环境里两个开关都设了 false；输出 `cua-driver 0.28.0`，临时 HOME 里什么都没写）。

---

## 0. 前提

- macOS（下面按 macOS 写；Windows 见第 6 节）；
- 从**打包好的桌面版「Agents 工坊」**启动（权限要给它；从终端 `pnpm dev` 起的话，权限记在终端应用上——
  那样也能验，但第 2 步要给的是你的终端，不是 Agents 工坊）；
- 配好了一个能用的模型（服务端只有配了模型才会把带电脑操控的运行交给 dsh 运行时）。

## 1. 打开总开关、勾一条职责、下载驱动

设置 → **电脑操控**：

1. 勾「允许 AI 操作这台电脑」——先读一遍下面那段风险说明；
2. 「每次授权」留 10 分钟；
3. 在「哪几条职责可以操作电脑」里只勾一条你拿来试的职责（比如建站）；
4. **① 下载驱动** → 按「下载」。期望：显示「已装好（0.28.0）」。驱动在
   `<数据目录>/computer-use/cua-driver-0.28.0/cua-driver`，**不在 PATH 上**：

   ```sh
   ls "$HOME/Library/Application Support/agentsws/data/computer-use/cua-driver-0.28.0/"
   which cua-driver   # 应当什么都没有
   ```

## 2. 授权系统权限（只有你能点）

**② 授权系统权限** → 分别按「打开『辅助功能』」「打开『录屏』」。系统设置会打开到那一页；
把「Agents 工坊」打开（列表里没有就点 + 加进去）。**改完重开 Agents 工坊**（macOS 的录屏权限要重开才生效）。

## 3. 自检

**③ 自检** → 按「检查」。期望两条都是 ✅：

```
✅ Accessibility: granted.
✅ Screen Recording: granted.
```

这一步只让驱动**只读**地查一次（`check_permissions {prompt:false}`），不弹框、不截屏、不点。
有 ❌ 就照下面那句「怎么修」做，再查一次。

## 4. 让它截一张图（第一次授权卡）

在那条勾了的职责下开一件事，写一句类似「看一下我电脑上现在开着哪些应用，截一张备忘录窗口的图」。

期望：

1. 这一轮它**只能**调 `request_computer_use`，牌堆里出一张「让它在接下来 10 分钟操作这台电脑？」的卡；
2. 按「允许」——这件事自动重新开始；**托盘图标变红**，菜单最上面是「AI 正在操作电脑（到 HH:MM）· 停止」，
   工作台右上也有同一行；
3. 时间线里有「AI 正在操作这台电脑（授权到 HH:MM）」和每一次驱动调用（`progress{computer_use}`）；
4. 它读到的是无障碍树文字；**截图不会进模型**（模型那边只看到一句「截图不进模型」）。

## 5. 点一下，然后停

让它在备忘录里点一下「新建」。然后在托盘点「停止」。期望：

- 运行立刻中断（事项里记为取消），驱动进程退出：`pgrep -fl cua-driver` 没有输出；
- 托盘图标变回黑白、那一行消失；
- 同一件事再跑一次，又要重新出授权卡（一次授权只给一次运行用）。

再试一次让它碰到登录框：期望它调 `computer_handoff` 停下、出一张「它停下来等你接手」的卡，**不会替你输密码**。

## 6. Windows

- 第 2 步不需要（Windows 没有 TCC 那一套）；第一次运行如果 SmartScreen 拦下 `cua-driver.exe`，点「更多信息 → 仍要运行」；
- 下载用系统自带的 `tar` 解 `.zip`（Windows 10 1803 起自带），**这一条实现方没有在真 Windows 上跑过**；
- 驱动参数是 `mcp`（不带 `--direct`；Windows 上 `mcp` 本来就是驱动自己跑）。

## 7. 遥测与查更新关没关

驱动挂上时环境里有 `CUA_DRIVER_RS_TELEMETRY_ENABLED=false` 与 `CUA_DRIVER_RS_UPDATE_CHECK=false`。
跑完第 4 步看一眼：

```sh
ls ~/.cua-driver/ 2>/dev/null   # 不应出现 version_check.json；遥测关着时不发任何请求
```

上游说「关掉遥测仍保留本机安装 ID」（`~/.cua-driver/.telemetry_id` 可能出现，但不上报）——如果出现了，记下来给 Luoye。
