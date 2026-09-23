# WP129 公共红人库加「内容」一格：插件的视频观测也进云端 + 体检报告样本不够不收钱

worktree：`../agentsws-wt/wp129-content-cloud` · 分支 `wp/129-content-cloud`（从 main 新起）。

## 两件小事
1. **内容观测上云**（WP119c 留尾）：插件在视频页采到的内容数据（播放 / 点赞 / 评论 / 时长 / 发布时间 / 带货与广告标识）现在只落本机 `content_observation`。云端公共库补一条内容路：`packages/kol-public` 的 `content` / `content_metric` 表已存在（WP116 搬家时建的），加写入接口 + 幂等（platform + external_id + observed_at 分桶）+ 计入贡献返额度（口径同红人观测，窄行：不带用户私有备注）；`KolPublicDO` 同步；`apps/server/src/extension-contribute.ts` 加内容转发（只加）；登录了默认共享（同插件规则），未登录不传。
2. **体检报告样本不够不收钱**（Fable 拟、待 Luoye 确认；WP126 报告 §2）：`data.kol.audit` 在「样本不足、只能给部分结论」时预扣释放、不收钱，与「0 条不收钱」同一口径；界面上明说「样本不够，这次不收」。`docs/75` §2 同步。

验证：`scripts/verify-changed.sh` + `wrangler deploy --dry-run`；全替身。
