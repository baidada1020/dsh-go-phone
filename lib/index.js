/**
 * dsh-go-phone — host half.
 *
 * 作用：把手机上 DSH Go 的内置引擎（127.0.0.1:3080）经 adb 端口转发代理到本机
 * 127.0.0.1:13100，浏览器半边（./client）再用 iframe 把它铺在 Harness 里。
 *
 * 为什么不直接 iframe adb forward 出来的端口：
 *  1. 引擎挂浏览器会话 cookie，cookie 绑定 Host 权威（authority）；
 *  2. 引擎的 /api 与 ws 会校验 Origin 与 Host 同源，跨端口直连 403；
 *  3. iframe 内嵌要摘掉 x-frame-options / CSP。
 * 这些都归 gateway/server.mjs，本文件只负责按需把它拉起来。
 */
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const name = 'dsh-go-phone'
export const inject = []

const DEFAULT_PORT = 13100

function portInUse(port, host = '127.0.0.1', timeout = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const done = (value) => { socket.destroy(); resolve(value) }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

export function apply(ctx, config = {}) {
  const options = config && typeof config === 'object' ? config : {}
  const port = Number(options.port || process.env.DSHGO_PROXY_PORT || DEFAULT_PORT)
  const autoStart = options.autoStart !== false

  if (!autoStart) {
    ctx.logger?.info?.('dsh-go-phone: autoStart=false，网关需自行启动：node <pkg>/gateway/server.mjs')
    return
  }

  const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gateway', 'server.mjs')

  ctx.effect(() => {
    let child = null
    let stopped = false

    const boot = async () => {
      if (await portInUse(port)) {
        ctx.logger?.info?.('dsh-go-phone: 网关已在 127.0.0.1:' + port + ' 运行，跳过启动')
        return
      }
      if (stopped) return
      const env = {
        ...process.env,
        DSHGO_PROXY_PORT: String(port),
        ...(options.serial ? { DSHGO_SERIAL: String(options.serial) } : {}),
        ...(options.adbPath ? { DSHGO_ADB: String(options.adbPath) } : {}),
        ...(options.tokenUrl ? { DSHGO_TOKEN_URL: String(options.tokenUrl) } : {}),
        ...(options.devicePort ? { DSHGO_DEVICE_PORT: String(options.devicePort) } : {}),
        ...(options.inspectorPort ? { DSHGO_INSPECTOR_LOCAL_PORT: String(options.inspectorPort) } : {}),
      }
      child = spawn(process.execPath, [serverPath], { env, stdio: 'ignore', detached: false })
      child.on('error', (error) => ctx.logger?.warn?.('dsh-go-phone: 网关启动失败 ' + error.message))
      ctx.logger?.info?.('dsh-go-phone: 网关已启动 http://127.0.0.1:' + port + '/')
    }

    boot()

    return () => {
      stopped = true
      if (child && child.exitCode === null) child.kill()
    }
  })
}
