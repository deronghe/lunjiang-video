# 伦酱视频 · 在线片库

零依赖本地站点（Node ESM，无需 `npm install`）。界面照搬原站栏目结构，**视频不落盘**：播放时由本机代理源站 CDN 分片、即时解密后喂给播放器；封面同样由服务端取回、AES 解密后缓存。

## 特性

| 模块 | 说明 |
|---|---|
| 片库 | 排行（今日 / 昨日 / 本周 / 本月）、女优、专题、栏目、频道五套页签 |
| 播放器 | 原生 `<video>` + hls.js；自绘常驻进度条（拖动预览、当前/总时长）；分片预取 + LRU 缓存 |
| 线路 | 按 `A/C` 组合并发探测，按「完整版优先、时长偏差 ≤10%」筛选，自动回落备用线路 |
| 缓存 | 内存 + 磁盘（`.cache/api`），stale-while-revalidate + 请求合并 + 多域名故障转移 |
| 访问控制 | 密码换取 HMAC 签名 Cookie（HttpOnly / SameSite=Lax / 30 天），直链与外链一律 401 |
| 开场广告 | 全屏品牌图强制观看 5 秒，进度条 + 倒计时 |
| PWA | manifest + 180/192/512 图标 + Service Worker 离线外壳 |

## 快速开始

```bash
node server.mjs 8899        # 同时尝试监听 80 与 8899
```

首次启动会在目录内生成：

```
.auth-secret       Cookie 签名密钥（32 字节随机，勿提交）
.password          访问密码，默认 lunjiang（逐请求读取，改完无需重启）
```

访问 `http://<本机IP>/`，输入密码进入。

## 目录

```
server.mjs            主服务：接口代理 / 播放列表改写 / 封面解密 / 鉴权闸门 / manifest
index.html            单页应用（样式与逻辑内联，无构建步骤）
sw.js                 Service Worker 离线外壳
hls.min.js            hls.js 运行时
data.json             片库数据
build-data.mjs        片库抓取脚本
splash.jpg            开场广告图（替换后记得改 index.html 里的 ?v= 版本号）
logo.jpg / icon-*.png 站内图标与 PWA 图标
deploy/frpc.example.toml  内网穿透配置示例（占位符，需填自己的值）
```

## 配置

| 项 | 位置 | 说明 |
|---|---|---|
| 端口 | `node server.mjs <port>` | 默认 8899，同时尝试监听 80 |
| 访问密码 | `.password` 或环境变量 `LJ_PASSWORD` | 逐请求读取，改完即时生效 |
| 会话时长 | `server.mjs` 的 `AUTH_TTL` | 默认 30 天 |
| 强制全员重新登录 | 删除 `.auth-secret` 后重启 | 密钥轮换，旧 Cookie 全部作废 |
| 登录限流 | 同 IP 10 分钟错 8 次 | 超过后返回 429 |

## 内网穿透（可选）

```bash
frpc.exe -c frpc.toml
```

映射后公网访问 `http://<FRP_SERVER>:8899/`，鉴权闸门同样生效（未登录 → 302 `/login`，静态资源 → 401）。

## 部署建议

- 对外暴露时建议套一层 HTTPS（域名 + 证书），否则密码为明文传输
- `.cache/` 与 `media/` 是运行时产物，已加入 `.gitignore`
- 目录内不要放真实密钥：`.auth-secret` 泄露等于会话可伪造
