# Tremor Raw（抄进来的本地组件）

这两个组件抄自 **Tremor Raw**（<https://raw.tremor.so>），Apache License 2.0，
版权归 Tremor Labs, Inc. 原始源码见
`https://github.com/tremorlabs/tremor-raw/tree/main/src/components`
（`ProgressCircle`、`ProgressBar`）。

**为什么抄不装**：36 §1 定了工作台不引 `@tremor/react` 运行时依赖——它带自己的
Tailwind preset 与一整套颜色，会和 shadcn 的 token 打架。进度环 / 进度条这两个
是画布上真用到的，抄成本地组件、换成 `--ws-*` token，比多一个依赖划算。

改动：颜色类从 Tremor 的 `blue-500` 等换成本项目的 `--ws-*` token；
`tremorTwMerge` 换成本项目的 `cn`；去掉 Tremor 自己的 `focusRing` 变量。

其余 Tremor 组件没有抄，需要时按同样办法一个一个来。
