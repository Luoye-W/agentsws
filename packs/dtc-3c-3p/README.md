# dtc-3c-3p

`agentsws synth --pack dtc-3c --people 3 --orders 50 --seed 42` 生成（26 §2）。

同一份数据是 demo 数据、上手引导数据和回归基线。**验收另用隐藏场景集**
（`packages/simulation/hidden/`，31 §1 I9），不在这里。

生成器拥有：manifest / workspace / people / assignments / policy / store / threads /
creators / campaigns / knowledge / skills / fixtures / 本文件。
生成器不动：`scenarios/`（人写的回归题）、`baseline.json`（跑出来的基线）。
