// 主题：亮色 → 暗色 → 跟随系统 三者轮换，后台与公开页共用
import { useEffect } from 'react';
import { t } from '../../shared/i18n.ts';
import { KubaiIcon } from './components/KubaiIcon.tsx';
import { usePref } from './prefs.ts';

export type ThemeMode = 'light' | 'dark' | 'system';

const NEXT: Record<ThemeMode, ThemeMode> = { light: 'dark', dark: 'system', system: 'light' };
/** 主题名称：用 getter 在读取时翻译，THEME_LABEL[mode] 的写法不变 */
export const THEME_LABEL: Record<ThemeMode, string> = {
  get light() {
    return t('ui.theme.light');
  },
  get dark() {
    return t('ui.theme.dark');
  },
  get system() {
    return t('ui.theme.system');
  },
};

const mq = () => matchMedia('(prefers-color-scheme: dark)');

const isMode = (v: string): v is ThemeMode => v === 'light' || v === 'dark' || v === 'system';

/** 始终写入 data-theme，跟随系统时按系统当前外观取值 */
function apply(m: ThemeMode) {
  const resolved = m === 'system' ? (mq().matches ? 'dark' : 'light') : m;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

/** 主题跟着账号走，多台设备一致；公开页没有登录数据时只用本机副本 */
export function useThemeMode(): [ThemeMode, () => void] {
  const [mode, setMode] = usePref<ThemeMode>('theme', 'system', isMode);
  useEffect(() => {
    apply(mode);
    if (mode !== 'system') return;
    const m = mq();
    const on = () => apply('system');
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [mode]);
  const cycle = () => {
    const n = NEXT[mode];
    setMode(n === 'system' ? null : n);
  };
  return [mode, cycle];
}

/**
 * 主题图标：浅色太阳、深色弯月、跟随系统在窄屏（手机）上画手机，宽屏画显示器；悬停与切换时播放对应线条弹簧动效。
 */
export function ThemeIcon({ mode, size = 18 }: { mode: ThemeMode; size?: number }) {
  const phone = typeof matchMedia === 'function' && matchMedia('(max-width: 860px)').matches;
  const iconKey = mode === 'light' ? 'sun' : mode === 'dark' ? 'moon' : phone ? 'smartphone' : 'monitor';
  return <KubaiIcon iconKey={iconKey} size={size} pulseKey={mode} className="i" />;
}
