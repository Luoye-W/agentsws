# apps/cli

agentsws 命令行。v1 实现了模拟回路那三条（26 §5）：

| 命令 | 做什么 |
|---|---|
| `agentsws simulate --tier fast --pack <dir> --scenario <glob> --seed N --report out/` | 跑场景，出报告与合并门禁结论；任一失败退出码非 0 |
| `agentsws synth --pack dtc-3c --people 3 --orders 50 --seed 42 --out <dir>` | 生成合成公司数据集，固定 seed 可复现 |
| `agentsws replay <run_id> --db <events.db>` | 从事件日志重组 prompt，与 `prompt.assembled.hash` 比对（17 §6.1） |

规划中：init / doctor / export / import / restore / upgrade。

相对路径按 `INIT_CWD` 解析，所以仓库根的 `pnpm simulate --pack packs/...` 与直接调用一样。
