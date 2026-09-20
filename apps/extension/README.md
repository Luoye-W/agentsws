# @agentsws/extension（参考实现）

**这是「插件开放接口」（`docs/76`）的参考实现，功能精简。官方完整版不开源**——内测用户装的是私有 Release 里的 zip（见 `docs/68`）。

它示范的是接口怎么用，不是功能上限：

- 本机直连 + 6 位配对码（配对时绑定扩展 Origin 与令牌）；
- 观测上报（幂等、离线队列补传）；
- 登录云账号即共享公开数据到公共红人库，如实告知（`hello` 里的 `shares_to_public_library`）。

想自己写一个采集插件：从 `docs/76` 的 30 行最小示例开始，不需要这份代码。想看面板、打分、体检这些功能长什么样：用官方完整版。

## 开发

```sh
pnpm install
pnpm -F @agentsws/extension build   # wxt build + zip
pnpm -F @agentsws/extension test
```
