# dsh-go-phone 📱

Adds a **📱 手机 DSH** button to the DeepSeek Harness sidebar footer. Click it and the DSH engine running inside the DSH Go Android app opens full-screen inside the desktop Harness — same conversations, workspaces, attachments and plugins, no phone in hand.

The phone stays the host; the desktop is just a screen. Nothing goes through a third-party server — it is all local `adb` port forwarding.

## What it does

DSH Go runs a Harness engine on the phone at `127.0.0.1:3080`. This plugin:

1. forwards that port to the desktop with `adb forward`;
2. runs a small local gateway (`127.0.0.1:13100`) that injects the browser-session cookie, strips `X-Frame-Options` / `CSP`, and rewrites `Host` / `Origin` / `Referer` to the authority the engine accepts (otherwise `/api` and WebSocket calls return 403);
3. registers a sidebar footer button that opens the engine in a full-screen iframe.

## Requirements

- DeepSeek Harness `>= 0.2.0-rc.1`
- Android phone with **DSH Go** installed and its built-in engine running (`127.0.0.1:3080`)
- `adb` on the desktop, USB debugging authorized (or `adb connect <phone-ip>:5555` over the same Wi-Fi)
- Node.js 22+ (bundled with Harness)

## Install

Add this index under *Plugins › Manage indexes…*:

    https://cdn.jsdelivr.net/gh/baidada1020/dsh-go-phone@main/catalog/index.json

Then install `dsh-go-phone` from the market and restart Harness. A manual install (clone into `~/.dsh/profiles/desktop/node_modules/dsh-go-phone`, then add it to `dsh.profile.bundles` in that profile's `package.json`) is described in `README.zh.md`.

## Auth

The engine requires a browser-session cookie. Either give the plugin the engine login link / raw token as `DSHGO_TOKEN_URL`, or let it sign a cookie itself by reading the session secret from the phone's `.dsh/.credentials.yaml` over the engine inspector port (DSH Go only). Cookies are cached and refreshed automatically on 401.

See `README.zh.md` for the full environment-variable table and troubleshooting.

## License

MIT
