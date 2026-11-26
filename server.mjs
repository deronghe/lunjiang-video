// 果酱视频 · 在线片库（无第三方依赖）
// 用法: node server.mjs [端口]
//
// 视频不落盘：/live/<id>.m3u8 现签现取官方播放列表，key 与分片改写成同源代理。
// 排行/女优：服务端自动开匿名号拿 token，代调官方接口。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.argv[2] || 8899)

// ---- 官方参数（逆向所得）----
// 接口域名池（官方下发三台），任意一台抖动自动切换
const HOSTS = [
  'https://qzflu-jk.5ea5ec0.com',
  'https://qzflu-jk.642d142.com',
  'https://qzflu-jk.608cfd2.com',
]
let hostIdx = 0
const API = () => HOSTS[hostIdx]

const OLDSALT = '3DgmP_KY>%=GnAHAYBey'
const KEY = Buffer.from('xPxo2S5uGPhKHx5g', 'utf8')
const IV = Buffer.from('0a1b2c3d4e5f6789', 'utf8')
const KMIX = '4f8d8b72df85ff2b'
const IMG_CDN = 'https://gjwspic-aoqlyzpk2.xzktd.com'
const MV_CDN = 'https://gjwspwaarbykct07.hzzhxcy.com'
const IMG_KEY = Buffer.from('saIZXc4yMvq0Iz56', 'utf8')
const IMG_IV = Buffer.from('kbJYtBJUECT0oyjo', 'utf8')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'

// 上游请求：超时 + 域名池轮换重试（网络错误/超时才换机）
async function apiFetch(path, { headers = {}, method = 'GET', body, timeout = 7000, tries = HOSTS.length } = {}) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    const host = HOSTS[(hostIdx + i) % HOSTS.length]
    try {
      const res = await fetch(host + path, {
        method,
        body,
        headers: { origin: 'https://bycsp30.com', referer: 'https://bycsp30.com/', 'user-agent': UA, ...headers },
        signal: AbortSignal.timeout(timeout),
      })
      if (res.status >= 500 && i < tries - 1) { lastErr = new Error(`upstream ${res.status}`); continue }
      if (i > 0) console.log(`[api] 切到 ${host} 成功`)
      hostIdx = (hostIdx + i) % HOSTS.length
      return res
    } catch (err) {
      lastErr = err
      console.log(`[api] ${host} 失败: ${err.cause?.code || err.name} ${String(err.message).slice(0, 50)}`)
    }
  }
  throw lastErr || new Error('all hosts failed')
}

// 只读接口缓存：内存 + 磁盘双份。
// 规则：成功结果才写缓存；失败/空结果一律不覆盖；上游挂了就用磁盘里的旧数据顶（哪怕几小时前），保证页面永远有内容。
const mem = new Map()
const APICACHE = path.join(__dirname, '.cache', 'api')
fs.mkdirSync(APICACHE, { recursive: true })
const diskPath = key => path.join(APICACHE, crypto.createHash('sha1').update(key).digest('hex') + '.json')

function readDisk(key) {
  try {
    const f = diskPath(key)
    if (!fs.existsSync(f)) return null
    const o = JSON.parse(fs.readFileSync(f, 'utf8'))
    return o && o.val !== undefined ? o : null
  } catch { return null }
}
function writeDisk(key, val) {
  try { fs.writeFileSync(diskPath(key), JSON.stringify({ at: Date.now(), val })) } catch {}
}

const inflight = new Map()   // 同一 key 的并发请求合并，避免 3 个 host 各等一遍

async function cached(key, ttl, producer, valid = () => true) {
  const hot = mem.get(key)
  if (hot && Date.now() - hot.at < ttl) return hot.val

  const refresh = () => {
    if (inflight.has(key)) return inflight.get(key)
    const p = Promise.resolve()
      .then(producer)
      .then(val => {
        if (valid(val)) { mem.set(key, { at: Date.now(), val }); writeDisk(key, val) }
        return val
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
  }

  const cold = hot || readDisk(key)
  if (cold) {
    refresh().catch(() => {})      // 后台静默刷新，不阻塞
    return cold.val
  }

  const val = await refresh()
  if (!valid(val)) console.log('[cache] ' + key + ' 首次即失败且无旧数据')
  return val
}

// 启动预热：把常用只读接口先抓一遍落盘，之后即使上游抖动也能立刻出内容
async function warmup() {
  const jobs = [
    ['topics:1', () => apiCall('/api/monographic/list/1', { page: '1', page_size: '20' })],
    ['rank-tags', () => apiCall('/api/ranking/tags_menu')],
    // 四个时段的总榜都预热，避免首次点「昨日/今日」时赶上上游抖动显示空
    ['rank:0:0:1', () => apiCall('/api/ranking/movie_history', { page: '1', page_size: '30', tag_id: '0', days: '0' })],
    ['rank:1:0:1', () => apiCall('/api/ranking/movie_history', { page: '1', page_size: '30', tag_id: '0', days: '1' })],
    ['rank:7:0:1', () => apiCall('/api/ranking/movie_history', { page: '1', page_size: '30', tag_id: '0', days: '7' })],
    ['rank:30:0:1', () => apiCall('/api/ranking/movie_history', { page: '1', page_size: '30', tag_id: '0', days: '30' })],
    ['channels', async () => (await apiCall('/api/tags/channels')).data?.fixTags || []],
  ]
  for (const [key, fn] of jobs) {
    try { await cached(key, 0, fn, v => v && (Array.isArray(v) || v.code === 200)) } catch (e) { console.log('[warmup] ' + key + ' 失败: ' + (e.cause?.code || e.message)) }
  }
  console.log('[warmup] 完成')
}

const CACHE = path.join(__dirname, '.cache')
fs.mkdirSync(CACHE, { recursive: true })

const MIME = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.jpg': 'image/jpeg',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t',
  '.webmanifest': 'application/manifest+json', '.js': 'application/javascript; charset=utf-8',
}

const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex')
const esc = v => String(v).split("'").join("\\'").split('/').join('\\/').split('\n').join('\\n')
  .split('\b').join('\\b').split('\f').join('\\f').split('\r').join('\\r').split('\t').join('\\t').split('\\').join('\\\\')
const ser = o => '{' + Object.keys(o).sort().map(k => `"${k}":"${esc(o[k])}"`).join(',') + '}'
const aesEnc = plain => { const c = crypto.createCipheriv('aes-128-cbc', KEY, IV); c.setAutoPadding(true); return Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]).toString('base64') }
const aesDec = b => { const d = crypto.createDecipheriv('aes-128-cbc', KEY, IV); d.setAutoPadding(true); return Buffer.concat([d.update(Buffer.from(b, 'base64')), d.final()]).toString('utf8') }

// ---- 匿名账号 token（自动续）----
let TOKEN = ''
let TOKEN_AT = 0
async function ensureToken(force = false) {
  if (!force && TOKEN && Date.now() - TOKEN_AT < 6 * 86400e3) return TOKEN
  const t = String(Date.now())
  const head = { app: '1', platform: '7', t, token: '', version: '2.4.7.1', versionapi: '3.0.2.0' }
  const hdr = aesEnc(ser({ ...head, s: md5(ser({ ...head, k: KMIX })) }))
  const dev = 'web' + crypto.randomBytes(4).toString('hex')
  const body = { brand: 'iPhone', cdn_is_encrypt: '1', device_uuid: dev, deviceid: dev, model: 'iPhone', more: '14.0', t }
  const payload = aesEnc(ser({ ...body, s: md5(ser({ ...body, k: KMIX })) }))
  const r = await apiFetch('/api/account/init', {
    method: 'POST',
    headers: { d: hdr, 'content-type': 'application/json' },
    body: JSON.stringify({ d: payload }),
  })
  const tx = await r.text()
  let j = {}
  try { j = JSON.parse(tx); if (j.d) j = JSON.parse(aesDec(j.d)) } catch { j = {} }
  TOKEN = j?.data?.token || ''
  TOKEN_AT = Date.now()
  if (!TOKEN) throw new Error('account/init failed: ' + tx.slice(0, 120))
  return TOKEN
}
async function apiCall(p, query, retry = true) {
  const token = await ensureToken()
  const qs = query ? '?' + new URLSearchParams(query) : ''

  // 上游经常短时抽风：网络失败或非 200 时再整轮重试一次（跨主机池）
  let last = { code: -1, data: {} }
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = String(Date.now())
    const meta = { app: '1', platform: '7', t, token, version: '2.4.7.1', versionapi: '3.0.2.0' }
    const d = aesEnc(ser({ ...meta, s: md5(ser({ ...meta, k: KMIX })) }))
    let tx
    try {
      const r = await apiFetch(p + qs, { headers: { d } })
      tx = await r.text()
    } catch (err) {
      last = { code: -1, message: '上游不可达：' + (err.cause?.code || err.message), data: {} }
      console.log(`[api] ${p} 第 ${attempt + 1} 轮失败: ${err.cause?.code || err.message}`)
      if (attempt === 0) await new Promise(r => setTimeout(r, 400))
      continue
    }
    let j = {}
    try { j = JSON.parse(tx); if (j.d) j = JSON.parse(aesDec(j.d)) } catch { j = { code: -1, raw: tx.slice(0, 200), data: {} } }
    if ((j.code === 401 || j.code === 403) && retry) { await ensureToken(true); return apiCall(p, query, false) }
    if (j.code === 200) return j
    last = j
    console.log(`[api] ${p} 返回 ${j.code}，第 ${attempt + 1} 轮`)
    if (attempt === 0) await new Promise(r => setTimeout(r, 400))
  }
  return last
}

// ---- 在线播放：线路缓存 ----
// 实测：(3,0) 内容空间完整版；老 movie 空间用 (1,0)；2 是短剪
const LIVE_ORDER = [[3, 0], [1, 0], [1, 1], [2, 0]]
const liveCache = new Map()
const infoCache = new Map()
const LIVE_TTL = 45_000
const INFO_TTL = 600_000

async function fetchPlaylist(id, A, C) {
  const t = String(Math.floor(Date.now() / 1000))
  const path = `/api/pwa/m3u8/${id}/${A}/0/${C}/1/${t}/${md5(`app=1&k=${OLDSALT}&t=${t}`)}`
  let res
  try {
    // 播放列表很小，直接三台机器赛跑，谁先返回用谁的（顺序重试最坏要 21s，赛跑通常 <1s）
    const pick = (h) => fetch(h + path, {
      headers: { origin: 'https://bycsp30.com', referer: 'https://bycsp30.com/', 'user-agent': UA },
      signal: AbortSignal.timeout(6000),
    }).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r })
    res = await Promise.any(HOSTS.map(pick))
  } catch (err) {
    console.log(`[live] ${id} ${A}/${C} 三台均失败: ${err?.errors?.map(e => e.cause?.code || e.message).join(',') || err.message}`)
    return null
  }
  const text = await res.text()
  if (!text.startsWith('#EXTM3U')) return null
  const lines = text.split('\n')
  const keyUri = lines.find(l => l.startsWith('#EXT-X-KEY'))?.match(/URI="([^"]+)"/)?.[1] || null
  const segs = lines.filter(l => l.trim() && !l.startsWith('#')).map(l => (l.startsWith('http') ? l : API() + l))
  const dur = Math.round([...text.matchAll(/#EXTINF:([0-9.]+)/g)].reduce((a, m) => a + Number(m[1]), 0))
  return { at: Date.now(), keyUri, segs, text, dur, src: `${A}${C}` }
}

// ---- 分片缓存 + 预取（提升拖动/回看速度）----
const SEG_MAX_BYTES = 96 * 1024 * 1024
const segCache = new Map()      // url -> Buffer（Map 保持插入顺序，天然 LRU）
let segBytes = 0
function segGet(url) {
  const b = segCache.get(url)
  if (b) { segCache.delete(url); segCache.set(url, b) }   // 命中即刷新顺序
  return b || null
}
function segPut(url, buf) {
  if (segCache.has(url)) return
  segCache.set(url, buf)
  segBytes += buf.length
  while (segBytes > SEG_MAX_BYTES) {
    const [oldUrl, oldBuf] = segCache.entries().next().value
    segCache.delete(oldUrl)
    segBytes -= oldBuf.length
  }
}
async function fetchSeg(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://bycsp30.com/', range: 'bytes=0-' }, signal: AbortSignal.timeout(20000) })
  if (r.status !== 200 && r.status !== 206) throw new Error('seg ' + r.status)
  return Buffer.from(await r.arrayBuffer())
}
// 背景预取后面两个分片，播到下一段时直接命中缓存
function prefetchSegs(id, src, segs, from) {
  for (let i = from; i < Math.min(from + 2, segs.length); i++) {
    const url = segs[i]
    if (!url || segCache.has(url)) continue
    fetchSeg(url).then(b => segPut(url, b)).catch(() => {})
  }
}

// ---- 播放密钥缓存 ----
const keyCache = new Map()      // keyUri -> {buf, at}
async function fetchKey(uri) {
  const hit = keyCache.get(uri)
  if (hit && Date.now() - hit.at < 600000) return hit.buf
  const r = await fetch(uri, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) })
  if (!r.ok) throw new Error('key ' + r.status)
  const buf = Buffer.from(await r.arrayBuffer())
  keyCache.set(uri, { buf, at: Date.now() })
  return buf
}

async function loadLive(id, want = '', force = false) {
  const tryOne = async ([A, C]) => {
    const k = `${id}@${A}:${C}`
    const hit = liveCache.get(k)
    if (!force && hit && Date.now() - hit.at < LIVE_TTL) return hit
    const entry = await fetchPlaylist(id, A, C)
    if (entry) liveCache.set(k, entry)
    return entry
  }
  if (want) {
    const [A, C] = want.split('').map(Number)
    const entry = await tryOne([A, C])
    if (!entry) throw new Error('playlist unavailable')
    return { src: `${A}${C}`, entry }
  }
  // 未指定线路时按优先级顺序取第一条可用（chosen 由路由传入，避免这里同步探测四条线路）
  for (const combo of LIVE_ORDER) {
    const entry = await tryOne(combo)
    if (entry) return { src: `${combo[0]}${combo[1]}`, entry }
  }
  throw new Error('no playlist for any source')
}

async function lineInfo(id) {
  const hit = infoCache.get(id)
  if (hit && Date.now() - hit.at < INFO_TTL) return hit
  const all = {}
  // 四条线路并发探测（顺序探测单条最长要 12s，冷启动首播会被拖住）
  const combos = [[3, 0], [1, 0], [1, 1], [2, 0]]
  const results = await Promise.all(combos.map(([A, C]) => fetchPlaylist(id, A, C).catch(() => null)))
  results.forEach((e, i) => {
    if (e) all[`${combos[i][0]}${combos[i][1]}`] = { dur: e.dur, segs: e.segs.length }
  })
  // 官方不同 A/C 组合并不都指向同一部片：实测同一 id 下 3/0 与 1/0 可能是完全不同的视频（时长差几倍），
  // 1/1 有时只有正片的片段。因此以「线路优先级第一可用」为基准，只保留时长与它相近（±10%）的线路，
  // 其余一律丢弃——避免出现「备用线路只有半小时」这种误导。
  const seq = LIVE_ORDER.map(([A, C]) => `${A}${C}`).filter(k => all[k])
  const base = seq.length ? all[seq[0]].dur : 0
  const variants = {}
  let rank = 0
  for (const k of seq) {
    if (base && Math.abs(all[k].dur - base) > base * 0.1) continue
    variants[k] = { dur: all[k].dur, segs: all[k].segs, label: rank === 0 ? '完整版' : '备用' }
    rank++
  }
  const chosen = Object.keys(variants)[0] || ''
  const out = { at: Date.now(), variants, chosen, base, dropped: seq.length - Object.keys(variants).length }
  infoCache.set(id, out)
  return out
}

function rewritePlaylist(id, src, entry, direct = true) {
  // 直连模式：CDN 与 key 接口都返回 access-control-allow-origin:*，
  // 浏览器可以直接拉分片，省掉服务端中转这一跳（拖动 seek 明显更快）。
  if (direct) {
    const lines = []
    for (const line of entry.text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      if (t.startsWith('#EXT-X-KEY') && entry.keyUri) {
        lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="${entry.keyUri}"`)
        continue
      }
      lines.push(t)
    }
    if (!lines.includes('#EXT-X-ENDLIST')) lines.push('#EXT-X-ENDLIST')
    return lines.join('\n') + '\n'
  }
  const out = []
  for (const line of entry.text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('#EXT-X-KEY')) {
      out.push(entry.keyUri ? `#EXT-X-KEY:METHOD=AES-128,URI="/live/${id}/${src}/key"` : t)
      continue
    }
    if (t.startsWith('#')) { out.push(t); continue }
    const idx = entry.segs.findIndex(s => s === t || s.endsWith(t.split('?')[0].slice(-40)))
    out.push(`/live/${id}/${src}/seg/${idx >= 0 ? idx : 0}.ts`)
  }
  if (!out.includes('#EXT-X-ENDLIST')) out.push('#EXT-X-ENDLIST')
  return out.join('\n') + '\n'
}

// ---- 图片解密 ----
const sniff = b =>
  b[0] === 0x89 ? 'image/png' : b[0] === 0x47 ? 'image/gif' : b[0] === 0xff ? 'image/jpeg'
  : (b.subarray(8, 12).toString('ascii') === 'WEBP') ? 'image/webp' : null

// 结构完整性：严格解码器（Safari 的 WebP/JPEG）遇到残缺会只画一部分
function imageIntact(buf) {
  if (!buf || buf.length < 32) return false
  const kind = sniff(buf)
  if (kind === 'image/webp') {
    if (buf.subarray(0, 4).toString('ascii') !== 'RIFF') return false
    return buf.readUInt32LE(4) + 8 === buf.length          // RIFF 声明长度必须等于实际
  }
  if (kind === 'image/gif') return buf[buf.length - 1] === 0x3b   // trailer
  if (kind === 'image/jpeg') return buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9 // EOI
  if (kind === 'image/png') return buf.subarray(-8, -4).toString('ascii') === 'IEND'
  return false
}

async function fetchCoverCipher(safe) {
  let lastErr = new Error('cover fetch failed')
  for (let i = 0; i < 3; i++) {                    // CDN 偶发截断，重试
    try {
      const res = await fetch(IMG_CDN + safe, {
        headers: { referer: 'https://bycsp30.com/', 'user-agent': UA },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) throw new Error('cdn ' + res.status)
      const buf = Buffer.from(await res.arrayBuffer())
      const cl = Number(res.headers.get('content-length') || 0)
      // 注意：图片 CDN 的 content-length 与实际 body 不一致（会偏大），不能作为完整性依据，
      // 只以「密文长度必须是 16 的整数倍」+ 解密后的结构校验为准。
      if (cl && buf.length !== cl) console.log(`[cover] content-length 偏差 ${buf.length}/${cl}（忽略）`)
      if (buf.length % 16 !== 0) { lastErr = new Error(`长度 ${buf.length} 非 16 倍数`); continue }
      return buf
    } catch (err) { lastErr = err; await new Promise(r => setTimeout(r, 200 * (i + 1))) }
  }
  throw lastErr
}

function decryptCover(cipher) {
  try {                                            // 正常是 PKCS7
    const d = crypto.createDecipheriv('aes-128-cbc', IMG_KEY, IMG_IV)
    d.setAutoPadding(true)
    const out = Buffer.concat([d.update(cipher), d.final()])
    if (imageIntact(out)) return out
    if (sniff(out)) return out                     // 结构校验不过但能识别，交上层再判
  } catch { /* 落到无 padding */ }
  const d2 = crypto.createDecipheriv('aes-128-cbc', IMG_KEY, IMG_IV)
  d2.setAutoPadding(false)
  return Buffer.concat([d2.update(cipher), d2.final()])
}

async function getCover(p) {
  const safe = p.replace(/\.\./g, '')
  const key = crypto.createHash('sha1').update(safe).digest('hex')
  for (const ext of ['webp', 'gif', 'jpg', 'png']) {
    const hit = path.join(CACHE, `${key}.${ext}`)
    if (fs.existsSync(hit)) {
      const buf = fs.readFileSync(hit)
      if (imageIntact(buf)) return { buf, type: MIME['.' + ext] }
      fs.unlinkSync(hit)                            // 旧的残图清掉重下
    }
  }
  const cipher = await fetchCoverCipher(safe)
  const plain = decryptCover(cipher)
  if (!imageIntact(plain)) throw new Error(`封面数据不完整（${plain.length}B）`)
  const type = sniff(plain)
  fs.writeFileSync(path.join(CACHE, `${key}.${type.split('/')[1]}`), plain)
  return { buf: plain, type }
}

const send = (res, code, type, body) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-cache' })
  res.end(body)
}
const json = (res, obj) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(obj))

// ---- 老 movie 空间的明文 HLS 代理（女优作品 url 走这里）----
async function proxyMovie(u, req, res) {
  const target = u.startsWith('http') ? u : MV_CDN + u
  const r = await fetch(target, { headers: { referer: 'https://bycsp30.com/', 'user-agent': UA } })
  if (!r.ok) return send(res, r.status, 'text/plain; charset=utf-8', 'upstream ' + r.status)
  const ct = r.headers.get('content-type') || ''
  const buf = Buffer.from(await r.arrayBuffer())
  if (ct.includes('mpegurl') || buf.subarray(0, 7).toString('ascii') === '#EXTM3U') {
    const text = buf.toString('utf8')
    const base = new URL(target)
    const out = text.split('\n').map(line => {
      const t = line.trim()
      if (!t || t.startsWith('#')) return line
      const abs = new URL(t, base).toString()
      return `/mv?u=${encodeURIComponent(abs)}`
    }).join('\n')
    return send(res, 200, MIME['.m3u8'], out)
  }
  res.writeHead(200, { 'content-type': ct || MIME['.ts'], 'content-length': buf.length, 'cache-control': 'no-store' })
  res.end(buf)
}


// ───────────────────────── LJ_AUTH_V1 访问密码 ─────────────────────────
// 用法：所有内容（页面/接口/播放列表/封面/数据）都必须先输密码换 Cookie，
// 直链、外站引用、爬虫一律拿不到。密码存 .password 文件，可随时改。
const AUTH_SECRET_FILE = path.join(__dirname, '.auth-secret')
const AUTH_PASSWORD_FILE = path.join(__dirname, '.password')
const AUTH_SECRET = (() => {
  try { return fs.readFileSync(AUTH_SECRET_FILE) } catch {
    const s = crypto.randomBytes(32)
    try { fs.writeFileSync(AUTH_SECRET_FILE, s) } catch {}
    return s
  }
})()
function authPassword() {
  if (process.env.LJ_PASSWORD) return process.env.LJ_PASSWORD
  try { return fs.readFileSync(AUTH_PASSWORD_FILE, 'utf8').trim() } catch { return 'lunjiang2026' }
}
const AUTH_COOKIE = 'lj'
const AUTH_TTL = 30 * 24 * 3600 * 1000
function authSign(exp) {
  return crypto.createHmac('sha256', AUTH_SECRET).update('lj:' + exp).digest('hex')
}
function authToken() {
  const exp = Date.now() + AUTH_TTL
  return exp + '.' + authSign(exp)
}
function authOk(req) {
  const raw = req.headers.cookie || ''
  const m = raw.match(/(?:^|;\s*)lj=([^;]+)/)
  if (!m) return false
  const [expStr, sig] = decodeURIComponent(m[1]).split('.')
  const exp = Number(expStr)
  if (!exp || !sig || exp < Date.now()) return false
  const want = Buffer.from(authSign(exp))
  const got = Buffer.from(sig)
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}
const authFails = new Map()
function authBlocked(ip) {
  const rec = authFails.get(ip)
  if (!rec) return false
  if (Date.now() > rec.until) { authFails.delete(ip); return false }
  return rec.n >= 8
}
function authFail(ip) {
  const rec = authFails.get(ip) || { n: 0, until: Date.now() + 10 * 60 * 1000 }
  rec.n += 1
  rec.until = Date.now() + 10 * 60 * 1000
  authFails.set(ip, rec)
}
function authClear(ip) { authFails.delete(ip) }

const AUTH_PUBLIC = new Set([
  '/login', '/unlock', '/lock', '/favicon.ico', '/robots.txt', '/sw.js',
  '/manifest.webmanifest', '/logo.jpg', '/splash.jpg',
  '/icon-180.png', '/icon-192.png', '/icon-512.png',
])
function authNeeds(p) { return !AUTH_PUBLIC.has(p) }

function loginPage(err) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<meta name="theme-color" content="#141418"><title>请输入访问密码</title><style>' +
    ':root{--brand:#EB485A;--ink:#f4f4f6;--muted:#9a9aa4;--bg:#0f0f12;--card:#17171c}' +
    '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}' +
    'html,body{height:100%;margin:0}' +
    'body{background:radial-gradient(120% 80% at 50% 0%,#241118 0%,var(--bg) 60%);color:var(--ink);' +
    'font:15px/1.6 -apple-system,BlinkMacSystemFont,"SF Pro SC","PingFang SC","Microsoft YaHei",sans-serif;' +
    'display:flex;align-items:center;justify-content:center;padding:24px}' +
    '.card{width:100%;max-width:360px;background:var(--card);border:1px solid #26262e;border-radius:18px;' +
    'padding:26px 22px 22px;box-shadow:0 24px 60px rgba(0,0,0,.55)}' +
    '.logo{width:64px;height:64px;border-radius:16px;display:block;margin:0 auto 14px;object-fit:cover;' +
    'border:1px solid #2c2c34}' +
    'h1{font-size:17px;margin:0 0 4px;text-align:center;letter-spacing:.5px}' +
    'p.sub{margin:0 0 18px;text-align:center;color:var(--muted);font-size:12.5px}' +
    'input{width:100%;height:46px;border-radius:12px;border:1px solid #30303a;background:#101014;color:var(--ink);' +
    'padding:0 14px;font-size:16px;letter-spacing:1px;outline:none}' +
    'input:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(235,72,90,.16)}' +
    'button{width:100%;height:46px;margin-top:12px;border:0;border-radius:12px;font-size:15.5px;font-weight:600;' +
    'color:#fff;background:linear-gradient(180deg,#FF6A7B,#E23F52);cursor:pointer}' +
    'button:active{transform:translateY(1px)}' +
    '.err{margin:12px 0 0;color:#FF8B98;font-size:12.5px;text-align:center;min-height:18px}' +
    '.tip{margin:16px 0 0;color:#6f6f7a;font-size:11.5px;text-align:center;line-height:1.7}' +
    '</style></head><body><form class="card" method="POST" action="/unlock">' +
    '<img class="logo" src="/logo.jpg" alt="">' +
    '<h1>伦酱视频</h1><p class="sub">本站为私享内容，请输入访问密码</p>' +
    '<input name="pw" type="password" inputmode="text" autocomplete="current-password" placeholder="访问密码" autofocus>' +
    '<button type="submit">进入</button>' +
    '<p class="err">' + (err || '') + '</p>' +
    '<p class="tip">30 天内免重复输入<br>密码不对就进不去，别乱试</p>' +
    '</form></body></html>'
}
// ─────────────────────── LJ_AUTH_V1 end ───────────────────────

const handler = async (req, res) => {
  // 访问日志：能看出手机的请求到底有没有到达本机
  const t0 = Date.now()
  res.on('finish', () => {
    if (!req.url.startsWith('/cover') && !/\.(png|ico|webmanifest)$/.test(req.url)) {
      const who = (req.socket.remoteAddress || '').replace('::ffff:', '')
      console.log(`[req] ${who} ${req.method} ${req.url} -> ${res.statusCode} ${Date.now() - t0}ms` + (req.url === '/' ? `  UA=${req.headers['user-agent'] || ''}` : ''))
    }
  })
  const u = new URL(req.url, 'http://x')
  const p = decodeURIComponent(u.pathname)

  // ── 鉴权闸门：除白名单外，全部需要 Cookie ──
  if (authNeeds(p) && !authOk(req)) {
    if (p === '/login') { /* 白名单已覆盖，走不到这里 */ }
    const ipA = (req.socket.remoteAddress || '').replace('::ffff:', '')
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(302, { location: '/login' })
      return res.end()
    }
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-lj-auth': 'required' })
    return res.end(ipA && authBlocked(ipA) ? '尝试次数过多，请 10 分钟后再试' : '需要访问密码')
  }

  if (p === '/login') {
    return send(res, 200, MIME['.html'], loginPage(''))
  }

  if (p === '/unlock' && req.method === 'POST') {
    const ipB = (req.socket.remoteAddress || '').replace('::ffff:', '')
    if (authBlocked(ipB)) return send(res, 429, MIME['.html'], loginPage('尝试次数过多，请 10 分钟后再试'))
    let body = ''
    try {
      for await (const ch of req) { body += ch; if (body.length > 4096) break }
    } catch {}
    const pw = new URLSearchParams(body).get('pw') || ''
    const want = authPassword()
    const ok = pw.length === want.length &&
      crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(want))
    if (!ok) {
      authFail(ipB)
      return send(res, 401, MIME['.html'], loginPage('密码不对，请重新输入'))
    }
    authClear(ipB)
    res.writeHead(302, {
      'set-cookie': AUTH_COOKIE + '=' + authToken() + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(AUTH_TTL / 1000),
      location: '/',
    })
    return res.end()
  }

  if (p === '/lock') {
    res.writeHead(302, { 'set-cookie': 'lj=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0', location: '/login' })
    return res.end()
  }

  try {
    if (p === '/' || p === '/index.html') {
      return send(res, 200, MIME['.html'], fs.readFileSync(path.join(__dirname, 'index.html')))
    }

    if (p === '/mv') {
      const target = u.searchParams.get('u') || ''
      if (!target) return send(res, 400, 'text/plain', 'missing u')
      return proxyMovie(target, req, res)
    }

    // 播放列表
    let m = p.match(/^\/live\/(\d+)\.m3u8$/)
    if (m) {
      const id = m[1]
      let want = u.searchParams.get('src') || ''
      const info = infoCache.get(id)
      // 已探测过就直接用「基准线路」，不再同步探测，首帧快很多
      if (!want && info && Date.now() - info.at < INFO_TTL && info.chosen) want = info.chosen
      let result
      try { result = await loadLive(id, want) } catch { result = await loadLive(id, '') }
      const { src, entry } = result
      if (!info) lineInfo(id).catch(() => {})   // 线路信息后台补齐，不阻塞首播
      const direct = u.searchParams.get('direct') !== '0'
      res.writeHead(200, {
        'content-type': MIME['.m3u8'], 'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'x-gj-src': src, 'x-gj-dur': String(entry.dur), 'x-gj-direct': direct ? '1' : '0',
      })
      return res.end(rewritePlaylist(id, src, entry, direct))
    }

    m = p.match(/^\/live\/(\d+)\/info$/)
    if (m) return json(res, { id: Number(m[1]), ...(await lineInfo(m[1])) })

    m = p.match(/^\/live\/(\d+)\/(\d+)\/seg\/(\d+)\.ts$/)
    if (m) {
      const [, id, src, idx] = m
      const n = Number(idx)
      let buf = null
      let segs = null
      for (let attempt = 0; attempt < 2; attempt++) {
        const { entry } = await loadLive(id, src, attempt === 1)
        segs = entry.segs
        const url = segs[n]
        if (!url) break
        buf = segGet(url)
        if (!buf) {
          try { buf = await fetchSeg(url) } catch { if (attempt === 0) continue }
          if (buf) segPut(url, buf)
        }
        if (buf) { prefetchSegs(id, src, segs, n + 1); break }
      }
      if (!buf) return send(res, 502, 'text/plain; charset=utf-8', 'segment unavailable')
      res.writeHead(200, {
        'content-type': MIME['.ts'],
        'content-length': buf.length,
        'accept-ranges': 'bytes',
        // 分片是不可变内容，长缓存让拖动/回看直接命中浏览器缓存
        'cache-control': 'public, max-age=86400, immutable',
      })
      return res.end(buf)
    }

    m = p.match(/^\/live\/(\d+)\/(\d+)\/key$/)
    if (m) {
      const { entry } = await loadLive(m[1], m[2])
      if (!entry.keyUri) return send(res, 404, 'text/plain', 'no key')
      let buf
      try { buf = await fetchKey(entry.keyUri) } catch { return send(res, 502, 'text/plain', 'key unavailable') }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': buf.length,
        'cache-control': 'public, max-age=600',
      })
      return res.end(buf)
    }

    // 专题合集
    if (p === '/api/topics') {
      const page = u.searchParams.get('page') || '1'
      const r = await cached('topics:' + page, 120000, () => apiCall('/api/monographic/list/1', { page, page_size: '20' }), r => r.code === 200 && Array.isArray(r.data?.monographic))
      const topics = (r.data?.monographic || []).map(t => ({
        id: t.id, name: t.name, cover: t.clover, banner: t.banner,
        count: t.valid_film_count ?? t.video_count, click: t.click, desc: t.desc || '',
      }))
      return json(res, { code: r.code, more: r.data?.more ?? 0, topics })
    }
    if (p === '/api/topic') {
      const id = u.searchParams.get('id')
      const page = u.searchParams.get('page') || '1'
      if (!id) return send(res, 400, 'text/plain', 'missing id')
      const r = await cached('topic:' + id + ':' + page, 300000, () => apiCall('/api/monographic/videos/' + id + '/' + page), r => r.code === 200 && Array.isArray(r.data?.videos))
      const videos = (r.data?.videos || []).map(v => ({
        id: v.id, name: v.video_name || '', length: v.movie_length || '',
        cover: v.preview_pics || v.horizontal_cover || v.vertical_cover || '',
        flag: v.flag || '', actor: v.chinese_name || v.actor || '', views: v.views || 0,
      }))
      return json(res, { code: r.code, page: Number(page), videos })
    }

    // 频道（对齐官方 /tags/channels 的导航项）
    if (p === '/api/channels') {
      const raw = await cached('channels', 300000, async () => (await apiCall('/api/tags/channels')).data?.fixTags || [], a => Array.isArray(a) && a.length > 0).catch(() => [])
      const navChannels = raw.filter(c => c.type === 'navigation').map(c => c.name)
      const MAP = {
        推荐: { kind: 'list', orderBy: '', nav: 'payVideo' },
        VIP专区: { kind: 'list', orderBy: 'collects', nav: 'payVideo' },
        点播区: { kind: 'nav', nav: '点播' },
        女优: { kind: 'nav', nav: '女优' },
        专题: { kind: 'nav', nav: '专题' },
        最新: { kind: 'list', orderBy: '', nav: 'payVideo' },
        排行榜: { kind: 'nav', nav: '排行' },
        最热: { kind: 'list', orderBy: 'views', nav: 'payVideo' },
      }
      const channels = navChannels
        .filter(n => MAP[n])
        .map(n => ({ name: n, ...MAP[n] }))
      return json(res, { code: 200, source: navChannels, channels })
    }
    if (p === '/api/channel') {
      const name = u.searchParams.get('name') || '最新'
      const page = u.searchParams.get('page') || '1'
      const orderBy = u.searchParams.get('orderBy') || ''
      const r = await cached('ch:' + name + ':' + orderBy + ':' + page, 120000, () => apiCall('/api/content/getContentList', {
        page, page_size: '30', nav_page: 'payVideo', keyword: '', orderBy, sort: orderBy ? 'desc' : '',
      }), r => r.code === 200)
      const list = (r.data?.list || []).map(x => ({
        id: x.id, name: x.title || '', cover: x.pic_cover || '', views: x.views || 0,
        points: x.points || 0, actor: x.author || '', length: '',
      }))
      return json(res, { code: r.code, name, isMore: r.data?.is_more ?? 0, list })
    }

    // 排行榜（天/周/月 × 分类）
    if (p === '/api/rank') {
      const days = u.searchParams.get('days') || '1'
      const tag = u.searchParams.get('tag') || '0'
      const page = u.searchParams.get('page') || '1'
      const r = await cached('rank:' + days + ':' + tag + ':' + page, 120000, () => apiCall('/api/ranking/movie_history', { page, page_size: '30', tag_id: tag, days }), r => r.code === 200 && Array.isArray(r.data?.ranking))
      const list = (r.data?.ranking || []).map((x, i) => ({
        rank: (Number(page) - 1) * 30 + i + 1,
        id: x.video?.id,
        name: x.video?.video_name || '',
        length: x.video?.movie_length || '',
        views: x.video?.views || x.count_uv || 0,
        flag: x.video?.flag || '',
        number: x.video?.number || '',
        actor: x.video?.chinese_name || x.video?.actor || '',
        cover: x.video?.preview_pics || '',
      }))
      return json(res, { code: r.code, days: r.data?.days, begin: r.data?.begin_date, end: r.data?.end_date, count: r.data?.count, list })
    }

    if (p === '/api/rank-tags') {
      const r = await cached('ranktags', 600000, () => apiCall('/api/ranking/tags_menu'), r => r.code === 200 && Array.isArray(r.data?.tags_menus))
      return json(res, { code: r.code, tags: r.data?.tags_menus || [] })
    }

    // 女优列表 / 详情
    if (p === '/api/girls') {
      const letter = (u.searchParams.get('letter') || 'A').toUpperCase()
      const r = await cached('girls:' + letter, 600000, () => apiCall('/api/girls/letterList/' + letter), r => r.code === 200 && Array.isArray(r.data?.result))
      const rows = (r.data?.result || []).map(g => ({ id: g.id, name: g.chinese_name, avatar: g.avatar, letter: g.letter_sort }))
      return json(res, { code: r.code, letter, girls: rows })
    }
    if (p === '/api/girl') {
      const id = u.searchParams.get('id') || '5'
      const r = await cached('girl:' + id, 600000, () => apiCall('/api/girls/details/' + id), r => r.code === 200 && !!r.data?.gril)
      const g = r.data?.gril || {}
      const works = (r.data?.magnumOpu || []).map(w => ({
        id: w.id, name: w.video_name || '', length: w.movie_length || '',
        url: w.url || '', views: w.views || 0, flag: w.flag || '', cover: w.preview_pics || w.horizontal_cover || '',
      }))
      return json(res, {
        code: r.code,
        girl: { id: g.id, name: g.chinese_name, jp: g.jp_name, avatar: g.avatar, birthday: g.birthday, height: g.height, cup: g.cup, bwh: g.bwh, country: g.country, intro: g.introduce },
        works,
      })
    }

    if (p === '/cover') {
      const target = u.searchParams.get('p') || ''
      if (!target) return send(res, 400, 'text/plain', 'missing p')
      const { buf, type } = await getCover(target)
      res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' })
      return res.end(buf)
    }

    if (p === '/manifest.webmanifest') {
      return send(res, 200, MIME['.webmanifest'], JSON.stringify({
        name: '伦酱视频 · 在线片库', short_name: '伦酱视频', start_url: '/', display: 'standalone',
        background_color: '#f6f6f8', theme_color: '#EB485A',
        icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
      }))
    }

    const file = path.join(__dirname, p)
    if (!file.startsWith(__dirname) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(res, 404, 'text/plain; charset=utf-8', '404')
    }
    const ext = path.extname(file).toLowerCase()
    const size = fs.statSync(file).size
    const type = MIME[ext] || 'application/octet-stream'
    const range = req.headers.range
    if (range && /^bytes=/.test(range)) {
      const [s, e] = range.replace('bytes=', '').split('-')
      const start = Number(s) || 0
      const end = e ? Number(e) : size - 1
      res.writeHead(206, {
        'content-type': type, 'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1,
      })
      return fs.createReadStream(file, { start, end }).pipe(res)
    }
    const noCache = ext === '.html' || ext === '.json' || ext === '.webmanifest'
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', ...(noCache ? { 'cache-control': 'no-cache, must-revalidate' } : {}) })
    fs.createReadStream(file).pipe(res)
  } catch (err) {
    send(res, 500, 'text/plain; charset=utf-8', '500 ' + err.message)
  }
}

const server = http.createServer(handler)

// 首次运行自举：缺 .password 就写入默认值并在控制台明示，缺 .cache 由上方 mkdir 处理
if (!fs.existsSync(AUTH_PASSWORD_FILE) && !process.env.LJ_PASSWORD) {
  try { fs.writeFileSync(AUTH_PASSWORD_FILE, 'lunjiang2026') } catch {}
  console.log('  [首次启动] 已生成 .password，默认密码: lunjiang2026（请改掉，改完无需重启）')
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address)
  console.log(`伦酱视频 · 在线片库 serving ${__dirname}`)
  console.log(`  http://127.0.0.1:${PORT}/`)
  for (const ip of ips) console.log(`  http://${ip}:${PORT}/   <-- 手机用这个`)

  // 备用 80 端口：有些手机代理/防火墙只放行 80，用 http://<ip>/ 也能开
  const alt = http.createServer(handler)
  alt.on('error', e => console.log('  [80] 无法监听: ' + e.code))
  alt.listen(80, '0.0.0.0', () => {
    for (const ip of ips) console.log('  http://' + ip + '/   <-- 备用（80 端口）')
  })
})
