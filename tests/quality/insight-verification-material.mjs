import { createHash } from 'node:crypto'

// All participants, messages and dates below are synthetic.
function source(id, isSelf, text, day = 8, replyToMessageId = null) {
  return {
    id: String(id), revision: createHash('sha256').update(JSON.stringify([id, isSelf, text, day, replyToMessageId])).digest('hex'),
    senderName: isSelf ? '合成本人' : '合成对方', isSelf, text,
    sentAtMs: Date.UTC(2026, 9, day, 8) + id * 60_000, replyToMessageId,
  }
}

const background = [
  '公园里的银杏开始变黄了，我今天走的是靠河的那条路，回家时没有下雨。',
  '刚看完的纪录片讲海岸鸟类，最后一段是退潮以后沙滩上留下的脚印。',
  '今天用旧杯子喝了热茶，杯底那枚蓝色印章是以前就有的，我刚才又看见了。',
  '这周的展览我已经看完，二楼是黑白照片，一楼是彩色插画，出口在南边。',
  '晚饭吃完了，番茄面有点酸，碗也已经洗好放回柜子，今天没有剩饭。',
  '我今天读到书中第三章，里面描述的是春天的草地，配的插图只有灰色和绿色。',
  '从桥上看到两条小船，一条刷了蓝漆，另一条还是木头原色，它们当时都停着。',
  '窗外的风停了，刚才有一片叶子落在窗台上，现在还在原来的角落。',
  '那张明信片已经收到，画面是傍晚的山，背面邮戳的字有些模糊，但图案完整。',
  '上午听的是钢琴独奏，曲子结尾停了几秒才响起掌声，录音到那里就结束了。',
  '我把桌面擦干净了，水杯和笔都放回原位，灯下那小块划痕仍然能看见。',
  '今天楼下的猫在花坛旁睡觉，它醒来后绕着树走了一圈，又回到原处趴着。',
  '书店橱窗换成了旅行主题，最外面一本书的封面是雪山，旁边放着蓝色地球仪。',
  '刚散步回来，街角的路灯已经亮了，便利店门口的两把椅子还是昨晚的位置。',
]
const distractors = () => background.map((text, index) => source(index + 5, index % 2 === 0, text, 9))
const scope = { kind: 'dates', startDate: '2026-10-08', endDate: '2026-10-10', timezone: 'Asia/Shanghai' }
const excluded = source(99, false, '范围外的合成记录，只能在本地核对，不发送给模型。', 20)

function sample(messages, probeCount = 4) {
  return {
    scope, messages, excluded, inputLimit: 7_000,
    readingPayload: {
      stage: 'reading', timezone: scope.timezone, messages: messages.slice(0, probeCount),
      relatedMessages: [], observations: [], openThreads: [], knownCandidates: [], relatedSourceIds: [],
    },
  }
}

export const insightVerificationCases = {
  'authorization-scope': sample([
    source(1, false, '酒店按我们昨天选好的那家订就行，你帮我下单吧。'),
    source(2, true, '酒店订好了，确认单已经发给你。', 8, '1'),
    source(3, true, '接送也安排好了，我让司机不用来了，我们坐地铁。'),
    source(4, false, '你怎么又替我决定？', 8, '3'),
    ...distractors(),
    source(19, false, '订酒店是我让你办的，我没有怪你订房。我刚才说的是取消司机；我要先去接妹妹，原来跟司机约了绕一段路。', 10, '4'),
    source(20, true, '明白，是我把订房的授权当成其他安排也能一起改了。接送我先不动，等你确认路线。', 10, '19'),
  ]),
  'shared-planning': sample([
    source(1, true, '这周末又是我订场地、买票、通知大家，这几件都弄完了。'),
    source(2, true, '每次都等着我来安排，想到这些就有点累。'),
    source(3, false, '这次几件事情碰在一起，是挺费精力的。', 8, '2'),
    source(4, true, '我现在只想先歇一会，聚会还是照常。', 8, '3'),
    ...distractors(),
    source(19, false, '上个月你出差，是我订场地和通知大家；这个月我们原先说好轮到你，你还记得吗？', 10, '2'),
    source(20, true, '记得，上个月确实都是你张罗的，这个月轮到我也是说好的。刚才说每次都等我安排不准确，我今天只是几件事赶在一起有点累。', 10, '19'),
  ]),
  'clear-agreement': sample([
    source(1, false, '就订我们刚才选好的那家酒店，两晚，你帮我下单吧。'),
    source(2, true, '订好了，是刚才选的酒店和日期，两晚，确认单发给你了。', 8, '1'),
    source(3, false, '我看了确认单，酒店、日期和房型都对，谢谢。', 8, '2'),
    source(4, true, '收到。', 8, '3'),
  ]),
}
