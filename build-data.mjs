// 把抓到的数据整理成前端要的 data.json（在线播放，标记已缓存的片子）
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'D:/A-CODE/deepseek-harness/.tmp-bycsp30'
const APP = path.join(ROOT, 'gj-local')
const cat = JSON.parse(fs.readFileSync(`${ROOT}/catalog.json`, 'utf8'))
const micro = JSON.parse(fs.readFileSync(`${ROOT}/plain/live-micro.json`, 'utf8')).data.micro_video || []
const indexDay = JSON.parse(fs.readFileSync(`${ROOT}/plain/live-index.json`, 'utf8')).data
const officialPath = path.join(APP, 'official.json')
const official = fs.existsSync(officialPath) ? JSON.parse(fs.readFileSync(officialPath, 'utf8')) : {}

const offline = new Set(
  fs.existsSync(path.join(APP, 'media'))
    ? fs.readdirSync(path.join(APP, 'media')).filter(d => fs.existsSync(path.join(APP, 'media', d, 'index.m3u8')))
    : [],
)
const clean = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

const items = cat.map(it => ({
  id: it.id,
  nav: it.nav,
  navPage: it.nav_page,
  title: clean(it.title) || clean(it.desc).slice(0, 60) || '(无标题)',
  author: it.author || '',
  photographer: clean(it.photographer),
  views: it.views ?? 0,
  collects: it.collects ?? 0,
  comments: it.comments ?? 0,
  points: it.points ?? 0,
  vipPoints: it.vip_points ?? 0,
  seconds: official[it.id] || 0,
  cover: it.cover || '',
  playable: true,
  offline: offline.has(String(it.id)),
}))

for (const m of micro) {
  items.push({
    id: m.id,
    nav: '微视频',
    navPage: 'microVideo',
    title: clean(m.micro_video_name) || '(无标题)',
    author: '',
    photographer: '',
    views: m.heat ?? 0,
    collects: 0,
    comments: 0,
    points: 0,
    vipPoints: 0,
    seconds: (() => { const [a, b] = String(m.movie_length || '0:0').split(':').map(Number); return (a || 0) * 60 + (b || 0) })(),
    cover: m.avatar || '',
    playable: true,
    offline: offline.has(String(m.id)),
  })
}

const order = ['首页', '图文', '点播', '写真', '漫画', '听播', '小说', '微视频']
const tabs = order.filter(n => items.some(i => i.nav === n))
const data = {
  brand: '伦酱视频',
  subtitle: '在线片库',
  day: indexDay.day || '',
  tabs,
  counts: tabs.reduce((m, t) => (m[t] = items.filter(i => i.nav === t).length, m), {}),
  playableCount: items.length,
  offlineCount: items.filter(i => i.offline).length,
  items,
}
fs.writeFileSync(path.join(APP, 'data.json'), JSON.stringify(data))
console.log(`data.json: ${items.length} 条全部在线可播；已缓存 ${data.offlineCount} 条；栏目 ${tabs.join('/')}`)
