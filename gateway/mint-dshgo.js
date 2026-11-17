(() => {
  // 在手机端引擎进程里执行：读浏览器会话密钥，签一个绑定 __AUTHORITY__ 的 dsh-auth cookie。
  // 依赖 Node 22+ 的 process.getBuiltinModule，不需要任何 require。
  const fs = process.getBuiltinModule('node:fs')
  const crypto = process.getBuiltinModule('node:crypto')
  const LF = String.fromCharCode(10)
  const home = process.env.DSH_HOME || '/root/.dsh'
  const file = home + '/.credentials.yaml'
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split(LF)
  const start = lines.findIndex((line) => line.indexOf('browser-session:') !== -1)
  if (start === -1) throw new Error('credentials.yaml 里没有 browser-session 记录')
  const ownIndent = (lines[start].match(/^ +/) || [''])[0].length
  const block = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) { block.push(line); continue }
    const indent = (line.match(/^ +/) || [''])[0].length
    if (indent <= ownIndent) break
    block.push(line)
  }
  const secretMatch = block.join(LF).match(/secret: *"?([A-Za-z0-9_+/=-]+)"?/)
  if (!secretMatch) throw new Error('browser-session 记录里没有 secret')
  const b64url = (buffer) => Buffer.from(buffer).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const secret = Buffer.from(secretMatch[1], 'base64')
  const authority = '__AUTHORITY__'
  const now = Date.now()
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 30 * 24 * 3600 * 1000 }
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = b64url(crypto.createHmac('sha256', secret).update(body).digest())
  const name = 'dsh-auth-' + b64url(crypto.createHash('sha256').update(authority).digest())
  return JSON.stringify({ name, value: 'v1.' + body + '.' + signature })
})()
