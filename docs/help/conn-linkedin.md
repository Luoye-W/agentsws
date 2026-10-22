---
group: connect
order: 180
description: 老板本人号可自助开通发帖，公司主页要过 LinkedIn 的审核；批不下来时，到点的已批帖子会变成待办，你复制文案去发。工坊不抓取、不自动加人或私信。
positions: [social-media]
roles: [social.linkedin]
---
# LinkedIn：公司主页与老板本人号

老板本人号加上「Share on LinkedIn」就能自助发帖，公司主页要过 LinkedIn 的 Community Management API 审核；批不下来时排期、起草、审批照常，到点那条变成待办，你复制去发。

| 连接 | 一句话 | 要不要审核 |
|---|---|---|
| LinkedIn（公司主页 + 本人号） | 替你把排好、批过的帖子发到公司主页或老板本人号 | 本人号自助开通；公司主页要过 Community Management API 审核 |

先记住两条：

- **批不下来是常态**。公司主页的发帖权限要过 LinkedIn 的审核，多数小公司一直批不下来。没关系：排期、起草、审批照常；到点那条已批准的帖子会变成一条待办「复制文案去 LinkedIn 发」，你复制过去发、发完点完成。
- **不抓取、不自动加人、不自动私信、不代点赞**。这是 LinkedIn 用户协议明令禁止的。在 LinkedIn 上找客户、加人、发私信是 B2B 岗位的事，那边也只给你出「请你本人去做」的任务。

## LinkedIn（公司主页 + 本人号）

**怎么做**

1. 到 LinkedIn 开发者后台建一个应用，关联你的公司主页。
2. 本人号：加上「Share on LinkedIn」产品（`w_member_social`）；公司主页：申请 Community Management API（审核制，授权的人要是主页管理员）。
3. 走 OAuth 换一把访问令牌。
4. 把令牌与作者 URN 填进表单（公司主页填 `urn:li:organization:…`，本人号填 `urn:li:person:…`）。它们只存在这台电脑上。

**链接**

- [Posts API 文档](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api)
- [访问级别说明](https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access)

**没连会怎样**

没连也能排、能起草、能攒审批。到点那条会变成一条待办，文案已经排好，你复制去发。带图、文档（PDF 翻页）或视频的帖子这一版还不能代发，也会变成待办。

## 常见问题

- **待办和卡有什么不一样**：卡是「要你拍板」，待办是「要你去做」。这条帖子你已经批过了，剩下的只是去 LinkedIn 贴一下，所以是待办。
- **能不能帮我在 LinkedIn 上加采购经理**：不能。那违反 LinkedIn 的用户协议，封的是你的号。找客户在 B2B 岗位，那边只出你本人去加、去发的任务。
- **一天能发几条**：这条职责一天最多 1 条；日历默认一周 2–5 条，一周最多一条产品帖。正文里别放外链，平台会压它的曝光。
