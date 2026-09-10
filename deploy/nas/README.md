# 把 agentsws 装在公司自己的 NAS 上

面向的是这种情况：公司有一台群晖 / 威联通，或者一台放在办公室的小机器；
**数据要留在公司自己的盘上，谁走了都带不走，也不经过任何第三方**（40 §1.2、41 §2.1）。

装完之后是这样的：

- NAS 上跑两个容器：服务进程 + 连接器；数据（库、附件、录音）全在 NAS 的共享目录里
- 同事的电脑装桌面壳，选「连接公司服务器」，填 NAS 的地址就能用；**电脑上不存真源**（40 E3）
- 每天自动导一份备份到你指定的目录；NAS 自己的快照与异地同步照旧管用

大文件（附件、录音）想搬去 MinIO 或云上的桶：**改一个环境变量就行，服务进程一个字不用改**
（21 §3、41 §2）。数据库换 Postgres 这一半还没走完——底座做好了，
还有几个模块的存储层要转成异步面，见 §5 里那段说明。

---

## 0. 先确认三件事

| | 要求 | 怎么看 |
|---|---|---|
| 型号 | 支持 Docker / Container 套件的机型 | 群晖：套件中心里能搜到「Container Manager」（DSM 7.2 之前叫 Docker）；威联通：App Center 里有「Container Station」 |
| 内存 | 建议 4 GB 以上（Postgres 档 8 GB） | 低于 2 GB 的入门机型跑得起来但会很慢 |
| 架构 | x86_64 或 arm64 | 群晖的 DS220j 这类 ARMv8 也行；ARMv7 的老机型不支持 |

没有 NAS 也能照这份做：一台内网 Linux 小机器、一台常开的 Mac mini 都行，
把「共享目录」换成普通目录即可。

---

## 1. 准备共享目录

在 NAS 上新建一个共享文件夹专门放它，**不要放在 home 里**（换管理员账号会连不上）。

| | 建议路径 |
|---|---|
| 群晖 | `/volume1/agentsws` |
| 威联通 | `/share/agentsws` |

里面会自动长出这几个子目录：

```
agentsws/
├── data/                # ← 挂进容器的 /data
│   ├── *.db             # SQLite 库（第一档）
│   ├── blobs/           # 附件与录音（本地目录档）
│   ├── openconnector/   # 连接器的凭据库
│   ├── postgres/        # 只有开了 postgres 档才有
│   └── minio/           # 只有开了 s3 档才有
└── backups/             # 每日导出包（见 §6）
```

**权限**：容器里是 `node` 用户（uid 1000）在写。群晖的共享文件夹默认属主不是它，
所以第一次要在 SSH 里给一次属主：

```sh
sudo chown -R 1000:1000 /volume1/agentsws
```

威联通同理（把路径换成 `/share/agentsws`）。不做这一步，容器起来会报「权限不足」写不了库。

---

## 2. 拿到文件、生成密钥

SSH 进 NAS（群晖：控制面板 → 终端机与 SNMP → 启用 SSH；威联通：控制台 → Telnet/SSH）：

```sh
cd /volume1/agentsws            # 威联通：cd /share/agentsws
git clone https://github.com/Luoye-W/agentsws.git app
cd app

cp deploy/nas/env.example .env
sh deploy/nas/gen-keys.sh >> .env
chmod 600 .env
```

然后编辑 `.env`，至少改这三行：

```ini
AGENTSWS_OWNER_EMAIL=你的邮箱@公司.com
AGENTSWS_WORKSPACE_NAME=我的公司
AGENTSWS_HOST_DATA_DIR=/volume1/agentsws/data
```

> **密钥只生成一次。** 重新跑 `gen-keys.sh` 会让已经存进去的凭据与加密过的个人数据读不出来
> （21 §4 的主体密钥就是靠 `AGENTSWS_DATA_KEY` 包裹的）。把 `.env` 备份到密码管理器里。

---

## 3. 起容器

### 命令行（最省事）

```sh
docker compose up -d          # 群晖 DSM 7.2+ / 威联通 QTS 5.1+ 自带 compose v2
docker compose ps             # 两个容器都是 healthy 就成了
curl -fsS http://127.0.0.1:4317/v1/health
```

### 群晖 Container Manager（图形界面）

1. 打开 **Container Manager → 项目 → 新增**
2. 项目名称填 `agentsws`；路径选 `/volume1/agentsws/app`
3. 来源选 **「使用现有的 docker-compose.yml」**，它会自动读到仓库里那一份
4. 下一步会让你确认要建的服务（`server`、`openconnector`），**不要**勾 `postgres` / `minio`
   （它们在 profile 里，默认不起）
5. 建立 → 完成后在「容器」页看到两个绿点

> Container Manager 读 `.env` 的位置就是项目目录（`/volume1/agentsws/app/.env`），
> 所以 §2 的步骤不能跳。

### 威联通 Container Station

1. **Container Station → 应用程序 → 建立**
2. 应用程序名称填 `agentsws`
3. 把 `docker-compose.yml` 的内容整段贴进 YAML 框
4. Container Station 不读项目目录的 `.env`，所以要么把 `.env` 里的值直接贴进 YAML 的
   `environment`，要么在「进阶设定 → 环境变量」里逐条填
5. 建立

---

## 4. 端口与 HTTPS

默认 `.env` 里是 `AGENTSWS_BIND=127.0.0.1`：**只有 NAS 自己能开**。给同事用要改两处：

```ini
AGENTSWS_BIND=192.168.1.10      # NAS 的内网地址，不要写 0.0.0.0
AGENTSWS_HOST_PORT=4317
```

然后 `docker compose up -d` 重建一次。

**别把 4317 直接映射到公网。** 两条推荐的做法：

| 场景 | 做法 |
|---|---|
| 只在公司内网用 | 就用内网地址；出差的人走 NAS 自带的 VPN（群晖 VPN Server / 威联通 QVPN） |
| 要从外面直接用 | 用 NAS 自带的反向代理 + 免费证书：群晖「控制面板 → 登录门户 → 反向代理服务器」，威联通「网页服务器 → 反向代理」。来源 `https://agentsws.你的域名`，目的地 `http://localhost:4317`；证书用 DSM/QTS 的 Let's Encrypt 一键申请 |

反向代理那条要把 WebSocket 打开（工作台的实时推送走 `/v1/ws`）：
群晖在反向代理规则的「自定义标头 → 建立 → WebSocket」点一下即可。

---

## 5. 换后端：Postgres 与对象存储

两个都是**加一个 profile + 改一行环境变量**，服务进程不动。

### Postgres（人多了、并发写多了）

> **现在到哪一步了（不含糊）**：事件日志与共享数据层已经能跑 Postgres，
> 其余几个模块（审批与账本、渠道、会议、工作模型、定时、学习、知识）
> 的存储层还是同步接口，只能跑 SQLite。所以**今天起这个 profile，
> 服务进程仍然把数据写在 SQLite 里**——容器是为下一步准备的。
> 等那几个包转成异步面，这一节会改成「改一行、重启、就切过去了」。

```ini
# .env
POSTGRES_PASSWORD=一个长随机串
DATABASE_URL=postgres://agentsws:一个长随机串@postgres:5432/agentsws
```

```sh
docker compose --profile postgres up -d
```

数据落在 `<共享目录>/data/postgres`。**已有的 SQLite 数据不会自动跟过去**——
在工作台「连接 → 数据后端」里点「迁移」（导出旧库 → 导入新库 → 切换，旧库只读保留 7 天），
切换要**重启服务进程**才生效。

### 对象存储（附件与录音搬出数据库）

自带 MinIO：

```ini
AGENTSWS_BLOB_URL=s3://agentsws/?endpoint=http://minio:9000&region=us-east-1
AGENTSWS_BLOB_ACCESS_KEY_ID=agentsws
AGENTSWS_BLOB_SECRET_ACCESS_KEY=一个长随机串
```

```sh
docker compose --profile s3 up -d
# 第一次要建桶：浏览器开 http://<NAS 内网地址>:9001 用上面的账号登录 → Create Bucket → agentsws
```

NAS 自带 MinIO 套件的（群晖套件中心、威联通 App Center 都有），可以不起这个容器，
把 `endpoint` 指向套件的地址即可。云上的桶（阿里 OSS / 腾讯 COS / R2 / B2）同理——
**只换 endpoint 与区域，不为任何一家写代码**（41 F5）。

不设 `AGENTSWS_BLOB_URL` 时，附件与录音落 `<共享目录>/data/blobs`，也就是 NAS 的盘上。
对 5–50 人的公司这一档通常就够。

---

## 6. 备份

三层，缺一层都不叫备份：

1. **每日导出包**（应用层）：服务进程自带的备份任务每天把工作区导成一个带清单与哈希的包，
   落在 `<共享目录>/backups`。它能跨版本、跨后端恢复（40 §1.3 的「双向搬家」同一格式）。
2. **NAS 快照**（文件系统层）：群晖 Btrfs 快照 / 威联通快照，对整个共享目录每天一份、留 30 天。
   数据库文件在快照里是崩溃一致的——恢复后服务进程会先跑对账再放开出站（15 §5.8）。
3. **异地**：群晖 Hyper Backup / 威联通 HBS 3，把 `backups` 目录同步到另一台 NAS 或对象存储。
   **只同步 `backups`，不要同步 `data`**：正在写的数据库文件同步过去多半是坏的。

恢复演练每季度做一次：拿最近一个导出包，在一台干净机器上 `import` 一遍，看能不能登进去。
没演练过的备份不算备份。

---

## 7. 员工电脑怎么连

同事装桌面壳，第一次启动选 **「连接公司服务器」**，填 `http://<NAS 内网地址>:4317`
（配了反向代理就填 `https://agentsws.你的域名`），然后用你在工作台「公司 → 成员」里
发的邀请链接登录。

电脑上只有缓存与草稿，**真源始终在 NAS 上**（40 §1.2 规则 1）。人离职时在
「公司 → 成员 → 离职」走一遍：在办事项转接手人、个人层归档、token 立即失效。

---

## 8. 升级

```sh
cd /volume1/agentsws/app
git pull
docker compose up -d --build
```

迁移是幂等的、一次一事务：升级时自动补跑没跑过的版本，中途失败不会留下半张表。
升级前建议先手动触发一次导出（工作台「设置 → 备份 → 立刻备份」）。

---

## 9. 出问题先看这三样

```sh
docker compose ps                       # 容器状态
docker compose logs -f server --tail=200
curl -fsS http://127.0.0.1:4317/v1/health | head -c 400
```

| 症状 | 多半是 |
|---|---|
| `server` 反复重启，日志里有 `EACCES` / `SQLITE_CANTOPEN` | §1 的属主没给：`sudo chown -R 1000:1000 <共享目录>` |
| 起来了但打不开页面 | `AGENTSWS_BIND` 还是 `127.0.0.1`；改成 NAS 内网地址再 `up -d` |
| 连接页里 provider 全是「不可用」 | `openconnector` 容器没起来，或 `OOMOL_CONNECT_ADMIN_TOKEN` 两边不一致 |
| Postgres 档连不上 | `DATABASE_URL` 里的主机名要写 `postgres`（compose 服务名），不是 `localhost` |
| 大文件写不进去 | S3 档的桶还没建，或 `AGENTSWS_BLOB_*` 三个变量没配齐 |
| 试连报 `must not resolve to private or reserved IP` | 这台机器（或它的网关）在用**代理的 fake-IP 模式**，见下面一段 |

### 9.1 代理 fake-IP：外网域名被当成内网拦下

Clash / Surge 这类代理开着 fake-IP 时，会把外网域名解析成 `198.18.x.x` 这种
**保留网段**的假地址（真连接由代理接管）。连接器的出站防护看到解析结果落在保留段里，
就当成"有人想让我去打内网"，直接拒掉，回一句
`Egress blocked: hostname must not resolve to private or reserved IP`。

连接页的状态条会把这件事说成人话（黄条「你的网络在用代理的 fake-IP 模式」）。
两条修法，任选其一：

```sh
# ① 让连接器容器绕开代理的解析，直接用公共 DNS
#    compose 里给 openconnector 加 dns:；本机开发跑 scripts/dev-real.sh 会自动检测并这么做
docker compose exec openconnector cat /etc/resolv.conf   # 先看它现在用的是谁

# ② 或者把要连的域名加进信任名单（逗号分隔），写进 .env 再 up -d
echo 'AGENTSWS_CONNECT_TRUSTED_HOSTS=admin.shopify.com,api.deepseek.com' >> .env
```

判断"是不是这个原因"的一句话：

```sh
docker compose exec openconnector getent hosts admin.shopify.com
# 回 198.18.x.x / 240.x.x.x 这种 = 是；回真实公网地址 = 不是，另找原因
```
