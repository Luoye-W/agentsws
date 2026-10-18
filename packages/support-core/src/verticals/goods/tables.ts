/**
 * WP404（docs/107 §3）：goods 包的三张内容表（随软件带的那一份）。persona / rules / intents 三个文件从这里拿行。
 */
import { verticalTables } from '../content.js'
import INTENTS from './intents.content.json' with { type: 'json' }
import PERSONA from './persona.content.json' with { type: 'json' }
import RULES from './rules.content.json' with { type: 'json' }

export const GOODS_TABLES = verticalTables({ persona: PERSONA, rules: RULES, intents: INTENTS })
