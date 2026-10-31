# Weixin DeepSeek Bot

个人微信 iLink Bot：通过微信私聊与 DeepSeek 对话。运行在 Cloudflare Workers + SQLite Durable Object，不需要 NN6000、VPS 或电脑常驻。

## 当前功能

- 微信扫码登录 iLink Bot。
- Cloudflare Durable Object Alarm 持续轮询微信私聊。
- 将当前消息和近期对话历史发送到 DeepSeek Chat Completions API。
- 将 DeepSeek 回复发回微信。
- 只处理白名单中的私聊发送者；群聊和机器人自身消息会被忽略。
- 对话历史默认最多 30 轮、约 12000 字、24 小时；发送 `/new` 或 `/reset` 清空历史。
- 微信语音使用微信提供的转写文本。当前 DeepSeek 接入不会把图片作为视觉输入识别。

## Cloudflare 部署（适合 iPhone Safari）

1. 在 Cloudflare Dashboard 打开 **Workers & Pages**，选择创建 Worker / 连接 GitHub。
2. 授权 GitHub 后选择仓库 `aklancc/grokbot-weixin`，分支必须选择 `deepseek-cloudflare`，不要选 `main`。
3. 使用仓库中的 `wrangler.toml`。Worker 名称为 `wechat-ilink-deepseek`，Durable Object SQLite binding 和 migrations 已写在配置中。
4. 若使用 Cloudflare Workers Builds，安装命令使用 `npm ci`，部署命令使用 `npx wrangler deploy`。确保部署日志显示 Durable Object migrations 已应用。
5. 在 Worker 的 **Settings → Variables and Secrets** 中添加以下两个 **Secret**：
   - `DEEPSEEK_API_KEY`：DeepSeek API Key。
   - `BRIDGE_TOKEN`：一段自己生成的高强度随机密码，用于保护登录管理接口。
6. 触发一次新部署，让 Secret 生效。
7. 打开 `https://wechat-ilink-deepseek.<你的 workers.dev 子域>.workers.dev/login`，输入 `BRIDGE_TOKEN`，开始微信扫码登录。
8. 在微信中扫码并确认。登录成功后，iLink 返回的扫码用户 ID 会被加入白名单。
9. 给机器人发送一条私聊消息测试。成功时应收到 DeepSeek 回复。

## 安全注意事项

- 不要把 `DEEPSEEK_API_KEY` 或 `BRIDGE_TOKEN` 写入 GitHub、普通 Variables 或公开截图；必须使用 Cloudflare Secret。
- 本项目按个人账号使用设计。不会自动把任意第一个来信者加入白名单；若 iLink 登录响应没有提供扫码者 ID，机器人会保持不回复，避免陌生人抢先占用。
- 只处理私聊，不处理群聊。
- 如需检查状态，可访问 Worker 的 `/health`。健康信息只显示是否已登录、白名单数量及 DeepSeek 是否已配置，不显示密钥。
- DeepSeek API 按实际输入和输出 Token 计费；Cloudflare 使用量受账号计划限制。

## 本地检查

需要 Node.js 22：

```bash
npm ci
npm test
npm run build
```

`npm run build` 会执行 Node 类型检查、Worker 类型检查和 Wrangler dry-run。真实微信扫码与线上 iLink 长轮询必须部署后验证。

## 技术说明

iLink 协议实现参考腾讯开源的 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）；本仓库为独立实现，不运行 OpenClaw。Cloudflare Worker 使用一个 SQLite Durable Object 保存登录状态、白名单、轮询游标和对话历史。
