/** SVG 柱的「预计」斜纹，规格与 CSS 的 --unpaid-hatch 一致：135° 线 1.5px、周期 5px。放在图表的 defs 里，柱子用 fill: url(#id) */
export function HatchPattern({ id }: { id: string }) {
  return (
    <pattern id={id} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width={5} height={5} style={{ fill: 'var(--unpaid-fill)' }} />
      <rect width={1.5} height={5} style={{ fill: 'var(--unpaid-stripe)' }} />
    </pattern>
  );
}
