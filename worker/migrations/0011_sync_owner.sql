-- 安装归属（官方托管）：首次写入安装行的已验证主体（设备／令牌家族）。自部署单用户不填，保持 NULL，行为不变。
ALTER TABLE sync_clients ADD COLUMN owner TEXT;
