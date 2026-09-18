#!/bin/sh
# 云侧数据的每日备份（WP110）。由 compose 里的 `backup` 容器每 24 小时跑一次，
# 也可以手动跑：docker compose exec backup sh /backup.sh
#
# **为什么不是 `cp`**：这几个库都开着 WAL（`journal_mode = WAL`）。写在 `-wal`
# 文件里还没并回主库的那些事务，直接拷主库是拷不到的；拷得不巧还会拿到一个
# 缺半条事务的快照——它打得开，只是少了最近那几笔，而你要到用它恢复的那天
# 才会发现。`sqlite3 .backup` 走的是 SQLite 自己的联机备份 API，整个过程
# 对写者是安全的，出来的是一个一致的库。
#
# **备份不加密**。这些库里有账号邮箱与账本。它们就躺在服务器的卷里，
# 所以：(a) 别把 /data/backups 往公开的地方同步；(b) 真要往外放，
# 自己在外面那一层加密（rclone crypt / age），不要在这里发明一套。
set -eu

DATA_DIR="${DATA_DIR:-/data}"
OUT_DIR="${OUT_DIR:-$DATA_DIR/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$OUT_DIR"

copied=0
failed=0
for db in cloud.sqlite wallet.sqlite kol-public.sqlite standby.sqlite idempotency.sqlite; do
  src="$DATA_DIR/$db"
  # 没有那个文件是正常的：值守没人开通过就没有 standby.sqlite
  [ -f "$src" ] || continue
  dst="$OUT_DIR/${db%.sqlite}-$STAMP.sqlite"
  if sqlite3 "$src" ".backup '$dst'"; then
    copied=$((copied + 1))
  else
    echo "[backup] $db 备份失败"
    failed=$((failed + 1))
  fi
done

# 过期的删掉。`-mtime +N` 按修改时间算，与文件名里那个时间戳无关——
# 手动拷进来的旧备份也一样会被清，这是有意的（这个目录只归这个脚本管）。
find "$OUT_DIR" -name '*.sqlite' -type f -mtime "+$KEEP_DAYS" -delete 2>/dev/null || true

echo "[backup] $STAMP 完成：$copied 个库，$failed 个失败，保留 $KEEP_DAYS 天"
# 有失败就以非零退出：compose 的循环会把这一行打出来，`docker compose logs backup`
# 看得到。**不 exit 1 会让"备份一直在失败"变成一件没人发现的事。**
[ "$failed" -eq 0 ]
