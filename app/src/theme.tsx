// 主题：亮色 → 暗色 → 跟随系统 三者轮换，后台与公开页共用
import { useEffect } from 'react';
import { t } from '../../shared/i18n.ts';
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
 * 三个图标叠在一起，只淡入当前图标。跟随系统在窄屏（手机）上画手机，宽屏画显示器。
 */
export function ThemeIcon({ mode, size = 18 }: { mode: ThemeMode; size?: number }) {
  const phone = matchMedia('(max-width: 860px)').matches;
  const layer = (m: ThemeMode, turn: number) =>
    ({
      transformBox: 'fill-box',
      transformOrigin: 'center',
      transform: mode === m ? 'rotate(0deg) scale(1)' : `rotate(${turn}deg) scale(0.3)`,
      opacity: mode === m ? 1 : 0,
      transition: 'opacity var(--duration) var(--ease)',
    }) as React.CSSProperties;
  return (
    <svg
      className="i"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g style={layer('light', -90)}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </g>
      <g style={layer('dark', 90)}>
        <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z" />
      </g>
      <g style={layer('system', 180)}>
        {phone ? (
          <>
            <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
            <path d="M11 18.5h2" />
          </>
        ) : (
          <>
            <rect x="2.5" y="4" width="19" height="13" rx="2" />
            <path d="M8 21h8M12 17v4" />
          </>
        )}
      </g>
    </svg>
  );
}
