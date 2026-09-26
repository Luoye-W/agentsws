# TikTok 的三个连接

这篇讲 TikTok 的三个连接：红人用的 Research API、社媒发视频用的 Content Posting API、投放用的 Business API。三个都是**申请制**，而且**要分别申请**。

| 连接 | 一句话 | 要不要审核 / 花不花钱 |
|---|---|---|
| TikTok Research API | 红人：按账号名查粉丝数、获赞数、作品数 | 申请制，审核要几天到几周 |
| TikTok Content Posting API | 社媒运营：把视频发到 TikTok | 申请制，和 Research API 分开申请 |
| TikTok Ads（Business API） | 投放 | 还没接；要一个过了审的开发者应用 |

## TikTok Research API

**申请制**：要向 TikTok 提交研究用途说明，批了才有数据。

批下来之后，能按账号名查粉丝数、获赞数与作品数。互动率是我们按「人均获赞 ÷ 粉丝数」估的，这三个数缺一个就不给这一格。TikTok 也没有「按关键词搜人」的接口。

**怎么做**

1. 到 [TikTok for Developers](https://developers.tiktok.com) 注册开发者账号。
2. 申请 Research API 访问权限，写清楚用途。审核要几天到几周。
3. 批下来之后，在应用详情页拿到 client key 与 client secret。
4. 用它们换一个 client access token。有效期两小时，过期再换一次。
5. 把令牌填进表单。它只存在这台电脑上。

**链接**

- [TikTok for Developers](https://developers.tiktok.com)
- [Research API 文档](https://developers.tiktok.com/doc/research-api-get-started)

**没批下来会怎样**

没批下来，这条职责照样能用，只是找人那一块空着。TikTok Shop 的带货归因走追踪链接与联盟码，不靠这条连接。

## TikTok Content Posting API

**申请制**，而且和红人那条用的 Research API **要分别申请**。

发布是两跳：先交给 TikTok，它自己去抓素材，再等它回话。「一跳就发完」这件事在 TikTok 上不存在，所以「发出去了」要等它说发完了才算。另外，它**没有开放的评论读写接口**，「待回评论」那一块在这条渠道上是空的。

**怎么做**

1. 到 TikTok 开发者后台建一个应用，申请 Content Posting API。要写用途说明，审核制。
2. 把要发视频的那个域名加进应用的 URL 白名单。我们用的是 `PULL_FROM_URL`，也就是 TikTok 自己来抓视频。
3. 用 client key / secret 走 OAuth，换一把带 `video.publish` 的访问令牌。
4. 把令牌填进表单。它只存在这台电脑上。

**链接**

- [Content Posting API 文档](https://developers.tiktok.com/doc/content-posting-api-get-started)

**没批下来会怎样**

申请没批下来的时候，TikTok 会回 403。我们说的是「这个接口要先申请」，不是「连接失败」，免得你在这张卡上反复重填一把根本没问题的令牌。在此之前排期、草稿、审批照常，到点提醒你去后台手工发。

## TikTok Ads（Business API）

要先在 Business Center 里，把广告账户授权给一个过了审的开发者应用。它和社媒那条的 Content Posting API 是两套申请。

> **还没接。** 连接目录、职责、额度与面板骨架已经就位，真调用还没做。Spark Ads（投自己发过的视频）还要有机账号那一侧再给一次授权码，所以它接上那天要和社媒的 TikTok 发布（`social.tiktok`）一起做。

**怎么做**

1. 暂时没有步骤——这家还没接。

**链接**

- [TikTok Business API](https://business-api.tiktok.com/portal/docs)

## 常见问题

- **Research API 批了，能不能直接发视频**：不能。发视频要的是 Content Posting API，两者分别申请；投放的 Business API 又是另一套。
- **发布一直显示在等**：TikTok 发布是两跳，要等它自己抓完素材、回话说发完了，才算发出去。
- **Content Posting 报 403**：多半是接口还没批，不是令牌填错了，不用反复重填。
- **TikTok 上的评论能不能让 AI 回**：不能，TikTok 没有开放评论读写接口。
