export interface EmailBinding {
  send(msg: { from: { email: string; name?: string } | string; to: string | string[]; subject: string; text: string; html: string }): Promise<unknown>;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Cloudflare Email Sending；不配置时邮件渠道不可用，其他渠道照常 */
  EMAIL?: EmailBinding;
  /** 站点地址（提醒里的链接）；不配置时用访问后台时记下的地址 */
  SITE_URL?: string;
  BASE_PATH?: string;
  MAIL_FROM?: string;
  MAIL_FROM_NAME?: string;
  /** 旧版：口令直接放在密钥里；第一次登录成功后会转存为哈希，之后可以删除 */
  OWNER_PASSCODE?: string;
  /** 首次设置密码时需要提供的一次性令牌（wrangler secret put SETUP_TOKEN） */
  SETUP_TOKEN?: string;
  /** 换过域名时填旧域名（逗号分隔）：在这些域名上打开页面会 301 到 SITE_URL；接口、MCP、日历订阅照常可用，已有的订阅和客户端不受影响 */
  OLD_HOSTS?: string;
  /** 仅本地：.dev.vars 设为 1 时跳过登录（不要在线上配置） */
  DEV_BYPASS_AUTH?: string;
}
