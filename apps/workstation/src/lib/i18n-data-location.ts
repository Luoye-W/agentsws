/**
 * WP480：设置 → 数据与隐私 →「数据放在哪」（更改位置 / 搬家进度 / 恢复默认位置），
 * 以及同一页「上次备份」的人话时间、数据地图「其他」那一行。
 * 界面少字：一行一句，细节进问号。
 */
export const DATA_LOCATION_ZH: Record<string, string> = {
  'dataloc.title': '数据放在哪',
  'dataloc.desc': '工坊的数据库、附件和备份都在这个文件夹里',
  'dataloc.hint':
    '换位置时工坊会先备份，再把整个文件夹搬过去、逐个文件核对，搬完用新位置重新启动。浏览器设置、浏览器插件和本机加密钥匙不在这里，不跟着搬。',
  'dataloc.size': '{size} · {n} 个文件',
  'dataloc.default_tag': '默认位置',
  'dataloc.change': '更改位置…',
  'dataloc.reveal': '打开文件夹',
  'dataloc.reset': '恢复默认位置',
  'dataloc.old': '旧位置的数据留到 {date}，到时自动删除',
  'dataloc.old.delete': '现在就删',
  'dataloc.old.deleted': '旧位置的数据已删除',

  'dataloc.confirm.title': '把数据搬到这里？',
  'dataloc.confirm.reset_title': '把数据搬回默认位置？',
  'dataloc.confirm.amount': '要搬 {size}（{n} 个文件），{time}。',
  'dataloc.confirm.pause': '搬的时候工坊会暂停，正在做的事搬完自动接着做。',
  'dataloc.confirm.safety': '开搬前先备份一份；旧位置的数据留 7 天再删。',
  'dataloc.confirm.free': '那里还剩 {size}',
  'dataloc.confirm.start': '开始搬',
  'dataloc.confirm.cancel': '取消',
  'dataloc.time.under_minute': '不到 1 分钟',
  'dataloc.time.minutes': '大约 {n} 分钟',
  'dataloc.time.hours': '大约 {n} 小时',

  'dataloc.warn.cloud_sync':
    '这是网盘同步文件夹。同步软件改动数据库文件时可能把数据弄坏，最好换一个不同步的文件夹。',
  'dataloc.warn.network': '这是网络盘（NAS / 共享盘）。断网或 NAS 关机时，工坊打不开。',

  'dataloc.problem.title': '这个文件夹不能用',
  'dataloc.problem.same_place': '数据现在就在这里。',
  'dataloc.problem.inside_current': '它在现在的数据文件夹里面，换一个外面的文件夹。',
  'dataloc.problem.inside_app': '它在工坊自己的程序或设置文件夹里，更新、卸载时会被清掉。',
  'dataloc.problem.system_dir': '这是系统文件夹，放不了。',
  'dataloc.problem.not_found': '打不开这个文件夹。',
  'dataloc.problem.not_writable': '写不进去（没有权限，或是只读的盘）。',
  'dataloc.problem.no_space': '空间不够：要 {need}，那里只剩 {free}。',
  'dataloc.problem.target_has_data':
    '里面已经有一个 agentsws-data 文件夹，而且不是空的。换一个文件夹，或先把它挪走。',
  'dataloc.problem.again': '换一个文件夹',

  'dataloc.step.pause': '正在让手上的事停在安全的地方…',
  'dataloc.step.backup': '正在备份…',
  'dataloc.step.stop': '正在暂停工坊…',
  'dataloc.step.copy': '正在复制 {done} / {total}',
  'dataloc.step.verify': '正在核对 {done} / {total} 个文件',
  'dataloc.step.start': '正在用新位置启动…',
  'dataloc.step.check': '正在检查能不能正常用…',
  'dataloc.step.finish': '快好了…',
  'dataloc.running.note': '搬完之前别关电脑，也别拔盘',

  'dataloc.done': '已搬到 {path}',
  'dataloc.failed': '没搬成：{reason}工坊已回到原来的位置，照常在用。',
  'dataloc.failed.stuck': '没搬成：{reason}原来的位置也没能重新启动，请重开工坊。',
  'dataloc.failed.backup_failed': '搬之前的备份没做成，所以什么都没动。',
  'dataloc.failed.no_space': '新位置的空间不够。',
  'dataloc.failed.not_writable': '新位置写不进去。',
  'dataloc.failed.verify_failed': '复制过去的文件核对不上（盘可能有问题）。',
  'dataloc.failed.copy_failed': '复制的时候出错了（盘可能被拔了或断网了）。',
  'dataloc.failed.start_failed': '用新位置没能启动。',
  'dataloc.failed.busy': '已经在搬了。',
  'dataloc.failed.unknown': '出了点意外。',

  // 同一页的两处屏幕用词
  'storage.ago.today': '今天 {time}',
  'storage.ago.yesterday': '昨天 {time}',
  'storage.ago.days': '{n} 天前',
  'datamap.other': '其他',
  'datamap.other.count': '另外 {n} 类',
  'datamap.actions.other': '另 {n} 项',
}

export const DATA_LOCATION_EN: Record<string, string> = {
  'dataloc.title': 'Where your data lives',
  'dataloc.desc': 'The database, attachments and backups are all in this folder',
  'dataloc.hint':
    'When you change it, Agents Workshop backs up first, moves the whole folder, checks every file, then restarts from the new place. Browser settings, the browser extension and this computer’s encryption key stay where they are.',
  'dataloc.size': '{size} · {n} files',
  'dataloc.default_tag': 'Default',
  'dataloc.change': 'Change location…',
  'dataloc.reveal': 'Open folder',
  'dataloc.reset': 'Restore default location',
  'dataloc.old': 'The old copy is kept until {date}, then deleted',
  'dataloc.old.delete': 'Delete now',
  'dataloc.old.deleted': 'Old copy deleted',

  'dataloc.confirm.title': 'Move your data here?',
  'dataloc.confirm.reset_title': 'Move your data back to the default location?',
  'dataloc.confirm.amount': '{size} ({n} files) to move, {time}.',
  'dataloc.confirm.pause':
    'Agents Workshop pauses while moving; anything in progress picks up afterwards.',
  'dataloc.confirm.safety': 'A backup is made first; the old copy is kept for 7 days.',
  'dataloc.confirm.free': '{size} free there',
  'dataloc.confirm.start': 'Start moving',
  'dataloc.confirm.cancel': 'Cancel',
  'dataloc.time.under_minute': 'under a minute',
  'dataloc.time.minutes': 'about {n} min',
  'dataloc.time.hours': 'about {n} h',

  'dataloc.warn.cloud_sync':
    'This is a cloud-synced folder. Sync apps can corrupt database files while they change — a folder that isn’t synced is safer.',
  'dataloc.warn.network':
    'This is a network drive (NAS / share). Agents Workshop can’t open when the network or NAS is down.',

  'dataloc.problem.title': 'This folder can’t be used',
  'dataloc.problem.same_place': 'Your data is already here.',
  'dataloc.problem.inside_current': 'It is inside the current data folder — pick one outside it.',
  'dataloc.problem.inside_app':
    'It is inside Agents Workshop’s own program or settings folder, which updates and uninstalls clean out.',
  'dataloc.problem.system_dir': 'This is a system folder.',
  'dataloc.problem.not_found': 'This folder can’t be opened.',
  'dataloc.problem.not_writable': 'Can’t write there (no permission, or a read-only drive).',
  'dataloc.problem.no_space': 'Not enough space: needs {need}, only {free} free.',
  'dataloc.problem.target_has_data':
    'It already has a non-empty agentsws-data folder. Pick another folder or move that one away first.',
  'dataloc.problem.again': 'Pick another folder',

  'dataloc.step.pause': 'Letting running work stop at a safe point…',
  'dataloc.step.backup': 'Backing up…',
  'dataloc.step.stop': 'Pausing Agents Workshop…',
  'dataloc.step.copy': 'Copying {done} / {total}',
  'dataloc.step.verify': 'Checking {done} / {total} files',
  'dataloc.step.start': 'Starting from the new location…',
  'dataloc.step.check': 'Making sure everything works…',
  'dataloc.step.finish': 'Almost done…',
  'dataloc.running.note': 'Don’t shut down or unplug the drive until it finishes',

  'dataloc.done': 'Moved to {path}',
  'dataloc.failed': 'Not moved: {reason} Agents Workshop is back on the old location and working.',
  'dataloc.failed.stuck':
    'Not moved: {reason} The old location didn’t start again either — please reopen Agents Workshop.',
  'dataloc.failed.backup_failed': 'The backup before moving failed, so nothing was touched.',
  'dataloc.failed.no_space': 'Not enough space at the new location.',
  'dataloc.failed.not_writable': 'Can’t write to the new location.',
  'dataloc.failed.verify_failed': 'Copied files didn’t match (the drive may have a problem).',
  'dataloc.failed.copy_failed':
    'Copying failed (the drive may have been unplugged or the network dropped).',
  'dataloc.failed.start_failed': 'Couldn’t start from the new location.',
  'dataloc.failed.busy': 'A move is already running.',
  'dataloc.failed.unknown': 'Something unexpected happened.',

  'storage.ago.today': 'Today {time}',
  'storage.ago.yesterday': 'Yesterday {time}',
  'storage.ago.days': '{n} days ago',
  'datamap.other': 'Other',
  'datamap.other.count': '{n} more kinds',
  'datamap.actions.other': '{n} more',
}
