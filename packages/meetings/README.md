# @agentsws/meetings — 会议内核（37 §4）

会议是**内核对象**，不是可有可无的应用。这个包是免费默认层（随安装、Apache-2.0）：

| 免费默认（本包） | 付费增强（我们的应用） | 第三方应用 |
|---|---|---|
| 会议对象与两档存储、受控原始材料区、六种记录来源、转写槽、规则抽取、认领卡、纪要导出 | 实时入会 bot、说话人分离与人名匹配、Plaud / Otter 自动同步、多语翻译、会后跟进邮件 | 平台专用 bot、行业模板、自定义抽取 |

三层共用两个扩展点（23 `provides.extensions`）：

- `meeting.record_source` —— 记录从哪来（`poll` / `accept` / `sync` 三种拿法）
- `meeting.processor` —— 转写 → 产出（必须走围栏与 provenance）

免费默认版就是用同一套扩展点实现的第一个应用（`agentsws/default-meeting-assistant`），
所以第三方能整个替换掉它，也能叠加在它之上。

## 一条线

```
来源扩展点 → 受控原始材料区（18 §2.1）→ 转写（模型网关 ASR 槽，22）
  → 围栏包裹（Model-visible ⟺ logged）→ 处理器扩展点 → MeetingOutputs
  → claim / knowledge_update / policy_change 三种审批项 payload（14 §3）
```

## 四条不许破的

1. **原始音视频永不进模型**：进模型的只有转写文本，且先过 `EXTERNAL_FENCE`。
2. **音频与转写正文永不进事件日志**：事件里只有 sha256、时长、字节数、条数。
3. **外部人在场且没记到录音告知 → 拒绝转写**，出一张系统卡（不是审批项）。
4. **产出不落库成待办**：只发认领卡；`speech_state` 三态里哪一种都不形成责任，
   本人在卡片上确认才算（06 §2、31 I13）。点名的人不在场、或动作涉及钱与价格的，
   一律降到 `suggested`。

## 用

```ts
const store = createSqliteMeetingStore({ dbPath, clock, random })
const raw = createSqliteMeetingRawStore({ dbPath, clock })
const pipeline = createMeetingPipeline({
  store, raw, clock,
  transcribe: (audio, meta) => gateway.transcribe(audio, meta),   // 没装 ASR 就不给，管线出系统卡
})
const [record] = await pipeline.ingest({ workspace_id, meeting_id, actor, source: 'handed_over', payload: { text } })
const { outputs, approvals } = await pipeline.process(record.id)  // approvals 交给 ApprovalBus.create
```

合成样本在 `src/fixtures.ts`（`fixtures/samples.ts` 是它的稳定入口）：14 份，三种导入格式、
六种来源、中英混合，含注入与假指派——测试逐条断言「注入不产生待办」「假指派只到 suggested」。
