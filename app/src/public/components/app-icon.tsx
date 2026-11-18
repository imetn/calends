import { isImageIcon, registrarIcon } from '../../../../shared/icon.ts';
import { base } from '../../base.ts';
import { useState } from 'react';
import type { Subscription } from '../../../../shared/types.ts';
import { faviconOf, isDomainCat } from '../../derive.ts';
import { cn } from '@/public/lib/utils';

const failed = new Set<string>();

/** 订阅图标：域名用注册商图标（默认 Cloudflare，其他注册商取 icon，与后台一致）；其余 emoji > App 图标 > 站点图标 > 首字母 */
export function AppIcon({ sub, className, size, eager }: { sub: Pick<Subscription, 'name' | 'icon' | 'url' | 'category'>; className?: string; size?: number; eager?: boolean }) {
  const [, force] = useState(0);
  const box = cn('flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md ring-[0.5px] ring-border', className);
  const style = size ? { width: size, height: size, fontSize: 'var(--fs-1)'} : undefined;
  if (isDomainCat(sub.category)) {
    return (
      <span style={style} className={cn(box, 'bg-white')}>
        <img src={base(registrarIcon(sub.icon))} alt="" className="size-[70%] object-contain" />
      </span>
    );
  }
  const icon = sub.icon?.trim();
  if (icon && !isImageIcon(icon)) return <span style={style} className={cn(box, 'bg-muted text-xs')}>{icon}</span>;
  const src = icon || faviconOf(sub.url);
  if (src && !failed.has(src)) {
    return (
      <span style={style} className={cn(box, icon ? 'bg-muted' : 'bg-white p-[5px]')}>
        <img
          src={base(src)}
          alt=""
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onLoad={(e) => {
            // Google 对未知域名返回 16px 的地球占位图
            if (!icon && (e.currentTarget as HTMLImageElement).naturalWidth <= 16) {
              failed.add(src);
              force((n) => n + 1);
            }
          }}
          onError={() => {
            failed.add(src);
            force((n) => n + 1);
          }}
        />
      </span>
    );
  }
  return <span style={style} className={cn(box, 'bg-muted text-xs font-medium text-muted-foreground')}>{[...sub.name][0]?.toUpperCase() ?? '?'}</span>;
}
