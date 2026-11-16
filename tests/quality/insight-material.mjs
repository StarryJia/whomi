import { createHash } from 'node:crypto'

function message(id, isSelf, text, day, replyToMessageId = null) {
  return {
    id: String(id), revision: createHash('sha256').update(JSON.stringify([id, isSelf, text, day, replyToMessageId])).digest('hex'),
    senderName: isSelf ? '合成本人' : '合成对方', isSelf, text,
    sentAtMs: Date.UTC(2026, 9, day, 8) + id * 60_000,
    replyToMessageId,
  }
}

const laterCounterexample = [
  message(1, true, '你讲到一半时，我直接给了三个解决办法。', 5),
  message(2, false, '我想先把事情说完，今天先不要建议。', 5, '1'),
  message(3, true, '好，我先听。你想从最难开口的那段说起吗？', 5, '2'),
  message(4, false, '谢谢你后来让我把那段讲完，我舒服多了。', 5, '3'),
  message(5, false, '这一次不一样。我想听你的建议，你能给我两个选择吗？', 7),
  message(6, true, '可以。我先说两个方案，你看看哪个符合你今天想要的。', 7, '5'),
  message(7, false, '第二个更适合我。这次我确实需要你帮我想办法。', 7, '6'),
]

const incidentalChats = [
  '我把花盆从西窗移到了东窗，早上光线比较柔和。',
  '纸箱记得先拆开压平，回收车每周三过来一次。',
  '书架上第二格有一本地图册，书角夹着旧的公交车票。',
  '中午吃的是番茄面，后来加了点香菜，没有额外加辣。',
  '雨衣已经晾在门口，晚上回来再把鞋底的泥冲掉。',
  '借出的相机装在灰色外套里，用之前可以擦一下镜头。',
  '新买的尺子有两面刻度，画纸边角还需要再留两厘米。',
  '我试了蓝色袋和白色袋，明天送去回收的是白色袋。',
  '照片里窗前是一只橘猫，它等到天全黑才从台阶离开。',
  '邻居的菜今天刚从地里收上来，我冰箱里还有剩下两把。',
  '上个月拍的胶片有一卷没洗，下次经过街角照相馆再拿去。',
  '旧笔袋上写的号码是展台编号，和座位号是两回事。',
  '灯泡已经换好，走廊的感应灯还是会再延迟几秒。',
  '今天打包了两套桌游，外面那套配件少了一颗木制棋子。',
  '窗边的收音机上午有杂音，调整天线之后稍微好了一点。',
  '明早有一小时停水，出门前可以先把水壶灌满。',
  '手套洗好后要挂在阳台，口袋里的收据已经放到桌上。',
  '汽车站旁边开了一家面包店，今天我只买了小餐包。',
  '我把卡片上的墨水等干再收起来，信封都放在台灯旁边。',
  '昨晚路上看见一块旧招牌，广告字掉了一半但灯还亮着。',
  '面粉剩半袋，周末如果烤饼干我会再去买一包。',
  '猫把水碗挪到了垫子角落，你看到就帮我放到墙边。',
  '包裹不是急件，到取件柜的时候可以顺手带上。',
  '小馆周二不开门，原计划那天吃饭要再确认时间。',
]
const distantReply = [
  message(1, true, '医院原定周一做眼科复查。我只能周五陪你去，先问医院有没有周五的号。', 5),
  message(2, false, '我先留着周一的眼科号，还没有改约。另一件事是周一下午去修自行车。', 5, '1'),
  ...incidentalChats.map((text, index) => message(index + 3, index % 2 === 0, text, 6 + Math.floor(index / 9))),
  message(27, false, '回到你问的眼科复查：医院通知周一眼科号取消，没有另约周五。周一修车照旧。', 9, '1'),
  message(28, true, '知道了，眼科复查还没有新时间，别把修车的预约一起取消。', 9, '27'),
]

const excluded = message(99, false, '合成范围外标记，只能留在本地核对。', 20)
const scope = { kind: 'dates', startDate: '2026-10-05', endDate: '2026-10-09', timezone: 'Asia/Shanghai' }
export const insightQualityCases = {
  'later-counterexample': { scope, messages: laterCounterexample, excluded },
  'distant-reply': { scope, messages: distantReply, excluded },
}
