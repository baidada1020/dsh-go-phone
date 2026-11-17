/**
 * dsh-go-phone — client half（浏览器模块，格式与 Harness 的模块加载器一致）。
 *
 * 在侧边栏底部注册「📱 手机 DSH」按钮；点开后全屏浮层，iframe 指向本地网关
 * （默认 http://127.0.0.1:13100，可用 localStorage 的 dshgo.gateway 覆盖）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-go-phone',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const SLOT = 'sidebar.footer.action'
    const DEFAULT_GATEWAY = 'http://127.0.0.1:13100'
    const STYLE_ID = 'dshgo-phone-style'
    const CLOSE_EVENT = 'dshgo-phone-close'

    const gatewayUrl = () => {
      try {
        return localStorage.getItem('dshgo.gateway') || DEFAULT_GATEWAY
      } catch (error) {
        return DEFAULT_GATEWAY
      }
    }

    const css = [
      '.dshgo-btn{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;border:0;background:transparent;color:inherit;font:inherit;border-radius:8px;cursor:pointer;text-align:left;white-space:nowrap;overflow:hidden}',
      '.dshgo-btn:hover{background:rgba(127,127,127,.16)}',
      '.dshgo-btn span{overflow:hidden;text-overflow:ellipsis}',
      '.dshgo-layer{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:#0b0d10}',
      '.dshgo-bar{display:flex;align-items:center;gap:10px;height:36px;padding:0 10px;background:#12151a;border-bottom:1px solid #22272f;color:#cfd6e4;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;flex:none}',
      '.dshgo-title{font-weight:600;color:#e8edf6;white-space:nowrap}',
      '.dshgo-url{color:#7f8b9f;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshgo-spacer{flex:1}',
      '.dshgo-bar button{border:1px solid #2b323c;background:#191d24;color:#cfd6e4;border-radius:6px;padding:3px 9px;font:inherit;cursor:pointer}',
      '.dshgo-bar button:hover{background:#222833}',
      '.dshgo-bar button.dshgo-close{border-color:#4a2530;color:#ff9aa6}',
      '.dshgo-frame{flex:1;width:100%;border:0;background:#0b0d10}',
    ].join(String.fromCharCode(10))

    const ensureStyle = () => {
      if (document.getElementById(STYLE_ID)) return
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = css
      document.head.append(tag)
    }

    const Frame = (props) => {
      const url = props.url
      const [nonce, setNonce] = React.useState(0)
      const close = () => window.dispatchEvent(new CustomEvent(CLOSE_EVENT))

      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') close() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])

      return h('div', { className: 'dshgo-layer' },
        h('div', { className: 'dshgo-bar' },
          h('div', { className: 'dshgo-title' }, '📱 手机 DSH Go'),
          h('div', { className: 'dshgo-url' }, url),
          h('div', { className: 'dshgo-spacer' }),
          h('button', { onClick: () => setNonce(nonce + 1), title: '重新加载' }, '刷新'),
          h('button', { onClick: () => window.open(url, '_blank', 'noopener'), title: '在浏览器标签页打开' }, '新窗口'),
          h('button', { className: 'dshgo-close', onClick: close, title: '关闭（Esc）' }, '关闭 ✕'),
        ),
        h('iframe', {
          key: nonce,
          className: 'dshgo-frame',
          src: url,
          title: 'DSH Go on phone',
          allow: 'clipboard-read; clipboard-write; microphone; camera',
        }),
      )
    }

    const FooterButton = () => {
      const [open, setOpen] = React.useState(false)
      const [url] = React.useState(gatewayUrl)

      React.useEffect(() => {
        const onClose = () => setOpen(false)
        window.addEventListener(CLOSE_EVENT, onClose)
        return () => window.removeEventListener(CLOSE_EVENT, onClose)
      }, [])

      if (!open) {
        return h('button', { className: 'dshgo-btn', onClick: () => setOpen(true), title: '打开手机上的 DSH Go 引擎' },
          h('span', null, '📱 手机 DSH'),
        )
      }

      return h(React.Fragment, null,
        h('button', { className: 'dshgo-btn', onClick: () => setOpen(false), title: '关闭手机 DSH' },
          h('span', null, '📱 手机 DSH'),
          h('span', { style: { opacity: 0.55 } }, '✕'),
        ),
        h(Frame, { url: url }),
      )
    }

    const apply = (ctx) => {
      ensureStyle()
      ctx.effect(() => () => {
        const tag = document.getElementById(STYLE_ID)
        if (tag) tag.remove()
      })
      ctx.effect(() =>
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            { name: SLOT, id: 'dshgo-phone-open', order: 40, label: '📱 手机 DSH' },
            (props) => h(FooterButton, props),
          ),
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
