#!/usr/bin/env node
/**
 * dsh-go-phone 本地网关：把手机上的 DSH 引擎（adb forward 出来的 127.0.0.1:13080）包一层。
 *
 *  - 注入浏览器会话 cookie，用户不用手抄 engine token
 *  - 摘掉 X-Frame-Options / CSP，允许在 Harness 里 iframe 内嵌
 *  - 改写 Host / Origin / Referer，否则上游 /api 与 ws 返回 403
 *  - 透传 WebSocket
 *  - cookie 过期自动续：优先按 DSHGO_TOKEN_URL 换，其次经手机 inspector 重新铸造
 *
 * 环境变量：
 *  DSHGO_PROXY_PORT            本地监听端口，默认 13100
 *  DSHGO_UPSTREAM_PORT         本地 adb forward 端口，默认 13080
 *  DSHGO_DEVICE_PORT           手机上的引擎端口，默认 3080
 *  DSHGO_UPSTREAM_AUTHORITY    上游权威，默认 127.0.0.1:<DEVICE_PORT>
 *  DSHGO_SERIAL                设备 serial，留空自动取第一台
 *  DSHGO_ADB                   adb 可执行文件路径，留空自动探测
 *  DSHGO_TOKEN_URL             可选：引擎登录链接或裸 token（用它在 cookie 过期时换 cookie）
 *  DSHGO_COOKIE                可选：直接给 dsh-auth-... 的 cookie 值
 *  DSHGO_STATE_DIR             可选：cookie 缓存目录，默认 <tmp>/dsh-go-phone
 *  DSHGO_INSPECTOR_PORT        手机端 inspector 端口，默认 9230
 *  DSHGO_INSPECTOR_LOCAL_PORT  本地 inspector 转发端口，默认 19230
 */
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LF = String.fromCharCode(10)
const CRLF = String.fromCharCode(13, 10)

const LISTEN_HOST = process.env.DSHGO_LISTEN_HOST || '127.0.0.1'
const LISTEN_PORT = Number(process.env.DSHGO_PROXY_PORT || 13100)
const UPSTREAM_HOST = '127.0.0.1'
const UPSTREAM_PORT = Number(process.env.DSHGO_UPSTREAM_PORT || 13080)
const DEVICE_PORT = Number(process.env.DSHGO_DEVICE_PORT || 3080)
const AUTHORITY = process.env.DSHGO_UPSTREAM_AUTHORITY || ('127.0.0.1:' + DEVICE_PORT)
const INSPECTOR_DEVICE_PORT = Number(process.env.DSHGO_INSPECTOR_PORT || 9230)
const INSPECTOR_LOCAL_PORT = Number(process.env.DSHGO_INSPECTOR_LOCAL_PORT || 19230)
const TOKEN_URL = (process.env.DSHGO_TOKEN_URL || '').trim()
const STATE_DIR = process.env.DSHGO_STATE_DIR || path.join(os.tmpdir(), 'dsh-go-phone')
const COOKIE_FILE = path.join(STATE_DIR, 'cookie')
const UPSTREAM_ORIGIN = 'http://' + AUTHORITY

const DROP_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
])

function log(...args) { console.log('[dsh-go-phone]', ...args) }
function logErr(...args) { console.error('[dsh-go-phone]', ...args) }

function resolveAdb() {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb'
  const candidates = [
    process.env.DSHGO_ADB,
    process.env.ADB,
    process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, 'platform-tools', exe) : '',
    process.env.ANDROID_SDK_ROOT ? path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', exe) : '',
    path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'platform-tools', exe),
    path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', exe),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    '/usr/bin/adb',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate } catch { /* 忽略 */ }
  }
  return exe
}

const ADB = resolveAdb()
let SERIAL = (process.env.DSHGO_SERIAL || '').trim()

function adbRun(args) {
  return execFileSync(ADB, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
}

function detectSerial() {
  if (SERIAL) return SERIAL
  try {
    const lines = adbRun(['devices']).split(LF).map((line) => line.trim()).filter(Boolean)
    for (const line of lines) {
      if (line.startsWith('List of devices')) continue
      if (!line.endsWith('device')) continue
      const head = line.split(LF)[0].split(String.fromCharCode(9))[0].split(' ')[0]
      if (head) { SERIAL = head; return SERIAL }
    }
  } catch (error) {
    logErr('adb devices 失败:', error.message)
  }
  return SERIAL
}

function forwardLines() {
  try { return adbRun(['forward', '--list']) } catch { return '' }
}

const FORWARD_TTL = 4000
const forwardedAt = new Map()

function ensureForward(local, remote, force) {
  const spec = 'tcp:' + local + ' tcp:' + remote
  const now = Date.now()
  const recent = forwardedAt.get(spec) || 0
  if (!force && now - recent < FORWARD_TTL) return true
  try {
    if (!forwardLines().includes(spec)) {
      const args = []
      const serial = detectSerial()
      if (serial) args.push('-s', serial)
      args.push('forward', 'tcp:' + local, 'tcp:' + remote)
      adbRun(args)
      log('adb forward', spec, 'ok')
    }
    forwardedAt.set(spec, now)
    return true
  } catch (error) {
    logErr('adb forward ' + spec + ' 失败:', error.message)
    return false
  }
}

// ---------------------------------------------------------------- cookie

let cookie = (process.env.DSHGO_COOKIE || '').trim()
let lastRefreshAt = 0
let refreshing = null

function loadCookie() {
  if (cookie) return cookie
  try { cookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim() } catch { /* 没有缓存 */ }
  return cookie
}

function saveCookie(value) {
  cookie = value
  lastRefreshAt = Date.now()
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(COOKIE_FILE, value, { mode: 0o600 })
  } catch (error) {
    logErr('cookie 缓存写入失败:', error.message)
  }
}

/** 用引擎登录链接（或裸 token）换浏览器会话 cookie。这是与设备无关的通用路线。 */
async function harvestFromToken() {
  if (!TOKEN_URL) throw new Error('未配置 DSHGO_TOKEN_URL')
  ensureForward(UPSTREAM_PORT, DEVICE_PORT, true)
  let token = TOKEN_URL
  if (token.indexOf('token=') !== -1) {
    token = token.split('token=')[1].split('&')[0]
  }
  const url = UPSTREAM_ORIGIN.replace(AUTHORITY, '127.0.0.1:' + UPSTREAM_PORT) + '/?token=' + encodeURIComponent(decodeURIComponent(token))
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) })
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
  const pairs = raw.map((item) => item.split(';')[0]).filter((item) => item.startsWith('dsh-auth-'))
  if (!pairs.length) throw new Error('上游没有下发 dsh-auth cookie（HTTP ' + response.status + '）')
  saveCookie(pairs.join('; '))
  log('cookie 已用 token 换到')
  return cookie
}

/** DSH Go 专用兜底：经手机 inspector 读会话密钥，自己签一个 cookie。 */
async function mintFromDevice() {
  const template = path.join(HERE, 'mint-dshgo.js')
  if (!fs.existsSync(template)) throw new Error('缺少 mint-dshgo.js')
  if (!ensureForward(INSPECTOR_LOCAL_PORT, INSPECTOR_DEVICE_PORT, true)) {
    throw new Error('adb forward 失败，连不上设备 inspector')
  }
  const expression = fs.readFileSync(template, 'utf8').split('__AUTHORITY__').join(AUTHORITY)
  const { evaluate } = await import('./cdp.mjs')
  const raw = await evaluate(INSPECTOR_LOCAL_PORT, expression, { timeoutMs: 25000 })
  const parsed = JSON.parse(String(raw))
  if (!parsed || !parsed.name || !parsed.value) throw new Error('铸造结果无效')
  saveCookie(parsed.name + '=' + parsed.value)
  log('cookie 已在设备上重新铸造于', new Date(lastRefreshAt).toISOString())
  return cookie
}

function refreshCookie() {
  if (refreshing) return refreshing
  refreshing = (async () => {
    const errors = []
    try { return await harvestFromToken() } catch (error) { errors.push('token: ' + error.message) }
    try { return await mintFromDevice() } catch (error) { errors.push('mint: ' + error.message) }
    throw new Error(errors.join(' / '))
  })().finally(() => { refreshing = null })
  return refreshing
}

// ---------------------------------------------------------------- proxy

function upstreamHeaders(raw) {
  const headers = { ...raw, host: AUTHORITY }
  if (cookie) headers.cookie = cookie
  if (headers.origin !== undefined) headers.origin = UPSTREAM_ORIGIN
  if (String(headers['sec-fetch-site'] || '') === 'cross-site') delete headers['sec-fetch-site']
  if (headers.referer !== undefined) headers.referer = UPSTREAM_ORIGIN + '/'
  return headers
}

function sendText(res, status, text) {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(text + LF)
}

function pipeUpstream(req, res, retried) {
  let upstream
  try {
    upstream = http.request({
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req.headers),
    }, (upstreamRes) => {
      const status = upstreamRes.statusCode || 502
      if (status === 401 && !retried) {
        upstreamRes.resume()
        refreshCookie()
          .then(() => pipeUpstream(req, res, true))
          .catch((error) => {
            logErr('cookie 续期失败:', error.message)
            sendText(res, 401, 'dsh-go-phone: 手机引擎要登录，cookie 续期失败（' + error.message + '）。设置 DSHGO_TOKEN_URL 更稳。')
          })
        return
      }
      const headers = {}
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (DROP_HEADERS.has(key.toLowerCase())) continue
        headers[key] = value
      }
      res.writeHead(status, headers)
      upstreamRes.pipe(res)
    })
  } catch (error) {
    sendText(res, 502, 'dsh-go-phone: ' + error.message)
    return
  }
  upstream.on('error', (error) => {
    logErr('上游错误:', error.message)
    sendText(res, 502, [
      'dsh-go-phone: 连不上手机引擎（' + error.message + '）',
      '',
      '检查清单：',
      '1. 手机连着 USB 或同一 Wi-Fi，adb devices 能看到设备',
      '2. 手机上 DSH Go 的「本机引擎」是运行中',
      '3. 手动补一次转发：' + ADB + ' forward tcp:' + UPSTREAM_PORT + ' tcp:' + DEVICE_PORT,
    ].join(LF))
  })
  req.pipe(upstream)
}

const server = http.createServer((req, res) => {
  if (req.url === '/__dshgo/health') {
    ensureForward(UPSTREAM_PORT, DEVICE_PORT)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify({
      ok: true,
      adb: ADB,
      serial: SERIAL || null,
      upstream: AUTHORITY,
      forward: UPSTREAM_PORT + '->' + DEVICE_PORT,
      cookie: cookie ? 'yes' : 'no',
      tokenUrl: TOKEN_URL ? 'yes' : 'no',
      lastRefreshAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null,
    }, null, 2))
    return
  }
  ensureForward(UPSTREAM_PORT, DEVICE_PORT)
  pipeUpstream(req, res, false)
})

server.on('upgrade', (req, socket, head) => {
  ensureForward(UPSTREAM_PORT, DEVICE_PORT)
  const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    const headers = upstreamHeaders(req.headers)
    const lines = [req.method + ' ' + req.url + ' HTTP/1.1']
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(key + ': ' + item)
      else if (value !== undefined) lines.push(key + ': ' + value)
    }
    upstream.write(lines.join(CRLF) + CRLF + CRLF)
    if (head && head.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    log('端口 ' + LISTEN_PORT + ' 已被占用，认为网关已在运行，退出')
    process.exit(0)
  }
  logErr('服务启动失败:', error.message)
  process.exit(1)
})

setInterval(() => {
  ensureForward(UPSTREAM_PORT, DEVICE_PORT, true)
  const probe = http.request({ host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: '/', headers: upstreamHeaders({}) }, (response) => {
    response.resume()
    if (response.statusCode === 401) refreshCookie().catch((error) => logErr('探活续期失败:', error.message))
  })
  probe.on('error', () => {})
  probe.end()
}, 300000).unref()

loadCookie()
ensureForward(UPSTREAM_PORT, DEVICE_PORT)
detectSerial()

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log('http://' + LISTEN_HOST + ':' + LISTEN_PORT + '/  ->  ' + AUTHORITY + '（设备 ' + (SERIAL || 'auto') + '）')
  if (!cookie) {
    refreshCookie().catch((error) => logErr('初始 cookie 获取失败:', error.message))
  }
})
