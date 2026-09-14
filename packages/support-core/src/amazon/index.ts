/**
 * Amazon 渠道（48 §4 L3 #2）：识别三层、出站硬闸、24h SLA 三档。
 *
 * 常量表与正则**逐字节抄 KefuAgent**（`src/lib/support/amazon-{channel,guardrail,sla}.ts`），
 * 逻辑重写成 agentsws 的契约与纯函数形态。
 */
export * from './detect.js'
export * from './outbound-guard.js'
export * from './sla.js'
