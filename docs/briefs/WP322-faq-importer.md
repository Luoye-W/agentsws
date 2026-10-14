# WP322 FAQ 导入器：Excel / CSV 一行一条变成知识卡（docs/102；决策 670）

worktree `../agentsws-wt/wp322-faqimport` · 分支 `wp/322-faqimport`。先读 `_common.md`、`docs/102-INMO-Reddit运营自动化方案.md`、`docs/19-知识对象规范-v1.md`、`apps/server/src/knowledge-upload.ts`、`packages/knowledge`（ingest / intake）、`apps/server/src/brand-knowledge.ts`（proposed 卡 + 出处的写法）。

## 要做
1. 知识库上传 xlsx / xls / csv 时，能识别「问答表」：AI 读表头判断哪列是问题、哪列是答案、哪列是分类 / 适用产品 / 语言（列名不固定，中英都有），给人看一眼映射确认（一张「定规矩」卡，配一两行预览），确认后**一行一条**生成 FAQ 知识卡（proposed → 人批 / 个人模式当场生效，照现有知识卡规矩），每条带出处（文件名、工作表、行号）。
2. 重复导入同一份表：按「问题」去重、答案变了出更新提示；删掉的行不自动删卡，提示人。
3. 多工作表、合并单元格、空行、表头不在第一行都要能处理；解析依赖优先用仓里已有的（不加重依赖；要加先说明）。
4. 回复起草（客服 / 社媒 / Reddit）检索知识时能命中这些 FAQ 卡（核对现有检索路径能读到）。
5. 测试：手写的假 FAQ 表（中英、多 sheet、怪表头）；不放任何真实客户数据。

## 纪律
不读 .env*；不碰 key / token；不连远程机器；不碰本机 4317；不跑批量清理；界面少字。不合 main、不打 tag、不发版（决策 381）。本机负载偏高，测试用 `--maxWorkers=2 --testTimeout=120000`。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + gen 检查（契约改了重出 cloud-openapi）+ 装包前冒烟；报告 `docs/briefs/reports/WP322.md`（决策号从 700 起）。
