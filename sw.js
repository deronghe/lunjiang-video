// 伦酱视频 · 离线外壳（Service Worker）
// 只缓存外壳资源（页面 / 数据 / 图标 / hls.js），视频分片一律走网络。
const SHELL = 'lj-shell-v1'
const ASSETS = [
  '/',
  '/data.json',
  '/hls.min.js',
  '/logo.jpg',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png',
]

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => Promise.allSettled(ASSETS.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // 动态接口（排行/专题/播放列表/分片/封面）不缓存，避免看到旧数据
  if (/^\/(api|live|cover)\//.test(url.pathname) || url.pathname === '/api') return

  // 页面与数据：网络优先，失败回落缓存（离线也能打开外壳）
  if (url.pathname === '/' || url.pathname.endsWith('.json') || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {})
          return res
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
    )
    return
  }

  // 静态资源：缓存优先
  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req).then((res) => {
        const copy = res.clone()
        caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {})
        return res
      })
    )
  )
})
