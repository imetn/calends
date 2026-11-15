import { useId, type ReactNode } from 'react';
import { t } from '../../../shared/i18n.ts';
import type { MethodKind, PaymentMethod } from '../../../shared/types.ts';
import { base } from '../base.ts';
import { bankOf, brandOf, KIND_LABEL, methodLogo, methodRegion } from '../derive.ts';
import { copyParts } from './copy.tsx';
import { FlagImg, NetworkMark } from './marks.tsx';

/* 钱包卡面：钱包页与编辑预览共用（.paycard，见 styles.css） */

export const CARD_KINDS: MethodKind[] = ['debit', 'credit', 'crypto'];

/** 手机号分组显示：+63 917 123 4567 */
function fmtPhone(p: string): string {
  const d = p.replace(/[^\d+]/g, '');
  const m = d.match(/^\+(\d{1,3})(\d{3})(\d{3})(\d{3,4})$/);
  return m ? `+${m[1]} ${m[2]} ${m[3]} ${m[4]}` : p;
}

const isSim = (m: PaymentMethod) => m.kind === 'phone';

/** 卡面样式：手机话费做成 SIM 卡，App Store 余额做成钛金属卡（参照 Apple Card），Google Play 是白底深字 */
export const faceClass = (m: PaymentMethod) => (isSim(m) ? 'sim' : brandOf(m) === 'appstore' ? 'apple' : m.kind === 'googleplay' ? 'light' : '');

/** 卡面：品牌标旋转放大做水印并渐隐，角上放清晰的小 logo；手机话费做成 SIM 卡 */
export function CardFace({ m, label, value, right, rightSub }: { m: PaymentMethod; label: string; value: ReactNode; right: string; rightSub: string }) {
  const brand = brandOf(m);
  if (isSim(m)) {
    // 卡托细槽分段留出连接桥；芯片与银行卡共用组件和尺寸，不随槽线 SVG 缩放。
    return (
      <>
        <div className="sim-punch" aria-hidden="true">
          <svg className="sim-cutouts" viewBox="0 0 120 72">
            <path className="sim-slot" d="M2 32V6Q2 2 6 2H48M53 2H100L118 20V45M118 50V66Q118 70 114 70H75M70 70H6Q2 70 2 66V37" />
            <path className="sim-slot" d="M18 33V16Q18 12 22 12H49M54 12H84L102 30V44M102 49V56Q102 60 98 60H66M61 60H22Q18 60 18 56V38" />
          </svg>
          <CardChip />
        </div>
        <div className="sim-top">
          {/* 只有认出是哪家运营商（如 SMART）才放它的 logo，否则写名字，不默认套某一家 */}
          {methodLogo(m) ? (
            <img className={`sim-logo ${m.logoWide ? 'wide' : ''}`} src={base(methodLogo(m) || '')} alt="" />
          ) : (
            <b className="sim-carrier">{m.name.split(/\s/)[0]}</b>
          )}
        </div>
        <div className="sim-name">
          {m.name}
          <small>
            <FlagImg cc={methodRegion(m)} /> {copyParts(m.phone ? fmtPhone(m.phone) : `${KIND_LABEL[m.kind]}\n${m.currency}`)}
          </small>
        </div>
        <div className="pc-foot">
          <div>
            {label && <div className="o">{label}</div>}
            <div className="pc-bal">{value}</div>
          </div>
          <div className="pc-meta">
            <div className="o">{right}</div>
            <div style={{ fontWeight: 600 }}>{rightSub}</div>
          </div>
        </div>
      </>
    );
  }
  if (brand === 'appstore') {
    // 白色钛金属卡面：左上激光蚀刻的 App Store 标与地区名，右上国旗；余额与其他卡一样放左下
    return (
      <>
        <div className="pc-top">
          <div className="pc-id">
            <span className="ac-logo" aria-hidden="true" />
            <div className="ac-name">{m.name}</div>
          </div>
          <span className="ac-flag">
            <FlagImg cc={methodRegion(m)} />
          </span>
        </div>
        <div className="pc-foot">
          <div>
            {label && <div className="ac-o">{label}</div>}
            <div className="pc-bal">{value}</div>
          </div>
          <div className="pc-meta">
            <div className="ac-o">{right}</div>
            <div style={{ fontWeight: 600 }}>{rightSub}</div>
          </div>
        </div>
      </>
    );
  }
  // 自定义 logo 优先（可以放适配卡面的白色版本），其余银行卡用银行图标集
  const bank = bankOf(m);
  const logo = methodLogo(m);
  const cls = m.logoWide ? 'wide' : (brand ?? '');
  return (
    <>
      {logo && <img className={`pc-mark ${cls}`} src={base(logo)} alt="" aria-hidden="true" />}
      <div className="pc-top">
        <div className="pc-id">
          {logo ? (
            <img className={`pc-logo ${cls}`} src={base(logo)} alt="" />
          ) : bank ? (
            <img className="pc-logo bank" src={base(`/banks/${bank}-rect.svg`)} alt="" />
          ) : null}
          <div style={{ minWidth: 0 }}>
            <div className="pc-name text-ellipsis">{m.name}</div>
            <div className="pc-kind">
              {KIND_LABEL[m.kind]}
              {copyParts(m.network ? `\n${m.currency}` : '')}
              {copyParts(m.region ? `\n${m.region}` : '')}
              {copyParts(m.cashback ? `\n${t('wallet.card.cashback', { pct: m.cashback })}` : '')}
            </div>
          </div>
        </div>
        {m.network ? <NetworkMark network={m.network} height={26} /> : <span className="pc-ccy">{m.currency}</span>}
      </div>
      {CARD_KINDS.includes(m.kind) && <CardChip />}
      <div className="pc-foot">
        <div>
          {label && <div className="o">{label}</div>}
          <div className="pc-bal">{value}</div>
        </div>
        <div className="pc-meta">
          <div className="o">{right}</div>
          <div style={{ fontWeight: 600 }}>{rightSub}</div>
        </div>
      </div>
    </>
  );
}

/**
 * 银行卡芯片：香槟金金属底 + 细拉丝纹理，触点每格一道亮边一道暗线做出压印感，外缘渐变斜边；
 * 尺寸由 .pc-chip 决定、随卡片缩放
 */
function CardChip() {
  // 芯片触点分区（ISO 7816 式）：左右各三格，中间上方一格，下方一格带两个倒角；触点铺满芯片边缘
  const CHIP_PADS = [
    'M0 0H16.3V10.8H0Z',
    'M0 10.8H16.3V24.5H0Z',
    'M0 24.5H16.3V36H0Z',
    'M31.7 0H48V10.8H31.7Z',
    'M31.7 10.8H48V24.5H31.7Z',
    'M31.7 24.5H48V36H31.7Z',
    'M16.3 0H31.7V8.6H16.3Z',
    'M20.6 8.6H27.4L31.7 13V36H16.3V13Z',
  ];
  const id = useId().replace(/:/g, '');
  return (
    <svg className="pc-chip" viewBox="0 0 48 36" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}m`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e3d2a6" />
          <stop offset="0.24" stopColor="#f7eed6" />
          <stop offset="0.56" stopColor="#b9a06a" />
          <stop offset="0.78" stopColor="#e3d2a6" />
          <stop offset="1" stopColor="#ad935d" />
        </linearGradient>
        <linearGradient id={`${id}p`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fbf4e2" stopOpacity="0.5" />
          <stop offset="1" stopColor="#8f7645" stopOpacity="0.25" />
        </linearGradient>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fbf4e2" />
          <stop offset="1" stopColor="#7a6337" />
        </linearGradient>
        {/* 拉丝：横向拉长的噪声分成亮纹与暗纹两层叠回去 */}
        <filter id={`${id}r`} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.035 1.3" numOctaves="2" seed="7" stitchTiles="stitch" result="n" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.6 0 0 0 -0.62" result="hi" />
          <feFlood floodColor="#fbf4e2" />
          <feComposite in2="hi" operator="in" result="lit" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -1.6 0 0 0 0.98" result="lo" />
          <feFlood floodColor="#9c8250" />
          <feComposite in2="lo" operator="in" result="dim" />
          <feMerge>
            <feMergeNode in="dim" />
            <feMergeNode in="lit" />
          </feMerge>
        </filter>
        <clipPath id={`${id}c`}>
          <rect width="48" height="36" rx="4" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}c)`}>
        <rect width="48" height="36" fill={`url(#${id}m)`} />
        <rect width="48" height="36" filter={`url(#${id}r)`} opacity="0.5" />
        {CHIP_PADS.map((d) => (
          <g key={d}>
            <path d={d} fill={`url(#${id}p)`} />
            <path d={d} transform="translate(0.5 0.5)" fill="none" stroke="#fbf4e2" strokeOpacity="0.8" strokeWidth="0.5" />
            <path d={d} fill="none" stroke="#6f5a32" strokeWidth="0.75" />
          </g>
        ))}
      </g>
      <rect x="0.5" y="0.5" width="47" height="35" rx="3.5" fill="none" stroke={`url(#${id}b)`} strokeWidth="1" />
    </svg>
  );
}
