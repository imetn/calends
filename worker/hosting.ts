// 托管接缝：官方托管（每个账本一个库）在自己的 Worker / Durable Object 里挂载这些处理器，鉴权与路由由外层完成。
// 自部署的 worker/index.ts 走同样的函数，行为不变。
export { syncHandler, runSync, parseSyncRequest, hello as syncHello, disasterRecovery, type SyncOptions } from './sync.ts';
export { mcpHandler, type McpIdentity } from './ai/mcp.ts';
/** 每个请求一份语言状态：并发请求、多账本之间互不串语言 */
export { withLocaleScope, applyLocale, settingsLocale } from './i18n.ts';
/** 自动迁移按 env.DB 记录完成状态：同一进程里的多个库各自迁移 */
export { ensureMigrated } from './migrate.ts';
