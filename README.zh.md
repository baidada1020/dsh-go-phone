# dsh-go-phone 📱

在 **DeepSeek Harness 的侧边栏底部加一个「📱 手机 DSH」按钮**，点开就在电脑上直接操作手机上那套 DSH Go 引擎——对话、工作区、附件、插件全都在，不用把手机拿起来。

- 电脑本地跑 Harness，手机跑 DSH Go：**手机是主机**，电脑只是一个屏幕。
- 手机熄屏 / 电脑关机都不影响对方：手机上那套引擎照常独立工作。
- 不登录第三方服务器，全部走 `adb` 本地转发。

## 它做了什么

手机上的 DSH Go 把 Harness 引擎跑在手机的 `127.0.0.1:3080`（proot 里跑 node）。这个插件做三件事：

1. `adb forward` 把手机引擎端口拉到本机；
2. 起一个本地网关（默认 `127.0.0.1:13100`），负责注入浏览器会话 cookie、摘掉 `X-Frame-Options` / `CSP`、把 `Host` / `Origin` / `Referer` 改写成引擎认的权威——否则 `/api` 和 WebSocket 会 403；
3. 在 Harness 侧边栏底部注册按钮，点开就是覆盖整屏的 iframe（顶部有「刷新 / 新窗口 / 关闭」）。

## 环境要求

- DeepSeek Harness `>= 0.2.0-rc.1`
- Android 手机，装好 **DSH Go** 并让「设置 › 主机 › 本机引擎」处于运行中（`127.0.0.1:3080`）
- 电脑上有 `adb`（Android platform-tools），手机已授权 USB 调试；手机和电脑同一 Wi-Fi 也可以（`adb connect <手机 IP>:5555`）
- Node.js 22+（Harness 自带）

## 安装

### 方式一：市场索引（推荐）

Harness › 插件 › 管理索引源… › 添加：

    https://raw.githubusercontent.com/baidada1020/dsh-go-phone/main/catalog/index.json

然后在市场里搜 `dsh-go-phone` 安装，按提示重启 Harness。

### 方式二：手动放进 profile

    PKG=~/.dsh/profiles/desktop/node_modules/dsh-go-phone
    git clone https://github.com/baidada1020/dsh-go-phone "$PKG"

然后把包名加进 profile 的 `dsh.profile.bundles`（并加一条 `file:` 依赖）：

    node -e 'const fs=require("fs"),p=process.env.HOME+"/.dsh/profiles/desktop/package.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));j.dependencies=j.dependencies||{};j.dependencies["dsh-go-phone"]="file:./node_modules/dsh-go-phone";j.dsh=j.dsh||{};j.dsh.profile=j.dsh.profile||{};j.dsh.profile.bundles=j.dsh.profile.bundles||[];if(!j.dsh.profile.bundles.includes("dsh-go-phone"))j.dsh.profile.bundles.push("dsh-go-phone");fs.writeFileSync(p,JSON.stringify(j,null,2));'

然后完全退出并重开 Harness（macOS 上 ⌘Q，不是关窗口）。

> 插件包必须带 `dsh.bundle.patch`（见 `cordis.patch.yml`）。只有 `dsh.client` 不带 `dsh.bundle` 的包会被跳过，日志里会写
> `profile bundle "xxx" declares no dsh.bundle in its package.json`。

## 使用

1. 手机开 DSH Go，确认「本机引擎」运行中；
2. 侧边栏底部点 **📱 手机 DSH**；
3. 第一次会看到手机引擎的登录墙——按下节配置一次凭据即可，之后自动续期。

### 凭据（二选一）

网关需要一份「浏览器会话 cookie」才能代替你登录引擎。两种取法：

**A. 给个 token（通用、最稳）**

手机 DSH Go › 设置 › 主机 › 本机引擎 › 日志，能找到一行 `dsh web: http://127.0.0.1:3080/?token=...`（App 里可能给 token 打码，重开一次引擎或看「分享」导出的日志）。把它写成环境变量：

    DSHGO_TOKEN_URL='http://127.0.0.1:3080/?token=你的token'

**B. 什么都不配（仅限 DSH Go）**

插件会经手机端 inspector（`127.0.0.1:9230`）读 `~/.dsh/.credentials.yaml` 里的会话密钥，本地签一个 30 天的 cookie。手机端 inspector 没开或换了实现时这条会失效，此时请用 A。

环境变量都在启动 Harness 前设置，例如写进 `~/.zshrc`：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSHGO_TOKEN_URL` | 空 | 引擎登录链接或裸 token，用于换/续 cookie |
| `DSHGO_COOKIE` | 空 | 直接给 `dsh-auth-...=...` |
| `DSHGO_PROXY_PORT` | `13100` | 本地网关端口（改这里同时要改浏览器端 `localStorage.dshgo.gateway`） |
| `DSHGO_UPSTREAM_PORT` | `13080` | 本地 adb forward 端口 |
| `DSHGO_DEVICE_PORT` | `3080` | 手机引擎端口 |
| `DSHGO_SERIAL` | 自动 | 多设备时指定 serial |
| `DSHGO_ADB` | 自动探测 | adb 可执行路径 |
| `DSHGO_STATE_DIR` | `<tmp>/dsh-go-phone` | cookie 缓存目录 |

浏览器端网关地址可在控制台改：

    localStorage.setItem('dshgo.gateway', 'http://127.0.0.1:13100')

## 单独跑网关（排障用）

    node <插件目录>/gateway/server.mjs
    curl http://127.0.0.1:13100/__dshgo/health

`/__dshgo/health` 会回 `adb`、`serial`、`upstream`、`cookie`、`lastRefreshAt`，用来判断是「没连上手机」还是「只是要登录」。

## 常见问题

- **按钮点了是 502 / 连不上手机引擎**：手机没连上或引擎没跑。手动补一次转发 `adb forward tcp:13080 tcp:3080`，再刷新浮层。
- **页面能开但一直转圈、控制台 `/api/... 403`**：网关没在跑（端口被占用）或版本旧了。看 `curl /__dshgo/health`。
- **重启电脑后失效**：`adb` 的 forward 会随 adb server 重启消失，点一下插件会自动补；也可以先手动 `adb devices` 唤醒 adb server。
- **手机重启后 `adb` 连不上**：需要重新插 USB 授权调试，或 `adb connect <手机IP>:5555`。
- **iOS**：不适用，这个插件走的是 Android 的 `adb`。

## 原理与限制

- 手机端只提供一个 web 服务，没有「被外部连接」的开关；所以方向只能是「电脑嵌手机的界面」，不能反向把手机当 Harness 的远程主机加进 Remote 列表。
- 引擎重启会换会话密钥，cookie 会失效——网关遇到 401 会自动重新铸造（或按 token 重换），不用手动清缓存。
- 浮层里是完整的 Harness Web UI，键盘快捷键有些会和外层冲突（Esc 留给「关闭浮层」）。

## License

MIT
