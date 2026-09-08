# 隐藏场景集（31 §1 I9）

合成包不同时当 demo 与验收题库。`packs/dtc-3c-3p/scenarios/` 里的场景随包发布，
既是 demo 也是回归基线；**验收另用这里的题**，不随包发布、正文内联（不进 pack 的 fixtures），
这样"把 fixtures 背下来"不会让分数变好看。

跑法：

```
agentsws simulate --pack packs/dtc-3c-3p \
  --scenario-root packages/simulation/hidden \
  --scenario 'security/*.yml'
```

这里放的是 `security/injected-instruction` 的变体（15 §8.0 那条"陌生人认领订单 →
补发到新地址"，以及把注入伪装成"店铺政策"的一条）。变体只换措辞与身份，不换断言口径。
