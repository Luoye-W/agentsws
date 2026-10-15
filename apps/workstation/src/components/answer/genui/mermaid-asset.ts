/**
 * WP341（决策 847）：mermaid 引擎——插件自己打好的那一份（`lib/assets/mermaid.js`，MIT；里面带 mermaid 本体）。
 * 只有回话里真有 `mermaid` 时才加载（单独一块，从工坊自己的服务进程取，不出网）。它加载时把引擎登记到
 * `window.__GenuiAssets__.mermaid`，插件看到登记过就不再插 `<script>`。插件那边以严格模式初始化、画完再查一遍 svg。
 */
import 'genui-engine:mermaid'
