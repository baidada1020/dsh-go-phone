/**
 * 极简 CDP 客户端（零依赖）：只做一件事——连上手机端 inspector，执行一段表达式，拿回 JSON。
 *
 * 为什么不用 Node 自带的 WebSocket：dsh 的 inspector 只接受原始握手（自带的 undici 客户端
 * 会被判成非 101）。所以这里手写 HTTP Upgrade + 单帧收发。
 */
import net from 'node:net'
import crypto from 'node:crypto'

const CRLF = String.fromCharCode(13, 10)
const LF = String.fromCharCode(10)

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const mask = crypto.randomBytes(4)
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4]
  const head = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : payload.length < 65536
      ? Buffer.concat([Buffer.from([0x81, 0x80 | 126]), Buffer.from([payload.length >> 8, payload.length & 0xff])])
      : Buffer.concat([Buffer.from([0x81, 0x80 | 127]), (() => {
        const b = Buffer.alloc(8)
        b.writeBigUInt64BE(BigInt(payload.length))
        return b
      })()])
  return Buffer.concat([head, mask, masked])
}

function decodeFrames(buffer) {
  const messages = []
  let offset = 0
  while (buffer.length - offset >= 2) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (buffer.length - cursor < 2) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break
      length = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }
    let maskKey = null
    if (masked) {
      if (buffer.length - cursor < 4) break
      maskKey = buffer.subarray(cursor, cursor + 4)
      cursor += 4
    }
    if (buffer.length - cursor < length) break
    let payload = buffer.subarray(cursor, cursor + length)
    if (maskKey) {
      const copy = Buffer.alloc(length)
      for (let i = 0; i < length; i += 1) copy[i] = payload[i] ^ maskKey[i % 4]
      payload = copy
    }
    offset = cursor + length
    if (opcode === 0x8) { messages.push({ close: true }); break }
    if (opcode === 0x1 || opcode === 0x0) messages.push({ text: payload.toString('utf8'), fin })
  }
  return { messages, rest: buffer.subarray(offset) }
}

async function findPageTarget(port, timeoutMs) {
  const response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(timeoutMs) })
  const list = await response.json()
  const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
  if (!page) throw new Error('inspector 上没有 page target')
  return page
}

export async function evaluate(port, expression, options = {}) {
  const timeoutMs = options.timeoutMs || 20000
  const target = await findPageTarget(port, timeoutMs)
  const url = new URL(target.webSocketDebuggerUrl)
  const key = crypto.randomBytes(16).toString('base64')

  return await new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    let buffer = Buffer.alloc(0)
    let open = false
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* 已断开 */ }
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('CDP 超时')), timeoutMs)
    timer.unref?.()

    socket.on('connect', () => {
      socket.write([
        'GET ' + url.pathname + ' HTTP/1.1',
        'Host: 127.0.0.1:' + port,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + key,
        'Sec-WebSocket-Version: 13',
        '', '',
      ].join(CRLF))
    })

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!open) {
        const end = buffer.indexOf(Buffer.from(CRLF + CRLF))
        if (end === -1) return
        const head = buffer.subarray(0, end).toString('latin1')
        if (!/^HTTP\/1\.1 101/.test(head)) {
          finish(new Error('inspector 拒绝升级：' + head.split(CRLF)[0]))
          return
        }
        open = true
        buffer = buffer.subarray(end + 4)
        socket.write(encodeFrame(JSON.stringify({ id: 1, method: 'Runtime.enable' })))
        socket.write(encodeFrame(JSON.stringify({
          id: 2,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        })))
      }
      if (!open) return
      const { messages, rest } = decodeFrames(buffer)
      buffer = rest
      for (const message of messages) {
        if (message.close) { finish(new Error('inspector 关闭了连接')); return }
        if (!message.text) continue
        let parsed
        try { parsed = JSON.parse(message.text) } catch { continue }
        if (parsed.id !== 2) continue
        clearTimeout(timer)
        if (parsed.error) { finish(new Error(parsed.error.message || 'Runtime.evaluate 失败')); return }
        const result = parsed.result?.result
        const value = result?.value !== undefined ? result.value : result?.description
        finish(null, value)
        return
      }
    })

    socket.on('error', (error) => finish(error))
    socket.on('close', () => finish(new Error('inspector 连接关闭')))
  })
}

export { LF }
