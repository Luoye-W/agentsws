/**
 * WP439：消息页右栏「规则」的地址（`rail.openAddress(MESSAGE_RULES_ADDRESS)`）。
 *
 * 单独一个小文件：内置面板注册（`builtin-panels.tsx`）要认这个地址，但不该为此把面板正文拉进首包。
 */
export const MESSAGE_RULES_ADDRESS = 'agentsws://message-rules'

/** 铃铛里「X 删了发件人规则」点了落到这里：消息页认 `?panel=rules` 就打开规则面板。 */
export const MESSAGE_RULES_HREF = '/messages?panel=rules'

/** WP441：消息页右栏「今天的简报」（铃铛「消息简报：今天 N 封」点进来打开它）。 */
export const MESSAGE_DIGEST_ADDRESS = 'agentsws://message-digest'

/** WP441：铃铛里的简报那一条点了落到这里：消息页认 `?panel=digest` 就打开简报面板。 */
export const MESSAGE_DIGEST_HREF = '/messages?panel=digest'
