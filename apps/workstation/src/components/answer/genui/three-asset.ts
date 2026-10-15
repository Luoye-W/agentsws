/**
 * WP341（决策 847）：3D 引擎——插件自己打好的那一份（`lib/assets/three.js`，MIT；里面带 three.js）。
 * 只有回话里真有 `scene3d` 时才加载（单独一块，本机取）。加载时登记到 `window.__GenuiAssets__.three`。
 * 3D 只画白名单里的几种形状与颜色：没有贴图、外部地址、脚本、着色器。
 */
import 'genui-engine:three'
