export const platformGuides = [
  {
    id: 'wechat', name: '微信', format: '会话文件（.json）',
    steps: [
      ['打开微信导出工具', '在存有聊天记录的电脑上打开 SIWX（Stories in WeChat），选择自己的微信账号，按工具提示读取记录。'],
      ['导出想保留的聊天', '在「聊天查看」找到好友或群聊，进入「导出」，勾选消息内容，格式选 JSON（结构化数据文件）。'],
      ['选择会话文件', '解压后找到对应会话的 .json 文件，返回导入页选择它。同目录的 manifest.json 是导出清单。'],
    ],
  },
  {
    id: 'qq', name: 'QQ', format: '会话文件（.json）或旧版聊天文本（.txt）',
    steps: [
      ['选中好友或群聊', '在 Windows 上打开 QQ Chat Exporter，登录自己的 QQ，在工具的「会话」里选中要保存的聊天。'],
      ['创建导出任务', '选择日期范围，格式选 JSON（结构化数据文件）。创建任务，再到「任务」里下载结果。'],
      ['打开聊天文件', '如有压缩包，先解压。返回导入页选择会话的 .json 文件。已有旧版 QQ 消息管理器导出的 .txt 文件也可以直接选。'],
    ],
  },
  {
    id: 'telegram', name: 'Telegram', format: '会话文件（.json）',
    steps: [
      ['打开要导出的会话', '在 Telegram 桌面版进入目标聊天，点右上角的「⋮」，选择「Export chat history」（导出聊天记录）。'],
      ['把保存格式设为 JSON', '在格式选项中选择「Machine-readable JSON」（机器可读的数据文件），选好保存位置后开始导出。'],
      ['回到 Whomi 导入', '打开导出目录，把聊天的 .json 文件拖到「选择文件」区域。如果只看到网页文件，请重新导出并选择 JSON。'],
    ],
  },
  {
    id: 'whatsapp', name: 'WhatsApp', format: '聊天文本（.txt）',
    steps: [
      ['在手机上打开聊天', '安卓手机点右上角「⋮」→「更多」→「导出聊天」。在 iPhone 上，点顶部的联系人或群名称，再选「导出聊天」。'],
      ['保存聊天文本', '选择「不附加媒体」，用手机的分享菜单保存文件，再传到装有 Whomi 的电脑。'],
      ['打开文本文件', '收到 .zip 压缩包时先解压。返回导入页，选择其中的 .txt 聊天文件。'],
    ],
  },
  {
    id: 'discord', name: 'Discord', format: '频道记录（.json）',
    steps: [
      ['选择目标频道', '打开 DiscordChatExporter，按提示连接自己的账号，在频道列表中选中要保存的聊天。'],
      ['导出频道记录', '在导出选项中将格式设为 JSON（结构化数据文件），选择保存位置并导出。'],
      ['在 Whomi 打开', '返回导入页点「选择文件」，打开刚保存的频道 .json 文件。'],
    ],
  },
  {
    id: 'googlechat', name: 'Google Chat', format: 'Google Chat 文件夹',
    steps: [
      ['选择要导出的产品', '用聊天所在的账号打开 Google Takeout（数据导出工具），取消预选的产品，只勾选 Google Chat。'],
      ['完整解压下载包', '创建导出，下载后解压。保留 Google Chat 目录下的 Groups 和 Users 两个子目录。'],
      ['按文件夹导入', '返回导入页点「选择文件夹」，选择包含这两个子目录的 Google Chat 文件夹。按提示选择想导入的记录。'],
    ],
  },
  {
    id: 'instagram', name: 'Instagram', format: '私信消息文件（.json）',
    steps: [
      ['在账户中心创建导出', '进入「你的信息和权限」，选择有这些私信的 Instagram 账号，将信息导出到设备。'],
      ['选择消息和格式', '范围选择「消息」或「私信」，设好日期，格式选 JSON（结构化数据文件）。下载完成后解压。'],
      ['选择目标聊天的文件', '在私信目录里找到这段聊天的 message_1.json。返回导入页选择它。同一聊天分成多个消息文件时可以多选。'],
    ],
  },
  {
    id: 'line', name: 'LINE', format: '聊天文本（.txt）',
    steps: [
      ['打开聊天菜单', '在手机上进入一段 LINE 聊天，打开菜单，在「设置」里选择「导出聊天记录」。'],
      ['保存聊天文本', '用手机的分享菜单保存 .txt 文件，再传到电脑。电脑版也可从聊天菜单选择「Save chat」（保存聊天）。'],
      ['拖入 Whomi', '返回导入页，把 .txt 文件拖到「选择文件」区域。电脑版导出的文本只包含当时已加载的消息。'],
    ],
  },
] as const

export type GuidePlatform = typeof platformGuides[number]['id']
