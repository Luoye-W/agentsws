# 贡献指南

感谢你的贡献。本项目采用 Apache-2.0 许可证，贡献采用 **DCO（Developer Certificate of Origin）**，不需要签署 CLA。

## DCO：每个提交签一行

在提交信息末尾加上：

```
Signed-off-by: 你的名字 <you@example.com>
```

用 `git commit -s` 会自动加。这一行表示你确认 https://developercertificate.org/ 的内容：你有权以本项目的许可证提交这段代码。

## 贡献什么

- **职责包 / 技能 / 模板**（声明类，最欢迎）：遵循 `docs/23-应用包与市场API规范-v1.md` 的 `package.yml` 与 Agent Skills 格式；本地 `agentsws test` 通过后提 PR
- **连接器 / provider**：优先贡献到上游（dsh-channels、OpenConnector），本仓只放 vendored 过渡版本与契约测试
- **契约与内核**：接口语义已冻结（`docs/32` §2），只接受加字段、加类型、修 bug；改语义请先开 issue 讨论并附迁移方案
- **文档与场景**：模拟场景（`docs/26`）与合成数据 pack 的补充非常有价值

## 规则

- 每个 PR 一件事；附上一致性用例或模拟场景的变化
- 不提交任何凭据、真实客户数据；合成数据请用生成器
- 安全问题请私下报告（SECURITY.md，待建），不要开公开 issue
