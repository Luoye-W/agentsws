# WP247 OpenConnector 按需下载、作为后台服务随工作台启停（不要 Docker）

worktree `../agentsws-wt/wp247-oc` · 分支 `wp/247-oc`（**等 WP245 合并后**从 main 新起，复用它的「用自带 Node 往应用数据目录装包」）。先读 `_common.md`、`docs/08-OpenConnector接入设计.md`（§5 安装器策略、§2 凭据边界 / 运行时 token）、`docs/18-连接器规范-v1.md`、`docs/13` §5（三档部署、进程监督）、`apps/desktop/src/connect-runtime.ts`（`ConnectLauncher` / `notImplementedLauncher()` 留的口子）、`apps/desktop/src/sidecar.ts`（监督者状态机）、`apps/desktop/src/secrets.ts`、`apps/server/src/connections.ts`（`runtimeStatus` / `absent` / `unhardened`）、WP245 报告。

## 背景（Luoye 10-07 定 85）
连接页现在写「本机还没装连接器」，要用户自己装 Docker 跑 OpenConnector（oomol-lab/open-connector，Apache-2.0），普通用户做不到。定的方案：**仍统一走 OpenConnector**（便于统一管理各家接口），但**不打进安装包、不要 Docker**：用户第一次点「连接店铺 / 数据后台」时按需下载（约 80 MB 压缩），用安装包自带的 Node 22 跑，作为工作台的后台服务随应用启停。86（云端连接增值服务）方向已定、本单不做，但结构上别堵死（runtime 地址仍只认 `AGENTSWS_CONNECT_URL` / 本机 sidecar 两种来源）。

## 要做
1. **按需下载**：连接页「连接店铺」类按钮在 runtime 为 `absent` 时，先弹一个少字的确认（「要先下载连接器，约 80 MB」）→ 下载装进 `<data>/runtime/open-connector/<版本>`（npm 包或官方发布物二选一，评估写进报告；固定版本 + 校验完整性，不跟 latest），带进度、可取消、失败一句人话 + 重试（复用 WP242 cause.code）。
2. **实现 `ConnectLauncher`**：用 `sidecar.ts` 监督者起 / 停 / 崩溃重启；只监听 127.0.0.1、随机或固定空闲端口；把地址交给服务进程（与 `AGENTSWS_CONNECT_URL` 同一出处规则，env 显式设置时优先用 env、不拉起本机的）。应用退出时整棵进程树干净退出（Windows taskkill /T，WP218 那套）。
3. **加固必须通过才算 ready**（08 §5）：首次启动生成加密主密钥（`OOMOL_CONNECT_ENCRYPTION_KEY`）与管理鉴权令牌，存进系统钥匙串（`secrets.ts`），只经环境变量传给子进程，不落盘明文、不进日志；数据目录在 `<data>/runtime/open-connector-data`（每台机一份，品牌靠命名连接区分，核对 WP66 每品牌一套连接的约定）。现有 `hardeningReport` 检查跑通后状态变 `ready`。
4. **升级与卸载**：版本号写在我们代码里，升级时下载新版本、旧版本保留一份可回退；「设置 · 诊断」里能看到连接器版本、状态、重启按钮、删除下载（只删我们下载的那份目录）。
5. 界面按「界面少字」：连接页顶部状态一行（没下载 / 下载中 / 就绪 / 出错），细节进问号。
6. 测试：假下载源 + 假 runtime（本地小 http 服务冒充 OpenConnector 的健康 / 加固接口）覆盖 首次下载 / 取消 / 网络失败 / 崩溃重启 / 加固不过 / env 指定外部 runtime 时不拉起。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；**不碰本机已有的 agentsws-openconnector 容器及任何 docker 容器**；测试不真去网上下载（本地假源）；不连 Luoye 的 Windows（真机复测由 Fable 做）。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary` + 桌面包相关测试；连接页各状态出截图；报告 `docs/briefs/reports/WP247.md`（下载体积实测、要 Luoye 定的事单列）。
