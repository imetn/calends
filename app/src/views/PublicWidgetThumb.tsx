/** 组件库的缩略图：画出组件大概长什么样，一眼能认。线框用文字色的不同透明度，随主题变 */
const FILL = 'currentColor';

const Bar = ({ x, y, w, h = 3, o = 0.28 }: { x: number; y: number; w: number; h?: number; o?: number }) => (
  <rect x={x} y={y} width={w} height={h} rx={1} fill={FILL} opacity={o} />
);

const SHAPES: Record<string, React.ReactNode> = {
  stats: (
    <>
      <Bar x={5} y={8} w={14} />
      <Bar x={5} y={14} w={26} h={8} o={0.75} />
      <Bar x={5} y={28} w={20} />
      <Bar x={38} y={22} w={9} />
      <Bar x={50} y={22} w={9} />
      <Bar x={38} y={28} w={9} h={4} o={0.55} />
      <Bar x={50} y={28} w={9} h={4} o={0.55} />
    </>
  ),
  number: (
    <>
      <Bar x={14} y={12} w={22} />
      <Bar x={14} y={19} w={34} h={10} o={0.75} />
    </>
  ),
  trend: (
    <>
      <Bar x={8} y={7} w={18} />
      <Bar x={8} y={13} w={26} h={7} o={0.75} />
      {[4, 7, 5, 9, 6, 8, 12].map((h, i) => (
        <Bar key={i} x={8 + i * 7} y={38 - h} w={5} h={h} o={i === 6 ? 0.75 : 0.28} />
      ))}
    </>
  ),
  compare: (
    <>
      <Bar x={8} y={8} w={18} />
      <Bar x={8} y={14} w={30} h={8} o={0.75} />
      <Bar x={8} y={28} w={36} />
    </>
  ),
  share: (
    <>
      <Bar x={8} y={8} w={18} />
      <Bar x={8} y={15} w={22} h={4} o={0.6} />
      <Bar x={44} y={15} w={12} h={4} o={0.6} />
      {Array.from({ length: 12 }, (_, i) => (
        <Bar key={i} x={8 + i * 4} y={25} w={3} h={6} o={i < 7 ? 0.7 : 0.16} />
      ))}
    </>
  ),
  rows: (
    <>
      {[8, 16, 24, 32].map((y) => (
        <g key={y}>
          <Bar x={8} y={y} w={24} />
          <Bar x={42} y={y} w={14} o={0.65} />
        </g>
      ))}
    </>
  ),
  chart: (
    <>
      {[10, 18, 14, 22, 16, 25, 20].map((h, i) => (
        <Bar key={i} x={8 + i * 7} y={36 - h} w={4} h={h} o={0.55} />
      ))}
    </>
  ),
  composition: (
    <>
      <Bar x={6} y={10} w={24} h={6} o={0.75} />
      <Bar x={31} y={10} w={15} h={6} o={0.45} />
      <Bar x={47} y={10} w={11} h={6} o={0.22} />
      <Bar x={6} y={22} w={20} />
      <Bar x={6} y={29} w={14} />
    </>
  ),
  treemap: (
    <>
      <Bar x={6} y={6} w={28} h={32} o={0.65} />
      <Bar x={36} y={6} w={22} h={17} o={0.42} />
      <Bar x={36} y={25} w={12} h={13} o={0.28} />
      <Bar x={50} y={25} w={8} h={13} o={0.16} />
    </>
  ),
  globe: (
    <>
      <circle cx={32} cy={22} r={15} fill="none" stroke={FILL} strokeOpacity={0.35} />
      <ellipse cx={32} cy={22} rx={6} ry={15} fill="none" stroke={FILL} strokeOpacity={0.22} />
      <Bar x={17} y={21.5} w={30} h={1} o={0.22} />
      <circle cx={26} cy={16} r={2.5} fill={FILL} opacity={0.6} />
      <circle cx={38} cy={26} r={1.8} fill={FILL} opacity={0.45} />
      <circle cx={30} cy={29} r={1.2} fill={FILL} opacity={0.3} />
    </>
  ),
  waterfall: (
    <>
      <Bar x={8} y={22} w={7} h={14} o={0.6} />
      <Bar x={18} y={14} w={7} h={8} o={0.4} />
      <Bar x={28} y={10} w={7} h={4} o={0.4} />
      <Bar x={38} y={10} w={7} h={9} o={0.22} />
      <Bar x={48} y={19} w={7} h={17} o={0.6} />
    </>
  ),
  fx: (
    <>
      {[9, 18, 27].map((y, i) => (
        <g key={y}>
          <Bar x={8} y={y} w={10} o={0.6} />
          <Bar x={24} y={y} w={[20, 14, 8][i]} o={0.3} />
          <Bar x={48} y={y} w={8} o={0.45} />
        </g>
      ))}
    </>
  ),
  timeline: (
    <>
      <Bar x={6} y={21} w={52} h={1.5} o={0.3} />
      {[12, 26, 34, 50].map((x) => (
        <circle key={x} cx={x} cy={22} r={3.5} fill={FILL} opacity={0.6} />
      ))}
    </>
  ),
  calendar: (
    <>
      {Array.from({ length: 28 }, (_, i) => (
        <Bar key={i} x={10 + (i % 7) * 6.5} y={8 + Math.floor(i / 7) * 7} w={4.5} h={4.5} o={[3, 9, 16, 24].includes(i) ? 0.75 : 0.18} />
      ))}
    </>
  ),
  years: (
    <>
      <Bar x={8} y={9} w={30} h={4} o={0.6} />
      <Bar x={16} y={16} w={38} h={4} o={0.42} />
      <Bar x={8} y={23} w={14} h={4} o={0.28} />
      <Bar x={26} y={30} w={30} h={4} o={0.55} />
    </>
  ),
  list: (
    <>
      {[9, 18, 27].map((y) => (
        <g key={y}>
          <Bar x={7} y={y - 1} w={6} h={6} o={0.5} />
          <Bar x={17} y={y} w={24} />
          <Bar x={47} y={y} w={10} o={0.55} />
        </g>
      ))}
    </>
  ),
  tenure: (
    <>
      <Bar x={8} y={9} w={46} h={4} o={0.65} />
      <Bar x={8} y={17} w={34} h={4} o={0.5} />
      <Bar x={8} y={25} w={24} h={4} o={0.35} />
      <Bar x={8} y={33} w={14} h={3} o={0.22} />
    </>
  ),
  changes: (
    <>
      <path d="M11 7 V37" stroke={FILL} strokeWidth={1} opacity={0.3} />
      {[11, 22, 33].map((y) => (
        <g key={y}>
          <circle cx={11} cy={y} r={2.5} fill={FILL} opacity={0.65} />
          <Bar x={18} y={y - 1.5} w={30} />
        </g>
      ))}
    </>
  ),
  ended: (
    <>
      {[12, 22, 32].map((y) => (
        <g key={y}>
          <Bar x={8} y={y - 2} w={22} />
          <Bar x={36} y={y - 0.5} w={20} h={1} o={0.5} />
        </g>
      ))}
    </>
  ),
  lifetime: (
    <>
      {[12, 22, 32].map((y) => (
        <g key={y}>
          <Bar x={8} y={y - 3} w={6} h={6} o={0.5} />
          <Bar x={18} y={y - 1.5} w={20} />
          <Bar x={44} y={y - 1.5} w={12} o={0.6} />
        </g>
      ))}
    </>
  ),
  footer: (
    <>
      <Bar x={8} y={10} w={48} h={14} o={0.1} />
      <Bar x={8} y={31} w={22} o={0.5} />
    </>
  ),
  pile: (
    <>
      {[
        [14, 34, 5],
        [25, 35, 4],
        [35, 33, 6],
        [46, 35, 4],
        [20, 26, 4],
        [31, 24, 5],
        [41, 26, 4],
      ].map(([x, y, r]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill={FILL} opacity={0.3 + r * 0.05} />
      ))}
    </>
  ),
};

export function WidgetThumb({ id }: { id: string }) {
  return (
    <svg className="ppe-thumb" viewBox="0 0 64 44" width={64} height={44} aria-hidden="true">
      {SHAPES[id]}
    </svg>
  );
}
