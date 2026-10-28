import type { Conversation } from '../components/conversations'
import type { OverviewData, SparkDiscovery } from '../components/overview/types'

export interface OverviewScenario {
  id: string
  label: string
  description: string
  conversations: readonly Conversation[]
  overview: OverviewData
}

export const exampleConversations: readonly Conversation[] = [
  { id: 'example-project', title: '项目讨论 · 虚构示例', messages: [
    { id: '1', sender: '小林', text: '你发的页面我打开了。这次先做到能选文件、看聊天记录，对吧？', time: '10:24' },
    { id: '2', sender: '我', text: '对，先把这段走通。我刚拿昨天那份记录试了一遍。', time: '10:25', isSelf: true },
    { id: '3', sender: '小林', text: '等下，我把左边列表收起来了，刚刚看到哪儿了……还在这一段吗？', time: '10:26' },
    { id: '4', sender: '我', text: '还在，你往下看就行。\n我刚也收了一次，位置没动。', time: '10:27', isSelf: true },
    { id: 'extra-0', sender: '小林', text: '找到了。我刚以为又回到开头了。这个名字特别长的会话，你点开过吗？', time: '10:28' },
    { id: 'extra-1', sender: '我', text: '点过，列表里放不下，打开以后能看到全名。你那边是不是窗口开得很窄？', time: '10:28', isSelf: true },
    { id: 'extra-2', sender: '小林', text: '嗯，我旁边还放着文档。拉宽一点就看到了。', time: '10:29' },
    { id: 'extra-3', sender: '我', text: '那先别拉宽，帮我看看这一段长消息会不会挤出去。我这边只有大屏。', time: '10:30', isSelf: true },
    { id: 'extra-4', sender: '小林', text: '没挤出去，就是得多往下滑。原来消息里的换行也还在。', time: '10:31' },
    { id: 'extra-5', sender: '我', text: '好。我昨天整理记录时还担心，几段话会不会糊成一整块。', time: '10:31', isSelf: true },
    { id: 'extra-6', sender: '小林', text: '那我能直接在这里改个错字吗？有一条把周四写成周五了。', time: '10:32' },
    { id: 'extra-7', sender: '我', text: '这里只能看。你要改的话，得回原来的记录里改。', time: '10:33', isSelf: true },
    { id: 'extra-8', sender: '小林', text: '行，我先记下来。还有一段是空的，我点进去只有一句没有记录，正常吧？', time: '10:34' },
    { id: 'extra-9', sender: '我', text: '正常，那段本来就没消息。你现在切回刚才那段试试？', time: '10:34', isSelf: true },
    { id: 'extra-10', sender: '小林', text: '回来了，能看。我先去拿外卖，下午再用手机打开一次。', time: '10:35' },
    { id: 'extra-11', sender: '我', text: '好，我也吃饭去了。下午你要是看到哪儿不对，截给我。', time: '10:36', isSelf: true },
  ] },
  { id: 'example-long', title: '午休时没聊完的页面试用：选错文件、找到上次那段记录，还有窗口缩小后的阅读 · 虚构示例', messages: [
    { id: 'long', sender: '小周（帮忙整理访谈记录的同学）', text: '我把上午没说完的发你，刚才在食堂排队，打两句就被叫走了。\n\n我第一次选错文件了，选成了上周那份。打开才发现少了昨天的聊天，又回去重新选。第二次倒是很顺，一眼就找到下午讨论页面的那段。文件名实在太像，我准备自己改一下，不然明天还得选错。\n\n长消息我也看了，就是你说放在后面那条。我把窗口缩到半边，旁边开着文档，字能看全，也不用左右拖。只是读到中间忘了前面说什么，又往上翻了一次。这可能是我吃完饭有点困，下午我再看一遍。\n\n还有个小误会。我以为左边那个箭头是返回，就点了，结果会话列表收起来了。我愣了一下，看到正文还在，才知道它只是把列表藏起来。再点一次就找回来了，倒也没耽误。\n\n空的那段我也点了，确实没有消息。我本来想截图给你，后来看到那句提示就明白了。你放这段是想留着看空记录的样子吧？\n\n先这些。对了，上午我说第三条消息换行不对，刚又看了一眼，是原来的记录就在那里换行，我看错了。那个不用改。下午要是我又把哪儿看岔了，你直接问我具体点了什么，别照我第一句话就动手。', time: '12:46' },
    { id: 'long-reply', sender: '我', text: '收到了。空记录那段是特意留的。你说的箭头我下午也找个人试试，看他会怎么点。', time: '12:51', isSelf: true },
    { id: 'long-followup', sender: '小周（帮忙整理访谈记录的同学）', text: '好。我先眯一会儿，下午还看不明白再找你。', time: '12:52' },
  ] },
  { id: 'example-empty', title: '空记录 · 虚构示例', messages: [] },
]

const friendConversations: readonly Conversation[] = [
  { id: 'example-defense-plan', title: '和小林商量答辩准备 · 虚构示例', messages: [
    { id: 'plan-1', sender: '小林', text: '下周四就答辩了，我最近有点慌。周六那顿饭可能去不了了。', time: '周二 20:10' },
    { id: 'plan-2', sender: '我', text: '饭改天吃。你还在实验室？', time: '周二 20:12', isSelf: true },
    { id: 'plan-3', sender: '小林', text: '嗯，外卖都凉了。刚试着讲了一遍，第三张图那儿总卡。我一急又想把图全重画。', time: '周二 20:13' },
    { id: 'plan-4', sender: '我', text: '先吃两口吧。我记得你上次说第二张也不好讲，是那两张吗？', time: '周二 20:15', isSelf: true },
    { id: 'plan-5', sender: '小林', text: '对，二三两张。结果没变，就是不知道怎么接。你明晚能听我讲一下吗？不用帮我改图，听着哪儿不明白就问。', time: '周二 20:17' },
    { id: 'plan-6', sender: '我', text: '能，九点？我八点半才到家，得先找一下耳机。', time: '周二 20:18', isSelf: true },
    { id: 'plan-7', sender: '小林', text: '九点行。我今天就动那两张，其他的先不碰。', time: '周二 20:20' },
    { id: 'plan-8', sender: '我', text: '好，周六我先不订位了。我一听你说卡住就想出主意，有时候都没等你讲完。刚才我还想翻你上周发的图，找了半天，才发现那是旧版。其实你现在就是想找个人听一遍，对吧？我怕一开口又变成一起改图，最后你还得陪我解释。', time: '周二 20:21', isSelf: true },
    { id: 'plan-9', sender: '小林', text: '对，我等会儿发你新版，别看上周那个。哪里没听明白就问，先别改。', time: '周二 20:22' },
    { id: 'plan-10', sender: '我', text: '收到，那我明晚听你讲。你先吃饭吧。', time: '周二 20:23', isSelf: true },
  ] },
  { id: 'example-defense-followup', title: '几天后跟进答辩练习 · 虚构示例', messages: [
    { id: 'followup-1', sender: '我', text: '你那两张后来讲顺了吗？我刚从食堂出来，想起周三你卡的那个地方。', time: '周五 18:05', isSelf: true },
    { id: 'followup-2', sender: '小林', text: '顺了点。昨天老师又让我补一个结果，我正想要不要把整套顺序都换了。', time: '周五 18:08' },
    { id: 'followup-3', sender: '我', text: '啊，又加。你给我看一眼？是放在结论前面那张吗？', time: '周五 18:10', isSelf: true },
    { id: 'followup-4', sender: '小林', text: '对。我试了下，直接插进去也能讲。我今晚真不想再练了，昨天两点才睡。', time: '周五 18:12' },
    { id: 'followup-5', sender: '我', text: '那今晚算了。我明天下午有空，不过四点得出门接我妹。', time: '周五 18:13', isSelf: true },
    { id: 'followup-6', sender: '小林', text: '三点？半小时就行。我先把新那页塞进去，明天听听接得别不别扭。', time: '周五 18:15' },
    { id: 'followup-7', sender: '我', text: '好，三点。还是上次那个通话？', time: '周五 18:16', isSelf: true },
    { id: 'followup-8', sender: '小林', text: '嗯。我先回宿舍了，明天找你。', time: '周五 18:17' },
  ] },
]

const conversations = [...friendConversations, ...exampleConversations]

const partialPreferences: OverviewData['preferences'] = {
  energy: { status: 'known', leaning: 'left', strength: 'slight', context: '在这些交流中，主动发起讨论并跟进。' },
  information: { status: 'unknown', reason: '材料不足以区分具体经验与整体可能性。' },
  decisions: { status: 'known', leaning: 'right', strength: 'slight', context: '朋友说想先休息时，接受了改天再练习。' },
  approach: { status: 'unknown', reason: '这些场景还不足以判断整体安排偏好。' },
}

const spark: SparkDiscovery = {
  id: 'example-spark-accompany',
  title: '你可能会在事后再问一句，继续留意朋友的近况',
  observation: '在这两段虚构交流里，你提到自己容易急着出主意，但实际的来回没有一直停在改图上。朋友说想找个人听，你答应了；几天后，你又问起上次卡住的地方。朋友说累了，你们就把练习挪到第二天。',
  selfDescription: '我一听你说卡住就想出主意，有时候都没等你讲完。',
  scenes: [
    {
      title: '答辩前一周：朋友想先找个人听一遍',
      context: '朋友准备下周四的答辩，提出推迟周六聚餐。当晚他还在实验室，外卖已经放凉，试讲卡在图表那里，一着急想把图全重画。',
      interaction: '你先说饭可以改天吃，再问他是否还在实验室。你们确认卡住的是第二、三张图后，朋友提出请你听一次，说明先别帮他改。你提起自己急着出主意、还翻到了旧版图的事，又问了一次他需要什么。',
      behavior: '你答应第二天九点听朋友试讲，也接受了先听、没听明白再问的方式。朋友仍由自己决定改哪两张图，你把聚餐订位暂时放下。',
      sourceIds: ['example-source-plan'],
    },
    {
      title: '几天后：问起上次卡住的地方',
      context: '周三练习过后，老师又让朋友补一个结果。朋友考虑换掉整套顺序，但试过直接插入新内容也能讲；他前一晚两点才睡，当晚不想继续练。',
      interaction: '你吃完饭想起上次的练习，主动问那两张图是否讲顺。朋友说了新情况，你追问是哪张图；听到他想休息，你说今晚算了，也说明自己第二天下午四点要出门。',
      behavior: '你们在双方有空的时间里约了三点、半小时的通话。这次回应包含了对上次练习的跟进，也接受了朋友当晚不想练的决定。',
      sourceIds: ['example-source-followup'],
    },
  ],
  qualification: '这里只能看到你对这次答辩的回应。后续询问也可能只是记得上次没讲顺的两张图，不能据此判断你在其他关系中的习惯，或把约时间等同于稳定的人格倾向。你可以结合自己的经历补充或纠正。',
  sources: [
    { id: 'example-source-plan', conversationId: 'example-defense-plan', messageId: 'plan-1', endMessageId: 'plan-10', title: '商量答辩准备与练习安排', context: '从朋友提出推迟聚餐，到说明想找人听一遍、纠正旧版图并约好通话的整段交流。' },
    { id: 'example-source-followup', conversationId: 'example-defense-followup', messageId: 'followup-1', endMessageId: 'followup-8', title: '几天后跟进练习与休息安排', context: '从问起上次卡住的两张图，到朋友说想休息、双方另约通话的整段交流。' },
  ],
}

const longSpark: SparkDiscovery = {
  ...spark,
  id: 'example-spark-long',
  title: '你觉得自己容易急着出主意，但在这两次答辩交流里，也会听朋友说完想要的帮助，过几天再问起上次没讲顺的地方',
  observation: `${spark.observation}\n\n这两次交流也有不顺畅的地方：你想翻之前的图，却拿到了旧版；朋友需要的是听众，又提醒了一次先别改。后来约时间时，你也有四点要出门的安排。这里呈现的是双方一边解释、一边纠正、再找到能做的事情的过程，不是每次都刚好知道对方需要什么。`,
  selfDescription: '我一听你说卡住就想出主意，有时候都没等你讲完。刚才我还想翻你上周发的图，找了半天，才发现那是旧版。其实你现在就是想找个人听一遍，对吧？我怕一开口又变成一起改图，最后你还得陪我解释。',
  qualification: `${spark.qualification}\n\n同一段记录也可能有不同读法。朋友明确提出了想要的帮助，因此仅凭你答应听一次，还不能推断你平常是否善于察觉别人的需要。判断这条观察是否贴近你，可以回看朋友开口前后，你问了什么、答应了什么，以及后来有没有再联系。`,
}

export const overviewScenarios: readonly OverviewScenario[] = [
  {
    id: 'spark', label: '完整 Spark · 两段朋友交流',
    description: '核对场景摘要、整段来源与反馈状态。',
    conversations, overview: { materialStatus: 'partial', preferences: partialPreferences, discoveries: [spark] },
  },
  {
    id: 'partial', label: '部分未知 · E?F?',
    description: '已知两组倾向，其余两组保持未知。',
    conversations, overview: { materialStatus: 'partial', preferences: partialPreferences, discoveries: [] },
  },
  {
    id: 'unknown', label: '全部未知 · ????',
    description: '已有示例材料，四组依据仍不足。',
    conversations, overview: { materialStatus: 'partial', preferences: {
      energy: { status: 'unknown', reason: '还需要更多不同场景的交流。' },
      information: { status: 'unknown' }, decisions: { status: 'unknown' }, approach: { status: 'unknown' },
    }, discoveries: [] },
  },
  {
    id: 'balanced', label: '均衡与未知 · 分别展示',
    description: '有依据的均衡与材料不足的未知采用不同呈现。',
    conversations, overview: { materialStatus: 'partial', preferences: {
      energy: { status: 'known', leaning: 'balanced', context: '在示例设定中，主动交流和独处恢复都稳定出现。' },
      information: { status: 'unknown', reason: '还没有足以比较两侧偏好的示例。' },
      decisions: { status: 'known', leaning: 'right', strength: 'slight', context: '示例设定略偏向先考虑人的感受。' },
      approach: { status: 'known', leaning: 'balanced', context: '在示例设定中，事先安排和灵活调整都稳定出现。' },
    }, discoveries: [] },
  },
  {
    id: 'no-spark', label: '有类型结果 · 暂无 Spark',
    description: '四组展示定性倾向，Spark 保持空状态。',
    conversations, overview: { materialStatus: 'ready', preferences: {
      energy: { status: 'known', leaning: 'left', strength: 'slight' },
      information: { status: 'known', leaning: 'right', strength: 'slight' },
      decisions: { status: 'known', leaning: 'right', strength: 'clear' },
      approach: { status: 'known', leaning: 'left', strength: 'slight' },
    }, discoveries: [] },
  },
  {
    id: 'unavailable-source', label: '来源失效 · 一段记录缺失',
    description: '第一段来源可读，第二段来源对应的会话未提供。',
    conversations: [...friendConversations.slice(0, 1), ...exampleConversations],
    overview: { materialStatus: 'partial', preferences: partialPreferences, discoveries: [{ ...spark, id: 'example-spark-unavailable' }] },
  },
  {
    id: 'unanalysed', label: '已有材料 · 尚未分析',
    description: '可以阅读示例会话，总览还没有分析结果。',
    conversations, overview: { materialStatus: 'unanalysed', discoveries: [] },
  },
  {
    id: 'none', label: '没有材料',
    description: '查看无会话、无结果时的导入入口。',
    conversations: [], overview: { materialStatus: 'none', discoveries: [] },
  },
  {
    id: 'long-text', label: '长文本 · 窄屏与阅读检查',
    description: '长标题、自述、场景和限定说明均为虚构示例。',
    conversations, overview: { materialStatus: 'partial', preferences: partialPreferences, discoveries: [longSpark] },
  },
]
