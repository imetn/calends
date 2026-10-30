<p align="center">
  <img src="app/public/icons/logo.svg" width="96" height="96" alt="Calends" />
</p>

<h1 align="center">Calends · 订阅账本</h1>

<p align="center">
  在自己的服务器上记录订阅扣款、合租收款与预付余额。
</p>

<p align="center">
  <a href="https://calends.date">官网</a> ·
  <a href="https://demo.calends.date">在线演示</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#ai-与-mcp">AI 与 MCP</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <img src="docs/screenshots/overview.zh-CN.png" alt="Calends 概览" width="880" />
</p>
<p align="center"><sub>概览 · 虚构演示数据</sub></p>

---

## 计费与付款记录

花了多少、何时续费、谁还没付钱——Calends 把个人订阅、合租分摊和预付余额记在同一本单用户私密账本里，也支持按需开启只读公开页和 MCP 接入。

- **灵活的计费周期**：月付、年付、自定义周期和买断，支持试用、首期优惠、赠送时长、暂停、提前扣款与取消截止日。
- **订阅历程**：保留调价、换套餐、换区、断订和重叠时段，查看累计支出、实际月均费用与每笔扣款。
- **转让收付与拆分付款**：二手买入、卖出计入净成本，一笔扣款可由多个支付方式共同支付。
- **多币种记账**：历史扣款使用当日汇率，未来支出使用当前汇率，可切换显示币种。
- **余额与合租分摊**：管理预付余额和礼品卡，估算余额还能用多久，记录替朋友代付的费用。合租支持生效日收款规则、成员自定义收费、按期记账（可跳期收款、预收与免收）、逾期追踪与退出退款；成员弹窗以按月网格展示各期，点格查看收款，支持预收与免收；人员可设置私密头像、自选颜色和每辆车的独立成员账号。
- **报告与日历**：支出趋势、现金与权责对比、预付价值、退订节省、订阅体检和可分享的年度回顾；支持月历、年历与私密 ICS 订阅。
- **拼音搜索**：订阅列表、全局搜索和选择器支持中文全拼、首字母与混合拼音匹配。
- **续费提醒**：邮件、Telegram、飞书、钉钉、企业微信、Slack、Discord、Bark、ntfy、Server酱与自定义 Webhook。
- **AI 接入**：通过支持 MCP 助手查询和修改账本，令牌可限制权限，写入前可预览。
- **外部账本导入**：可在浏览器内预览并导入 Wallos 等外部账本的 CSV、ZIP 备份与数据库文件。
- **存储与访问**：密码与 Passkey 登录、设备远程下线、可选的服务端脱敏公开页、JSON 备份恢复和 CSV 导入导出，支持 14 种语言。

<details>
<summary>查看订阅时间轴</summary>

<p align="center">
  <img src="docs/screenshots/timeline.zh-CN.png" alt="Calends 订阅时间轴：计费时段、套餐变更与支付方式" width="880" />
</p>
<p align="center"><sub>计费时段与订阅历程 · 虚构演示数据</sub></p>

</details>

## 快速开始

可以先试用[在线演示](https://demo.calends.date)。演示账本由所有访客共用，每日重置，对外通知等功能不可用。

从 `/` 打开 Calends，在 `/login` 登录。登录后，`/` 跳转到设置中的启动页，默认是 `/overview`（概览）。在设置中开启公开页后，访客可通过 `/public` 查看只读账本。路由与登录回跳规则见[架构说明](ARCHITECTURE.md#web-requests-and-state)。

### Cloudflare Workers

使用 Workers 和 D1，可[一键部署](https://deploy.workers.cloudflare.com/?url=https://github.com/imetn/calends)，也可以从源码部署：

```bash
git clone https://github.com/imetn/calends
cd calends
npm ci
npx wrangler login
node scripts/wrangler.mjs secret put SETUP_TOKEN
npm run deploy
```

`SETUP_TOKEN` 请填写一串足够长的随机字符串。部署命令会构建应用、在首次部署时创建 D1 数据库并执行迁移。打开 `https://<你的 worker>.workers.dev/`，在登录页输入令牌并设置密码。

### Docker

直接运行预构建镜像：

```bash
docker run -d --name calends -p 8787:8787 -v calends-data:/data xizozhe/calends:latest
docker logs calends
```

打开 `http://localhost:8787/`，在登录页使用日志中的初始化令牌设置密码。命名卷 `calends-data` 将 SQLite 数据持久化到 `/data`。也可使用 `ghcr.io/imetn/calends:latest`。生产环境建议固定版本标签，如 `1.16.0`，而不是使用 `latest`。

也可以通过 Compose 从源码构建。在源码目录的 `docker/` 下执行，Compose 会使用仓库中的 [Dockerfile](docker/Dockerfile) 构建并启动应用：

```bash
cd docker
docker compose up -d --build
docker compose logs calends
```

[Compose 配置](docker/docker-compose.yml) 会通过挂载到 `/data` 的命名卷持久化 SQLite 数据。本地构建无需已发布的 Calends 镜像或 Cloudflare 账号。镜像仓库、升级与 Compose 用法见 [Docker 部署指南](docs/self-hosting.zh-CN.md#使用预构建镜像)。

公网访问时，通过反向代理启用 HTTPS，并设置 `TRUST_PROXY=1`。初始化后可在「设置 → 安全」中添加 Passkey。

自定义域名、配置项、邮件提醒、子路径部署，以及交给 AI 部署的提示词，见[自托管指南](docs/self-hosting.zh-CN.md)。

## AI 与 MCP

你可以问「下周有什么要续费」「今年一共花了多少」，也可以说「Netflix 从今天起涨到 17.99 美元」。Calends 在 `/mcp` 提供无状态的 [MCP](https://modelcontextprotocol.io) 接口，使用 Streamable HTTP，内置 34 个工具。

在 Calends 的「连接」页（`/connect`）创建只读或读写令牌，再接入客户端。浏览器打开 `/mcp` 会跳转到此页；MCP 客户端使用 `/mcp` 接口：

**Claude Code**

```bash
claude mcp add --transport http calends https://你的域名/mcp --header "Authorization: Bearer <令牌>"
```

**Codex**

```bash
export CALENDS_TOKEN='<令牌>'
codex mcp add calends --url https://你的域名/mcp --bearer-token-env-var CALENDS_TOKEN
```

启动 Codex 的环境中需要保留 `CALENDS_TOKEN`。工具涵盖订阅、支出、趋势、应收款和体检，也能修改价格、套餐、状态与付款记录。所有写操作都支持 `dry_run` 预览；可在设置中关闭 AI 连接。

## 参与贡献

欢迎提交问题、改进翻译或发起 Pull Request。本地开发、检查命令与贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

修改子系统前，请先阅读[AGENTS.md](AGENTS.md)、[架构说明](ARCHITECTURE.md)和[代码规范](docs/code-standards.md)。

技术栈为 React 19、Vite、HeroUI / React Aria、shadcn/ui，以及 Cloudflare Workers + D1（SQLite）。计费、汇率等领域逻辑位于 `shared/`，由浏览器和 Worker 共用。

翻译位于 `shared/locales/<locale>/<namespace>.json`，以英文和简体中文为源语言。

## 名字由来

Calends 是罗马历每个月的第一天，那天结清账目、收回欠款；英文的 calendar（日历）就由它而来。

## 许可

Calends 以 MIT 许可开源，详见 [LICENSE](LICENSE)。你可以使用、修改和分发它，包括用于商业用途，但须在软件副本或实质性部分中保留版权与许可声明。如果你 Fork Calends，请使用独立的项目名称，并注明 Calends 是上游来源，让用户能够区分你的版本与本项目。
