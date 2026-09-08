# packages/connectors

渠道与系统连接器：email / whatsapp / feishu / shopify。渠道类实现 dsh-channels 的 ctx.channels 契约（贡献回上游）；外部接收层负责去重、队列、重试，最后一跳才落 dsh。
