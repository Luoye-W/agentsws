# 接阿里云百炼（三个方案怎么选）

一把 key 同时调通义千问与 DeepSeek，账单也在一处——用过 DeepSeek 官方的人不用再去 platform.deepseek.com 办一把。

百炼有**三个方案**，先选你买的是哪个。三个方案的地址与 key **互不通用**，选错要么打不通（401），要么乱扣钱：

| 方案 | 什么时候选 | key 长什么样 | 怎么扣 |
|---|---|---|---|
| Token Plan（订阅） | 买了 Token Plan 订阅 | `sk-sp-` 开头的专属 key | 按 Credits 扣，不按 token 花钱 |
| 按量计费（标准） | 没买订阅，用多少算多少 | `sk-` 开头 | 按 token |
| Coding Plan（订阅） | 买了 Coding Plan 订阅 | 同样是 `sk-sp-` 开头的专属 key | 按次数配额，不按 token 花钱 |

Token Plan 与 Coding Plan 是两个独立产品，官方明说不能互转——买了哪个走哪个。

## 方案一：Token Plan（订阅）

1. 在百炼控制台开通 Token Plan（订阅制，按 Credits 计量）。
2. 进 Token Plan 页面拿「专属 API Key」——`sk-sp-` 开头，和按量那把不是同一把。
3. 在「阿里云百炼」卡上选「Token Plan（订阅）」，点「填 API key」，把 key 粘进表单；地址保持预填的那条（带 token-plan 的）。
4. 点「拉取模型列表」，订阅里能用哪几个就会列出来，选一个。
5. 点「测试」确认能通。价格三个框留 0 就对——Credits 扣的不是 token 钱。

它只有一个地址（官方只支持华北2 北京）：`https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`。

- [Token Plan 快速开始（拿专属 key 与地址）](https://help.aliyun.com/zh/model-studio/token-plan-personal-quick-start)
- [Token Plan 概述与 Credits 计量](https://help.aliyun.com/zh/model-studio/token-plan-overview)

## 方案二：按量计费（标准）

1. 打开 [百炼控制台（拿 API Key）](https://bailian.console.aliyun.com/?tab=model#/api-key)，用阿里云账号登录并开通。
2. 右上角选好地域（北京 / 新加坡），进「API-KEY」页点「创建我的 API-KEY」。
3. 复制那一串（`sk-` 开头），在卡上选「按量计费（标准）」，点「填 API key」粘进表单。
4. 地址按地域选：国内用「百炼 · 北京（国内）」那条，海外用「百炼 · 新加坡（国际站）」那条（两边的 key 不通用）。
5. 选模型名 → 点「测试」，回了模型名和延迟就是通了。

两条地址：

- 北京（国内，数据驻留 cn）：`https://dashscope.aliyuncs.com/compatible-mode/v1`
- 新加坡（国际站，数据驻留 global）：`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`

标准口没有「拉取模型列表」（官方只有对话接口），拉不到时下拉框里给的是内置价目表里核实过的那份清单，照样在下拉框里选。

- [模型列表与计费](https://help.aliyun.com/zh/model-studio/models)
- [DeepSeek 在百炼上怎么调](https://help.aliyun.com/zh/model-studio/deepseek-api)

## 方案三：Coding Plan（订阅）

1. 在百炼控制台开通 Coding Plan（订阅制，官网写明按次数配额）。
2. 进 Coding Plan 页面点「获取 API Key」——同样是 `sk-sp-` 开头的专属 key。
3. 在卡上选「Coding Plan（订阅）」，把 key 粘进表单；地址保持预填的那条（带 coding、没有 compatible-mode）。
4. 点「拉取模型列表」，订阅里有哪几个模型就会列出来，选一个。
5. 点「测试」确认能通。价格三个框留 0 就对——配额扣的不是 token 钱。

两条地址：国内 `https://coding.dashscope.aliyuncs.com/v1`，国际站 `https://coding-intl.dashscope.aliyuncs.com/v1`。

- [Coding Plan 说明与配额](https://help.aliyun.com/zh/model-studio/coding-plan)
- [常见问题（含国际站地址）](https://help.aliyun.com/zh/model-studio/coding-plan-faq)

## 常见问题

- **401 invalid_api_key**：多半是 key 和方案对不上（比如拿 Token Plan 的 `sk-sp-` key 打标准口）。换到对应的方案再试。
- **订阅还剩多少**：只有百炼控制台算得出来，我们这边不编。
