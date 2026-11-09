# Calends 自托管指南

[← README](../README.zh-CN.md) · [English](self-hosting.md)

首次部署请先看 [Cloudflare 或 Docker 快速开始](../README.zh-CN.md#快速开始)。本指南说明初始化之后的配置和其他部署选项。

从 `/` 打开 Calends，在 `/login` 登录。登录后，`/` 跳转到设置中的启动页，默认是 `/overview`（概览）。在设置中开启公开页后，访客可通过 `/public` 查看只读账本。路由与登录回跳规则见[架构说明](../ARCHITECTURE.md#web-requests-and-state)。 初始化后可在「设置 → 安全」中添加 Passkey。

## 从源码部署 Cloudflare

```bash
git clone https://github.com/imetn/calends
cd calends
npm ci
npx wrangler login
node scripts/wrangler.mjs secret put SETUP_TOKEN
npm run deploy
```

`SETUP_TOKEN` 请填写一串足够长的随机字符串。部署命令会构建应用、在首次部署时创建 D1 数据库并执行迁移。打开 `https://<你的 worker>.workers.dev/`，在登录页输入令牌并设置密码。

## 使用预构建镜像

无需克隆源码或本地构建，直接拉取并运行：

```bash
docker pull xizozhe/calends:latest
docker run -d --name calends --restart unless-stopped -p 8787:8787 -v calends-data:/data xizozhe/calends:latest
docker logs calends
```

打开 `http://localhost:8787/`，在登录页使用日志中的初始化令牌设置密码。命名卷 `calends-data` 持久化整个 `/data`，包括 SQLite 数据库状态与自动生成的初始化令牌，无需 Cloudflare 账号。

生产环境建议固定完整版本标签，如 `xizozhe/calends:1.31.0`，升级时再主动修改。`latest` 跟随 main 分支，`1.30` 跟随该次版本系列的发布；这类浮动标签方便更新，但不锁定某次发布。以下命令中的 `xizozhe/calends` 也可替换为 `ghcr.io/imetn/calends`。

如果用的是[快速开始里的 Compose 文件](../README.zh-CN.md#docker)，升级执行 `docker compose pull && docker compose up -d`。

使用 `latest` 部署时，先拉取新版镜像，再用同一数据卷重建容器：

```bash
docker pull xizozhe/calends:latest
docker stop calends
docker rm calends
docker run -d --name calends --restart unless-stopped -p 8787:8787 -v calends-data:/data xizozhe/calends:latest
docker logs calends
```

删除容器会保留命名数据卷。重建时复用原数据卷，以及原部署的环境变量、重启策略等参数。使用固定版本时，将 `docker pull` 和 `docker run` 中的标签都改为目标版本。

### 镜像仓库

从 v1.1.0 起，预构建镜像已同时发布到以下两处，均可匿名拉取，无需 `docker login`：

- Docker Hub：`xizozhe/calends`（等同于 `docker.io/xizozhe/calends`）。
- GitHub Container Registry（GHCR）：`ghcr.io/imetn/calends`。

两处均提供 `linux/amd64` 和 `linux/arm64` 多架构镜像。[镜像工作流](../.github/workflows/docker.yml) 为 main 分支构建发布 `latest`，为版本发布生成版本标签，例如 `v1.31.0` 对应 `1.31.0` 和 `1.30`。

从源码构建不依赖已发布的 Calends 镜像，但仍需下载基础镜像与构建依赖。

## 从源码部署 Docker

仓库已包含 [Dockerfile](../docker/Dockerfile) 和 [Compose 配置](../docker/docker-compose.yml)。在源码目录中执行：

```bash
cd docker
docker compose up -d --build
docker compose logs calends
```

Compose 会构建 `calends:local`，在 8787 端口启动服务，并用命名卷 `calends_calends-data` 持久化 `/data`。打开 `http://localhost:8787/`，在登录页使用日志中的初始化令牌设置密码。取得新版源码后，在 `docker/` 下再运行 `docker compose up -d --build` 即可重建并更新。`docker compose down` 保留数据卷；`docker compose down -v` 会删除账本数据卷。

仓库中的 `docker/docker-compose.yml` 从源码构建。要使用预构建镜像，改用 [`docker/compose.prebuilt.yml`](../docker/compose.prebuilt.yml)。

也可改用 `ghcr.io/imetn/calends:latest`，或固定 `1.31.0` 等版本标签。在 `docker/` 下依次运行 `docker compose -f compose.prebuilt.yml pull` 和 `docker compose -f compose.prebuilt.yml up -d`，即可启动或升级此配置。镜像变化时，Compose 会重建容器并保留 `calends_calends-data` 数据卷。

不使用 Compose 时，也可以在仓库根目录直接构建和运行：

```bash
docker build -f docker/Dockerfile -t calends:local .
docker run -d --name calends --restart unless-stopped -p 8787:8787 \
  -v calends-data:/data calends:local
docker logs calends
```

一次部署选择一种方式：Compose 使用数据卷 `calends_calends-data`，`docker run` 示例使用 `calends-data`，切换方式时需核对。

镜像在单个 Node 进程里运行同一套 Worker，以 SQLite 存储数据。启动时执行迁移，每 15 分钟运行一次定时任务（与 Cloudflare 上的定时一致），无需 Cloudflare 账号。

通常账本内存占用约 100–150 MB，空闲 CPU 占用接近零。这些是测试环境的观察值，不保证适用于所有负载；尚未在真实 1 核 1 GB VPS 上验证长期运行。Compose 默认容器内存上限为 512 MB。JavaScript 堆上限为 192 MB，可恢复不超过 20 MB 的备份。如需调整堆上限，设置 `NODE_OPTIONS`，并保留 `--disable-warning=ExperimentalWarning`。构建镜像比运行镜像耗内存得多，小内存服务器请直接使用预构建镜像。升级时数据原地保留；只要数据库结构没有超过旧版本，在同一数据卷上运行旧版本标签即可回退。

请求体上限为：登录接口 64 KB，备份、导入与助手对话 20 MB，其余 4 MB。声明超过上限的请求返回 413。旧的 `INTERNAL_PORT` 配置不再使用，`PORT` 是唯一监听端口。

如果数据库不见了，而 `/data` 里还有其他数据库或 `setup-token` 文件，容器会拒绝启动并反复重启，原因写在 `docker logs` 里。这通常说明数据卷或 `DATA_DIR` 变了，请改回正确的挂载；确实要重新开始，把 `setup-token` 一并删除。

请持久化整个 `/data`，其中包含数据库状态与自动生成的初始化令牌。前端构建不包含 `local/` 中的个人文件。

## 不用 Docker（systemd）

Debian 和 Ubuntu 一条命令安装，自带一份 Node，并在 `127.0.0.1:8787` 启动。反向代理指向这个端口即可：

```bash
curl -fsSL https://calends.date/install.sh | sudo bash
```

升级也运行这条命令：先备份数据，配置不动，新版本起不来时自动恢复旧版本和数据。`--version 1.31.0` 安装指定版本，`--uninstall` 只删程序，保留数据和配置。想先看脚本内容，可以下载后用 `sudo bash install.sh` 运行。

本节后面是同样的手动安装步骤，适用于其他发行版。

小内存 VPS 可以不装 Docker。从 1.26.0 起，每个版本的 [Release](https://github.com/imetn/calends/releases) 附带一个压缩包，运行代码和镜像相同，不需要安装 npm 依赖，x86 和 ARM 通用。需要 Linux、systemd 和系统级安装的 Node 24（`node -v` 确认）；装在用户目录的 Node（如 nvm）服务读不到。

```bash
VERSION=1.31.0
curl -fLO https://github.com/imetn/calends/releases/download/v$VERSION/calends-$VERSION.tar.gz
curl -fLO https://github.com/imetn/calends/releases/download/v$VERSION/calends-$VERSION.tar.gz.sha256
sha256sum -c calends-$VERSION.tar.gz.sha256
sudo mkdir -p /opt/calends
sudo tar -xzf calends-$VERSION.tar.gz -C /opt/calends --strip-components=1 --no-same-owner
sudo cp /opt/calends/calends.service /etc/systemd/system/
sudo systemctl daemon-reload
```

从 Docker 迁移时，这里先复制数据（`calends` 换成你的容器名），并把容器的环境变量写进下面说的 `/etc/calends.env`；数据已经写过的服务不能这样覆盖。子路径部署不能迁移。全新安装跳过这一步：

```bash
sudo docker stop calends
sudo mkdir -p -m 700 /var/lib/private
sudo docker cp calends:/data/. /var/lib/private/calends/
```

然后启动：

```bash
sudo systemctl enable --now calends
sudo journalctl -u calends -n 20
```

首次设置密码前不要让令牌和密码明文经过公网：先用 `ssh -L 8787:localhost:8787 用户@服务器` 转发，再打开 `http://localhost:8787/`，用日志里的初始化令牌设置密码。数据在 `/var/lib/calends`，内存上限 512MB，进程异常退出后自动重启。

[配置项](#配置项)里的环境变量写到 `/etc/calends.env`（每行 `名称=值`，用 `sudo chmod 600` 保护），再执行 `sudo systemctl restart calends`。放在反向代理后面时写 `HOST=127.0.0.1`。`DATA_DIR` 不要改，`PORT` 要大于 1024。压缩包按根路径构建；要部署到子路径请用 Docker。

升级和回滚都是换目录里的代码，数据不用动。回滚只能回到数据库结构没有超过该版本的版本，操作前先在设置里导出备份。把 `VERSION` 换成要安装的版本号，下载并校验压缩包，再执行：

```bash
sudo systemctl stop calends
sudo rm -rf /opt/calends
sudo mkdir -p /opt/calends
sudo tar -xzf calends-$VERSION.tar.gz -C /opt/calends --strip-components=1 --no-same-owner
sudo cp /opt/calends/calends.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start calends
```

## 配置项

Cloudflare 的变量和绑定写在 Wrangler 配置中，凭据使用 secret。Docker 支持的环境变量通过 `-e` 或 Compose 传入。

| 配置项                                 | Cloudflare     | Docker                   | 用途                                                                                                                                        |
| -------------------------------------- | -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `SETUP_TOKEN`                          | Secret         | 环境变量；不设时自动生成 | 新部署首次设置密码时使用。                                                                                                                  |
| `SITE_URL`                             | 变量           | 环境变量                 | 提醒和日历链接使用的站点地址；不设时自动识别。                                                                                              |
| `TRUST_PROXY`                          | —              | 环境变量                 | 通常不用设。`off` 表示不读 `X-Forwarded-For`；逗号分隔的 IP 或 CIDR 用来追加信任的代理，比如其他 CDN。见[自定义域名](#自定义域名与-https)。 |
| `EMAIL`、`MAIL_FROM`、`MAIL_FROM_NAME` | 邮件绑定与变量 | 镜像入口未配置           | 可选的邮件发送配置，见下文。其他通知渠道在应用内设置。                                                                                      |
| `OLD_HOSTS`                            | 变量           | 镜像入口未透传           | 逗号分隔的旧域名。设置 `SITE_URL` 后，旧域名的页面以 HTTP 301 跳转到新站；API、MCP 和日历订阅保持可用。                                     |
| `BASE_PATH`                            | 变量           | 构建参数和环境变量       | 可选子路径（如 `/calends`，不带结尾斜杠），构建与运行时须一致，见[子路径部署](#子路径部署)。                                                |
| `DATA_DIR`                             | —              | 环境变量                 | SQLite 数据目录，默认 `/data`，需挂载持久化卷。                                                                                             |
| `PORT`                                 | —              | 环境变量                 | 监听端口，默认 `8787`。                                                                                                                     |
| `HOST`                                 | —              | 环境变量                 | 监听地址，默认 `0.0.0.0`。不用 Docker 时可在反向代理后设为 `127.0.0.1`；Docker 用 `-p 127.0.0.1:8787:8787`，不要改它。                      |

### Cloudflare 个人配置

部署相关的个人配置默认放在被 Git 忽略的 `local/` 目录中：

- `local/wrangler.jsonc`：自己的域名、数据库 ID、发件地址等 Wrangler 配置；文件存在时，npm 脚本会自动使用它。
- `local/public/`：自己的图标等静态资源；构建时覆盖 `app/public/` 中的同名文件。

使用 `local/wrangler.jsonc` 部署时，通过与 npm 脚本相同的封装设置密钥，确保配置一致：

```bash
node scripts/wrangler.mjs secret put SETUP_TOKEN
```

设置 `CALENDS_LOCAL` 可将这些文件放在仓库外。它接受绝对路径或相对于仓库根目录的路径；未设置或为空时仍使用 `local/`。Wrangler 配置与 `public/` 静态资源覆盖均使用该目录，本地开发时同样生效。

例如，将仓库检出为 `calends`，使用以下目录结构：

```text
workspace/
├── calends/              # Git 仓库
└── my-deploy/            # 仓库外的个人文件
    ├── wrangler.jsonc
    └── public/
        └── icons/
            └── logo.svg
```

将仓库的 `wrangler.jsonc` 复制到 `my-deploy/` 后调整路径。Wrangler 中的相对路径以配置文件所在目录为基准，因此需修改以下字段，并保留其他配置与绑定：

```jsonc
{
  "$schema": "../calends/node_modules/wrangler/config-schema.json",
  "main": "../calends/worker/index.ts",
  "assets": { "directory": "../calends/dist", "binding": "ASSETS", "not_found_handling": "single-page-application", "run_worker_first": true },
  "d1_databases": [{ "binding": "DB", "database_name": "calends", "migrations_dir": "../calends/worker/migrations" }],
}
```

在仓库根目录执行命令，部署与密钥管理使用同一目录：

```bash
CALENDS_LOCAL=../my-deploy npm run deploy
CALENDS_LOCAL=../my-deploy node scripts/wrangler.mjs secret put SETUP_TOKEN
```

显式传入的 `--config`/`-c` 优先于自动配置选择。个人目录中不存在 `wrangler.jsonc` 时，封装保留 Wrangler 的默认配置选择。本地 Worker 和迁移命令的数据始终保存在 `<repo>/.wrangler/state`，不随配置目录改变；显式指定 `--persist-to` 时仍以用户设置为准。

### 自定义域名与 HTTPS

Cloudflare 部署前，在实际使用的 Wrangler 配置中添加域名：

```jsonc
"routes": [{ "pattern": "calends.example.com", "custom_domain": true }],
"vars": { "SITE_URL": "https://calends.example.com" }
```

如果已有 `vars`，将 `SITE_URL` 合并进去。Docker 请通过 Caddy、Nginx 或 Traefik 等反向代理启用 HTTPS，并将 `SITE_URL` 设为外部访问地址。Passkey 需要安全上下文，公网访问应使用 HTTPS。

登录限速用到的访客 IP 由 Calends 自动判断：只有来自本机、内网地址或 Cloudflare 的连接，`X-Forwarded-For` 才算数，从右往左第一个不受信任的地址就是访客。Caddy、Traefik 和 Cloudflare Tunnel 不用配置。Nginx 必须追加这个头，否则任何人都能指定限速用的 IP：

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

端口只开放给代理（`-p 127.0.0.1:8787:8787`）。不经代理也能连到 Calends 时，请设 `TRUST_PROXY=off`：同一内网的访客能伪造这个头；Docker 把连接显示成来自网关时（Docker Desktop、rootless Docker、部分 IPv6 端口映射），公网访客也能。使用 Cloudflare 以外的 CDN 时，把它的地址段加进来，比如 `TRUST_PROXY=192.0.2.0/24,198.51.100.7`；不加的话，所有访客会共用 CDN 的地址。

### 邮件提醒

Cloudflare 部署可通过 `EMAIL` 绑定发邮件。仓库的 `wrangler.jsonc` 已提供注释示例，使用经过验证的发件地址启用 `send_email`、`MAIL_FROM` 和 `MAIL_FROM_NAME`，然后在应用内设置通知渠道。

Telegram、飞书、钉钉、企业微信、Slack、Discord、Bark、ntfy、Server酱和自定义 Webhook 无需额外的服务端配置。

## 交给 AI 部署

将下面的提示词发给 Claude Code、Codex、Cursor 等能操作终端的 AI：

```text
帮我部署 Calends（https://github.com/imetn/calends），一个可自托管的订阅账本。
先读 README.zh-CN.md 和 docs/self-hosting.zh-CN.md。
1. 问我部署到 Cloudflare Workers 还是 Docker，以及是否使用自定义域名。
2. Cloudflare：克隆仓库、执行 npm ci、验证 Wrangler 登录，生成随机 SETUP_TOKEN，
   用 node scripts/wrangler.mjs secret put SETUP_TOKEN 设置，再执行 npm run deploy。
   如果我需要自定义域名，部署前加到实际使用的 Wrangler 配置中。
3. Docker：优先使用 xizozhe/calends（或 ghcr.io/imetn/calends）的预构建镜像。
   生产环境固定 1.31.0 等版本标签，拉取后在 8787 端口运行，将 calends-data 挂载到 /data。
   用 docker logs calends 读取初始化令牌。
   仅在需要时从源码构建，例如部署到子路径。
   需要公网访问时，用我选择的反向代理配置 HTTPS。
4. 验证应用地址 / 可跳转到登录页 /login，把应用地址和初始化令牌告诉我，
   再说明如何绑定 Passkey，以及在 Calends 的「连接」页 /connect 接入 AI 助手。
```

## 子路径部署

如果要放在 `https://example.com/calends/` 这样的子路径下，构建和运行时设置相同的 `BASE_PATH`，并让反向代理转发时保留前缀：

```bash
docker build -f docker/Dockerfile --build-arg BASE_PATH=/calends -t calends:local .
docker run -d --name calends -p 127.0.0.1:8787:8787 -v calends-data:/data \
  -e BASE_PATH=/calends -e SITE_URL=https://example.com/calends calends:local
```

打开 `https://example.com/calends/`；登录后跳转到设置中的启动页（默认 `/calends/overview`）。登录页为 `/calends/login`，「连接」页为 `/calends/connect`，可选的只读公开页为 `/calends/public`。MCP 客户端使用 `/calends/mcp`。Cloudflare 部署时，在运行 `npm run deploy` 的环境变量和 Worker 的 `vars` 中都设置 `BASE_PATH`。访问与登录回跳规则见[架构说明](../ARCHITECTURE.md#web-requests-and-state)。
