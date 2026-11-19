-- App 同步改为默认休眠（worker/sync-mode.ts）：sync_meta.mode = off | tokens | hosted。
-- 新库的 0009 只建表；此前按旧版 0009 装过触发器的库在这里定状态：
-- 已有同步令牌或已有安装记录（自部署在用，或官方托管已连接过设备）→ tokens，触发器与 sync_objects 原样保留；
-- 否则 → off，迁移之后 reconcileSync 卸掉触发器、清空对象表。托管外层随后调用 enableSync 置为 hosted。
INSERT INTO sync_meta (key, value)
SELECT 'mode', CASE WHEN EXISTS (SELECT 1 FROM sync_tokens) OR EXISTS (SELECT 1 FROM sync_clients) THEN 'tokens' ELSE 'off' END
WHERE 1
ON CONFLICT(key) DO NOTHING;
