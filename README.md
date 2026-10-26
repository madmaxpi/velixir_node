# velixir-xray-node

Node.js 源码包，部署到 velixir 免费应用上跑 Xray 的 VLESS + WS + TLS。

## 原理

- velixir 对外提供 `https://<app>.velixir.run` 并终结 TLS，容器内只收到明文 HTTP/WS。
- `server.js` 监听平台注入的 `$PORT`：
  - `GET /` 返回 `ok`；
  - `GET <WS_PATH>` 返回 `400`，这就是“活了”的拨测信号；
  - `GET /sub` 返回 base64 编码的单条 VLESS 链接（订阅内容），订阅地址就是 `https://<app>.velixir.run/sub`；
  - WebSocket 升级请求（路径等于 `WS_PATH`）原样转发给本地 Xray。
- 启动时用 Node 内置 `https` 下载 Xray 官方 zip，用内置 `zlib` 解析 zip（central directory + inflateRaw），不依赖容器里的 `unzip` / `python3`。
- 本地 Xray 只监听 `127.0.0.1:<XRAY_PORT>`，不直接对外。

## 环境变量（在 velixir 控制台里填）

- `UUID`：VLESS 用户 ID，部署时生成一个，不要和别人共用。
- `WS_PATH`：WebSocket 路径，例如以 `/` 开头的一段路径。
- `PORT`：平台注入的监听端口，一般不用手动改，代码读的就是它。
- 可选：`XRAY_PORT`（默认 18081，容器内端口）、`XRAY_VERSION`（默认 v26.10.21）、`XRAY_URL`、`NODE_NAME`（订阅里显示的名字）。

## 订阅链接格式

```
vless://<UUID>@<app>.velixir.run:443?encryption=none&security=tls&sni=<app>.velixir.run&type=ws&host=<app>.velixir.run&path=<WS_PATH>#<名字>
```

订阅地址：`https://<app>.velixir.run/sub`（内容为上面这条链接的 base64）。

## 限制

- 免费档 15 分钟无请求会休眠，休眠后首次请求需要唤醒。
- 只给自己用，不要公开分享订阅；平台若判定为公开代理可能停用应用。
