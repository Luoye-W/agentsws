---
positions: [site]
roles: [site.shopify-theme]
---
# 装好并登录 Shopify CLI

Shopify CLI 是 Shopify 官方的命令行工具。建站岗位的「网页模板」用它做三件事：把你的主题拉到本机、改好之后推成一份**未发布副本**给你预览、跑官方的 Liquid 检查。上线（发布主题）永远等你在卡上点头。

这一篇只在你的品牌是 Shopify 店时有用；别的建站平台不需要装它。

## 1. 先看 Node 版本

Shopify CLI 靠 Node.js 运行，要 **22 或更新**（卡上「Node」那一格会告诉你现在是几）。

1. 打开「终端」（Mac 在「应用程序 → 实用工具」里）。
2. 输入 `node --version` 回车。看到 `v22.` 或更大的数字就够了。
3. 不够或者提示找不到：去 [Node.js 官网](https://nodejs.org/) 下载 LTS 版装上，装完关掉终端再开一个。

## 2. 安装

在终端里跑这一条（卡上有「复制」按钮）：

```
npm install -g @shopify/cli@latest
```

用 Homebrew 的 Mac 也可以：

```
brew tap shopify/shopify && brew install shopify-cli
```

装完回到卡上点「装好了，再查一次」，「装好」那一格变绿就对了。

## 3. 在浏览器里登录（你自己登）

在终端里跑：

```
shopify auth login
```

浏览器会打开 Shopify 的登录页。用你管理这家店的账号登进去、按提示选好店铺。登完回到卡上点「我登好了」。

- **账号和密码只在 Shopify 自己的页面上输入**，Agents 工坊不经手、不保存。
- 登录后的凭据由 Shopify CLI 自己存在你电脑上它自己的位置，我们不读它，也不写进任何日志。
- 想退出：在终端里跑 `shopify auth logout`。下次用到时 CLI 会让你重新登。

## 4. 装好之后会怎样

- 网页模板在改主题时会：拉主题 → 在本机副本里改 → 跑 `shopify theme check` → 推一份**未发布副本** → 把预览链接放在卡上给你看。
- 发布主题、删除主题这类会换掉顾客看到那一份的事，一律出卡等你批。
- 它只跑 `shopify theme` 这一组命令，不跑别的。

## 常见问题

- **没装会怎样**：不影响别的岗位。网页模板会先走店铺后台接口改主题文件，只是没法本地预览、也跑不了官方检查。
- **我的品牌改成了别的平台**：这张卡会自动消失，相关的 Shopify 技能也会停用；你电脑上装好的 CLI 我们不会去卸。
- **公司里有好几个品牌**：每个品牌各自判断。Shopify 的品牌才会看到这张卡。
- **CLI 会上报使用数据吗**：Agents 工坊在替你跑 CLI 时会带上 `SHOPIFY_CLI_NO_ANALYTICS=1`，把它的使用统计关掉。
