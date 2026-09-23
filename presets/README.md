# presets

**职责 preset 由职责模板生成，不手编。**

55 §4 第三层：一条职责一个官方 preset，里面放**这条职责有哪些连接**（一条连接一行
`@deepseek-ai/dsh-mcp-client`）。

> **WP132（dsh 0.1.7-rc.1）**：官方把按目录扫的 `@deepseek-ai/dsh-agent-presets` 换成了
> [`@deepseek-ai/dsh-agent-preset-registry`](https://www.npmjs.com/package/@deepseek-ai/dsh-agent-preset-registry)，
> 它**不扫目录、不收路径**。运行时现在把同一份内容（`presetDefinition(req)`）直接
> `register()` 进去；下面说的那三个文件照旧生成，留给跨进程那一面（`host.cordis.yml`）与排障。
> 也因此"官方自带 preset / `$DSH_HOME` 下用户 preset 进不进 roster"不再靠两个开关——
> 我们的组合里没有任何 bundle 行，roster 里结构上就只有我们注册的那一条。

生成的人是 `@agentsws/dsh-adapter` 的 `writePreset()`，输入是一次运行的 `RunRequest`
（职责 + 分配 + 这个品牌已连的连接），输出落在**数据目录**下：

```
<AGENTSWS_DATA_DIR>/presets/<workspace>/<preset_id>/
  agent.cordis.yml   # 能挂的那一份：这条职责的 mcp-client 行
  host.cordis.yml    # 跨进程宿主（dsh --profile）那一份：门禁与模型网关
  preset.yml         # 官方 roster 的显示元数据
```

**这个目录（仓库里的 `presets/`）现在是空的，而且应该保持空的**：

- 运行时的 roster 只扫数据目录下那一层，`includeShippedRoot: false` /
  `includeUserRoot: false`——官方自带的四个 preset 与用户 `$DSH_HOME/.agent-presets`
  下自己写的那些，一个都不进 roster（16 §1：公司端不装第三方代码）。
- preset 权限 = 它所挂插件的权限。手写一个放进来等于绕开"职责模板 → 连接目录 → preset"
  这条链上的每一道判定（读写分类、职责隔离、凭据只走引用）。

要给一条职责加一台 MCP 服务器：在连接页登记它、勾出哪几个工具是只读的，然后在**职责模板**
的 `connectors[]` 里写 `mcp:<名字>`。下一次运行就挂上了。

细节见 `docs/18` §3.4.1 与 `packages/dsh-adapter/AGENT-LAYER.md` §10。
