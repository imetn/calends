-- 网页、MCP 读改写守卫（worker/write-guard.ts）的提交核对表：首条 INSERT 核对账本序号未变，否则 CHECK 失败、整批回滚。
-- 与同步的 sync_cas 分开：写守卫是通用并发修复（多标签页、MCP 互相覆盖），不依赖 App 同步是否启用。
CREATE TABLE write_cas (ok INTEGER NOT NULL CHECK (ok = 1));
