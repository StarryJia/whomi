// 仅供本地小样对照。每行依次为关系、事件、说话人、聊天文本、独立标注的自主倾向。
import assert from 'node:assert/strict'

const rows = [
  ['朋友','搬家','我','我想提前安排搬家日程。','J'],
  ['朋友','试讲','我','我想先列好试讲提纲。','J'],
  ['朋友','旅行','我','我想提前安排去车站的路线。','J'],
  ['朋友','聚餐','我','我想先定好聚餐时间。','J'],
  ['朋友','采购','我','我想先列好采购清单。','J'],
  ['朋友','散步','我','我想临时决定去哪走走。','P'],
  ['朋友','搬家','我','我想先定好那次搬家的货车时间。','J'],
  ['朋友','填表','我','老师要求先排，我照填。',null],
  ['朋友','阅读','朋友','我想独处一会儿恢复精力。','I'],
  ['朋友','下课','朋友','我想独处一会儿再碰面。','I'],
  ['同事','午餐','我','我想临时决定吃什么。','P'],
  ['同事','选题','我','我想留点弹性，下次再定。','P'],
  ['同事','改稿','同事','我想先比较逻辑是否一致。','T'],
  ['同事','选址','同事','我想先比较逻辑依据。','T'],
  ['朋友','结算','我','我想对照具体数字再结算。','S'],
  ['同事','复盘','我','我想对照具体数字再复盘。','S'],
  ['同事','转述','我','她说「我想先定好时间」，我转告你。',null],
  ['同事','地址','我','地址是河边路六号。',null],
  ['朋友','排班','朋友','公司要求先定好时间，我照办。',null],
  ['同事','安排','同事','按组长要求提前安排。',null],
]
const axes = ['EI','SN','TF','JP']
const cues = { I:/独处/, S:/对照具体数字/, T:/比较逻辑/, J:/提前安排|先列好|先定好/, P:/临时决定|留点弹性/ }
function extract(text) {
  if (!text.startsWith('我想')) return null
  return Object.entries(cues).find(([,pattern]) => pattern.test(text))?.[0] ?? null
}
function observe(chunkSize, swapped, copies) {
  const seen = new Set(), facts = []
  let wrongOwner = 0, forced = 0
  const input = Array.from({ length: copies }, () => rows).flat()
  for (let start = 0; start < input.length; start += chunkSize) {
    for (const [relationship,event,speaker,text,label] of input.slice(start, start + chunkSize)) {
      const owner = swapped ? relationship : '我'
      if (speaker !== owner) continue
      const letter = extract(text)
      if (letter && !label) forced++
      if (!letter) continue
      const axis = axes.find(pair => pair.includes(letter))
      const key = JSON.stringify([relationship,event,axis])
      if (!seen.has(key)) {
        seen.add(key)
        facts.push({ relationship,event,letter,speaker })
      }
    }
  }
  // 与标注逐事件比较，检出误收对方、漏收本人和错误方向。
  const expected = new Set(rows.filter(([r,,s,,label]) => label && s === (swapped ? r : '我'))
    .map(([r,e,,,label]) => JSON.stringify([r,e,label])))
  for (const f of facts) {
    if (!rows.some(([r,e,s,,label]) => r === f.relationship && e === f.event && s === (swapped ? r : '我') && label === f.letter)) wrongOwner++
  }
  assert.equal(forced, 0)
  assert.equal(wrongOwner, 0)
  assert.deepEqual(new Set(facts.map(f => JSON.stringify([f.relationship,f.event,f.letter]))), expected)
  return { facts,wrongOwner,forced }
}
function assess(facts, minimum) {
  const relationships = ['朋友','同事'].map(relationship => Object.fromEntries(axes.map(axis => {
    const observations = facts.filter(f => f.relationship === relationship && axis.includes(f.letter))
    const n = observations.length
    const winner = n < minimum ? null : [...axis].find(letter => observations.filter(f => f.letter === letter).length * 3 >= n * 2) ?? null
    return [axis,{n,winner}]
  })))
  const known = axes.map(axis => relationships.filter(r => r[axis].winner).length)
  const jp = relationships.map(r => r.JP).filter(v => v.winner)
  function vote(weighted) {
    if (jp.length < 2) return '材料不足'
    const weight = item => weighted ? item.n : 1
    const j = jp.filter(item => item.winner === 'J').reduce((sum,item) => sum + weight(item),0)
    const all = jp.reduce((sum,item) => sum + weight(item),0)
    return j === all - j ? '均票' : j * 3 >= all * 2 ? 'J' : (all-j) * 3 >= all*2 ? 'P' : '未达同向比例'
  }
  return {minimum,known,relationships,equal:vote(false),byEvents:vote(true)}
}
for (const swapped of [false,true]) {
  const base = observe(rows.length,swapped,1)
  for (const chunk of [3,7,11]) for (const copies of [1,2]) assert.deepEqual(observe(chunk,swapped,copies),base)
  console.log(JSON.stringify({ identity:swapped ? '交换本人' : '原本人', unique:base.facts.length, wrongOwner:base.wrongOwner, forced:base.forced,
    results:[2,3].map(min => assess(base.facts,min)) }))
}
