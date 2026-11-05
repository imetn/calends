#!/usr/bin/env bash
# Calends 安装与升级（Debian、Ubuntu + systemd）。重复运行就是升级：先备份，不覆盖数据和配置。
#   curl -fsSL https://calends.date/install.sh | sudo bash
#   sudo bash install.sh [--version 1.27.0] [--uninstall]
# 整个脚本包在 main 里、最后一行才调用：下载中断时不会执行半截。
set -euo pipefail

REPO_URL="${CALENDS_RELEASE_URL:-https://github.com/imetn/calends/releases}"
NODE_URL="${CALENDS_NODE_URL:-https://nodejs.org/dist/latest-v24.x}"
APP=/opt/calends
NODE_DIR=/opt/calends-node
ENV_FILE=/etc/calends.env
UNIT=/etc/systemd/system/calends.service
DROPIN=/etc/systemd/system/calends.service.d/node.conf
DATA=/var/lib/private/calends
BACKUP_PREFIX=/var/lib/private/calends-backup-
KEEP_BACKUPS=3

# 输出已经没人接（SSH 断开、tee 退出）时，打印失败不能打断升级或恢复
say() { printf '\033[1;34m==>\033[0m %s\n' "$*" || true; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2 || true; }
die() {
  printf '\033[1;31merror:\033[0m %s\n' "$*" >&2 || true
  exit 1
}

check_system() {
  [ "$(id -u)" = 0 ] || die "run as root: curl -fsSL https://calends.date/install.sh | sudo bash"
  [ "$(uname -s)" = Linux ] || die "only Linux is supported; use Docker on other systems"
  [ -d /run/systemd/system ] || die "systemd is required; use Docker on this system"
  [ -r /etc/os-release ] || die "cannot identify this system; use Docker instead"
  local id like
  id="$(. /etc/os-release && printf '%s' "${ID:-}")"
  like="$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")"
  case " $id $like " in
    *" debian "* | *" ubuntu "*) ;;
    *) die "only Debian and Ubuntu are supported (found ${id:-unknown}); use Docker on this system" ;;
  esac
  case "$(uname -m)" in
    x86_64) NODE_ARCH=x64 ;;
    aarch64 | arm64) NODE_ARCH=arm64 ;;
    *) die "unsupported architecture $(uname -m); only x86_64 and arm64 are supported" ;;
  esac
  local tool
  for tool in curl tar sha256sum awk sort; do
    command -v "$tool" >/dev/null || die "$tool is required: apt-get install -y curl tar coreutils gawk"
  done
}

# 版本号只来自命令行或 GitHub 跳转，进路径前先校验
valid_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }

latest_version() {
  local url
  url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$REPO_URL/latest")" || die "cannot reach $REPO_URL"
  printf '%s' "${url##*/v}"
}

installed_version() { cat "$APP/.version" 2>/dev/null || true; }

# 没有 .version 的是照文档手动装的，也算已安装
is_installed() { [ -f "$APP/docker/entrypoint.mjs" ]; }

env_value() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -1 | tr -d "\"'"; }
app_port() {
  local port
  port="$(env_value PORT)"
  printf '%s' "${port:-8787}"
}

port_busy() { command -v ss >/dev/null && [ -n "$(ss -Hltn "sport = :$1" 2>/dev/null)" ]; }

download_app() {
  local file="calends-$VERSION.tar.gz"
  say "Downloading Calends $VERSION"
  curl -fsSL --retry 3 -o "$WORK/$file" "$REPO_URL/download/v$VERSION/$file" || die "cannot download Calends $VERSION; check the version number"
  curl -fsSL --retry 3 -o "$WORK/$file.sha256" "$REPO_URL/download/v$VERSION/$file.sha256" || die "cannot download the checksum for Calends $VERSION"
  (cd "$WORK" && sha256sum -c --quiet "$file.sha256") || die "checksum mismatch for $file; nothing was changed"
  mkdir -p "$WORK/app"
  tar -xzf "$WORK/$file" -C "$WORK/app" --strip-components=1 --no-same-owner
  [ -f "$WORK/app/docker/entrypoint.mjs" ] || die "unexpected package layout; nothing was changed"
  printf '%s\n' "$VERSION" >"$WORK/app/.version"
}

# Node 单独放一份，不碰系统上已有的 Node；每次运行都跟到 24 的最新补丁
download_node() {
  curl -fsSL --retry 3 -o "$WORK/SHASUMS256.txt" "$NODE_URL/SHASUMS256.txt" || die "cannot reach $NODE_URL"
  local line file latest current=""
  line="$(grep -E "  node-v[0-9.]+-linux-$NODE_ARCH\.tar\.gz$" "$WORK/SHASUMS256.txt" | head -1 || true)"
  [ -n "$line" ] || die "no Node 24 build for linux-$NODE_ARCH"
  file="${line##* }"
  latest="${file#node-}"
  latest="${latest%%-*}"
  [ -x "$NODE_DIR/bin/node" ] && current="$("$NODE_DIR/bin/node" -v 2>/dev/null || true)"
  if [ "$current" = "$latest" ]; then
    NEW_NODE=""
    return
  fi
  say "Downloading Node $latest"
  curl -fsSL --retry 3 -o "$WORK/$file" "$NODE_URL/$file" || die "cannot download Node $latest"
  (cd "$WORK" && printf '%s\n' "$line" | sha256sum -c --quiet -) || die "checksum mismatch for $file; nothing was changed"
  mkdir -p "$WORK/node"
  tar -xzf "$WORK/$file" -C "$WORK/node" --strip-components=1 --no-same-owner --wildcards '*/bin/node' '*/LICENSE'
  "$WORK/node/bin/node" -v >/dev/null || die "the downloaded Node cannot run on this system; nothing was changed"
  NEW_NODE="$WORK/node"
}

install_node() {
  [ -n "${NEW_NODE:-}" ] || return 0
  rm -rf "$NODE_DIR.new" "$NODE_DIR.previous"
  cp -a "$NEW_NODE" "$NODE_DIR.new"
  if [ -e "$NODE_DIR" ]; then mv "$NODE_DIR" "$NODE_DIR.previous"; fi
  mv "$NODE_DIR.new" "$NODE_DIR"
}

install_unit() {
  cp "$APP/calends.service" "$UNIT"
  chmod 644 "$UNIT"
  mkdir -p "$(dirname "$DROPIN")"
  printf '# Written by install.sh: use the Node in %s\n[Service]\nEnvironment=PATH=%s/bin:/usr/bin:/bin\n' "$NODE_DIR" "$NODE_DIR" >"$DROPIN"
  systemctl daemon-reload
}

# 服务只监听某个具体地址时，探活也要连那个地址
app_url() {
  local host
  host="$(env_value HOST)"
  case "$host" in
    "" | 0.0.0.0 | "::") host=127.0.0.1 ;;
    *:*) host="[$host]" ;;
  esac
  printf 'http://%s:%s' "$host" "$(app_port)"
}

wait_healthy() {
  local url
  url="$(app_url)"
  for _ in $(seq 1 45); do
    curl -fsS -m 2 -o /dev/null "$url/healthz" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

# 服务已停，账本不会再变；复制失败就不继续升级
backup_data() {
  [ -d "$DATA" ] || return 0
  local target
  target="$BACKUP_PREFIX${OLD_VERSION:-unknown}-$(date -u +%Y%m%d%H%M%S)"
  say "Backing up data to $target"
  if ! (umask 077 && cp -a "$DATA" "$target"); then
    rm -rf -- "$target"
    die "backup failed, likely out of disk space; the previous version is being restarted"
  fi
  # cp -a 保留目录时间，几份备份会并列；按这次备份的时间排，才不会把它当成最旧的
  touch "$target"
  BACKUP="$target"
  local old
  ls -1dt "$BACKUP_PREFIX"* 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while IFS= read -r old; do
    [ "$old" = "$BACKUP" ] || rm -rf -- "$old"
  done
}

# 换回升级前的程序。新版本启动过才可能迁移过账本，这时数据也换回备份，出问题的那份留着不删
restore_previous() {
  systemctl stop calends || true
  if [ -d "$APP.previous" ]; then
    rm -rf "$APP"
    mv "$APP.previous" "$APP"
  fi
  if [ -d "$NODE_DIR.previous" ]; then
    rm -rf "$NODE_DIR"
    mv "$NODE_DIR.previous" "$NODE_DIR"
  fi
  if [ "$STARTED" = 1 ] && [ -n "$BACKUP" ]; then
    # 先复制好再交换，空间不够时原来的数据还在原处
    if cp -a "$BACKUP" "$DATA.restore"; then
      local failed
      failed="$DATA.failed-$(date -u +%Y%m%d%H%M%S)"
      mv "$DATA" "$failed"
      mv "$DATA.restore" "$DATA"
      warn "the data from the failed start was kept in $failed"
    else
      rm -rf "$DATA.restore"
      warn "cannot restore $BACKUP, likely out of disk space; the data was left as the failed start wrote it"
    fi
  fi
  install_unit || true
  systemctl start calends
}

roll_back() {
  trap '' INT TERM HUP
  IN_UPGRADE=0
  warn "Calends $VERSION did not become healthy; restoring the previous version"
  journalctl -u calends -n 20 --no-pager >&2 || true
  restore_previous || true
  wait_healthy || die "the previous version did not become healthy either; see: journalctl -u calends. Your data backup is in ${BACKUP:-(none)}"
  die "rolled back to the previous version; nothing was lost"
}

# 升级中途出错、被 Ctrl-C 或 SSH 断开：不留下停着的服务
on_exit() {
  local rc=$?
  # 恢复进行到一半不能再被打断
  trap '' INT TERM HUP
  if [ "$IN_UPGRADE" = 1 ]; then
    IN_UPGRADE=0
    set +e
    warn "the upgrade did not finish; restoring the previous version"
    restore_previous
    wait_healthy || warn "the previous version did not become healthy; see: journalctl -u calends"
  fi
  rm -rf "${WORK:-}"
  exit "$rc"
}

# 上次被强行中断（断电、kill -9）后，程序目录可能还停在交换的半路
recover_interrupted() {
  if [ ! -f "$APP/docker/entrypoint.mjs" ] && [ -f "$APP.previous/docker/entrypoint.mjs" ]; then
    rm -rf "$APP"
    mv "$APP.previous" "$APP"
  fi
  if [ ! -x "$NODE_DIR/bin/node" ] && [ -x "$NODE_DIR.previous/bin/node" ]; then
    rm -rf "$NODE_DIR"
    mv "$NODE_DIR.previous" "$NODE_DIR"
  fi
  # 数据目录不见了只可能停在交换的两步之间，此时 .restore 是完整的备份
  if [ ! -e "$DATA" ] && [ -d "$DATA.restore" ]; then mv "$DATA.restore" "$DATA"; fi
  rm -rf "$APP.new" "$NODE_DIR.new" "$DATA.restore"
}

upgrade() {
  OLD_VERSION="$(installed_version)"
  if [ -n "$OLD_VERSION" ] && [ "$OLD_VERSION" != "$VERSION" ] && [ "$(printf '%s\n%s\n' "$OLD_VERSION" "$VERSION" | sort -V | tail -1)" = "$OLD_VERSION" ] && [ "$FORCE_VERSION" != 1 ]; then
    die "installed version $OLD_VERSION is newer than $VERSION"
  fi
  download_node
  if [ "$OLD_VERSION" = "$VERSION" ] && [ -z "$NEW_NODE" ]; then
    # 版本相同也确认一遍：上次可能中断在启动之前
    systemctl start calends
    wait_healthy || die "Calends $VERSION is installed but not healthy; see: journalctl -u calends"
    rm -rf "$APP.previous" "$NODE_DIR.previous"
    say "Calends $VERSION is already installed"
    return
  fi
  [ -z "$(env_value BASE_PATH)" ] || die "BASE_PATH is set in $ENV_FILE; the package only serves the root path, so upgrade this deployment with Docker"
  download_app
  rm -rf "$APP.new"
  cp -a "$WORK/app" "$APP.new"
  chmod 755 "$APP.new"
  say "Upgrading Calends ${OLD_VERSION:-(unknown version)} to $VERSION"
  IN_UPGRADE=1
  systemctl stop calends || true
  backup_data
  install_node
  rm -rf "$APP.previous"
  mv "$APP" "$APP.previous"
  mv "$APP.new" "$APP"
  install_unit
  STARTED=1
  systemctl start calends || true
  wait_healthy || roll_back
  IN_UPGRADE=0
  rm -rf "$APP.previous" "$NODE_DIR.previous"
  say "Calends $VERSION is running. Backup: ${BACKUP:-none}"
}

fresh_install() {
  local port
  [ -d "$DATA" ] && say "Found existing data in $DATA; it will be kept"
  if [ ! -e "$ENV_FILE" ]; then
    port=8787
  else
    port="$(app_port)"
  fi
  port_busy "$port" && die "port $port is already in use. If Calends runs in Docker here, see the migration steps: https://github.com/imetn/calends/blob/main/docs/self-hosting.md#without-docker-systemd"
  download_app
  download_node
  install_node
  rm -rf "$APP" "$NODE_DIR.previous"
  cp -a "$WORK/app" "$APP"
  chmod 755 "$APP"
  # 配置文件已存在就不碰
  if [ ! -e "$ENV_FILE" ]; then
    (
      umask 077
      printf 'HOST=127.0.0.1\n' >"$ENV_FILE"
    )
  fi
  install_unit
  say "Starting Calends"
  systemctl enable --now calends >/dev/null 2>&1 || die "cannot start Calends; see: journalctl -u calends"
  wait_healthy || die "Calends did not become healthy; see: journalctl -u calends"
  print_next_steps
}

print_next_steps() {
  local port token=""
  port="$(app_port)"
  if curl -fsS -m 5 "$(app_url)/api/auth/status" 2>/dev/null | grep -q '"needsSetup":true'; then
    token="$(cat "$DATA/setup-token" 2>/dev/null || true)"
    [ -z "$(env_value SETUP_TOKEN)" ] || token="(the SETUP_TOKEN in $ENV_FILE)"
  fi
  printf '\nCalends %s is running on %s\n' "$VERSION" "$(app_url)"
  printf 'Point your reverse proxy there, and in Nginx also set:\n  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
  printf 'Then set SITE_URL in %s to your public address and run: systemctl restart calends\n' "$ENV_FILE"
  printf 'To open it before that: ssh -L %s:localhost:%s user@this-server, then visit http://localhost:%s/\n' "$port" "$port" "$port"
  [ -z "$token" ] || printf 'Setup token: %s\n' "$token"
  printf 'Upgrade: run this script again. Settings: %s\n' "$ENV_FILE"
}

uninstall() {
  is_installed || [ -f "$UNIT" ] || die "Calends is not installed"
  say "Removing the Calends service and program files"
  systemctl disable --now calends >/dev/null 2>&1 || true
  rm -f "$UNIT" "$DROPIN"
  rmdir "$(dirname "$DROPIN")" 2>/dev/null || true
  systemctl daemon-reload
  rm -rf "$APP" "$APP.previous" "$APP.new" "$NODE_DIR" "$NODE_DIR.previous" "$NODE_DIR.new"
  printf 'Removed. Your data and settings were kept: %s, %s\nDelete them yourself if you no longer need them.\n' "$DATA" "$ENV_FILE"
}

main() {
  VERSION=""
  FORCE_VERSION=0
  NEW_NODE=""
  BACKUP=""
  OLD_VERSION=""
  IN_UPGRADE=0
  STARTED=0
  WORK=""
  # root 的 umask 可能很严，DynamicUser 要能读程序和执行 Node
  umask 022
  local action=install
  while [ $# -gt 0 ]; do
    case "$1" in
      --version)
        [ $# -ge 2 ] || die "--version needs a value"
        VERSION="${2#v}"
        FORCE_VERSION=1
        shift 2
        ;;
      --uninstall)
        action=uninstall
        shift
        ;;
      *) die "unknown option: $1" ;;
    esac
  done
  check_system
  if [ "$action" = uninstall ]; then
    uninstall
    return
  fi
  [ -n "$VERSION" ] || VERSION="$(latest_version)"
  valid_version "$VERSION" || die "not a version number: $VERSION"
  WORK="$(mktemp -d)"
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  trap '' PIPE
  recover_interrupted
  if is_installed; then
    upgrade
  else
    fresh_install
  fi
}

main "$@"
