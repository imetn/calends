/**
 * 报告与概览里几张关系图的数据整理：只做分组、合并与布局用的数字，不碰汇率与扣款规则。
 * 输入的金额已经是基准币种的正数（调用方先算好净额）；非正数直接丢弃，不画成 0 宽的带子。
 */

export interface FlowNode {
  key: string;
  label: string;
  value: number;
}
export interface FlowLink {
  from: string;
  to: string;
  value: number;
}
export interface FlowGraph {
  left: FlowNode[];
  right: FlowNode[];
  links: FlowLink[];
  total: number;
}

/** 其他：被合并的小项统一用这个 key，调用方负责显示文案 */
export const OTHER = '\u0000other';

/**
 * 与构成卡同一口径：同一订阅在同一 (from, to) 组里先算净额，净额不为正的丢掉。
 * 退款、转让只抵本订阅，不会冲减同组的其他订阅；结果仍按订阅一行，交给 flowGraph 再合并。
 */
export function netByItem<T extends { id: string; from: string; to: string; value: number }>(rows: T[]): T[] {
  const m = new Map<string, T>();
  for (const r of rows) {
    const k = `${r.id}\u0001${r.from}\u0001${r.to}`;
    const e = m.get(k);
    m.set(k, e ? { ...e, value: e.value + r.value } : { ...r });
  }
  return [...m.values()].filter((r) => r.value > 0.005);
}

/**
 * 两列桑基：左右各自按金额排序，超过上限的小项并进「其他」。
 * 同一对 (左, 右) 的多条记录合成一条带子。
 */
export function flowGraph(rows: Array<{ from: string; fromLabel: string; to: string; toLabel: string; value: number }>, maxLeft = 6, maxRight = 7): FlowGraph {
  const sums = (side: 'from' | 'to') => {
    const m = new Map<string, FlowNode>();
    for (const r of rows) {
      if (!(r.value > 0)) continue;
      const k = r[side];
      const e = m.get(k) ?? { key: k, label: side === 'from' ? r.fromLabel : r.toLabel, value: 0 };
      e.value += r.value;
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  };
  const fold = (nodes: FlowNode[], max: number) => {
    // 只多一项时直接显示它，不为一项单独造「其他」
    if (nodes.length <= max) return { nodes, keep: new Set(nodes.map((n) => n.key)) };
    const head = nodes.slice(0, max - 1);
    const rest = nodes.slice(max - 1).reduce((a, n) => a + n.value, 0);
    return { nodes: [...head, { key: OTHER, label: '', value: rest }], keep: new Set(head.map((n) => n.key)) };
  };
  const L = fold(sums('from'), maxLeft);
  const R = fold(sums('to'), maxRight);
  const links = new Map<string, FlowLink>();
  for (const r of rows) {
    if (!(r.value > 0)) continue;
    const from = L.keep.has(r.from) ? r.from : OTHER;
    const to = R.keep.has(r.to) ? r.to : OTHER;
    const k = `${from}\u0001${to}`;
    const e = links.get(k) ?? { from, to, value: 0 };
    e.value += r.value;
    links.set(k, e);
  }
  const order = (nodes: FlowNode[]) => new Map(nodes.map((n, i) => [n.key, i]));
  const li = order(L.nodes);
  const ri = order(R.nodes);
  return {
    left: L.nodes,
    right: R.nodes,
    links: [...links.values()].sort((a, b) => li.get(a.from)! - li.get(b.from)! || ri.get(a.to)! - ri.get(b.to)!),
    total: L.nodes.reduce((a, n) => a + n.value, 0),
  };
}

export interface FlowLevels {
  /** 每层的节点，层内按金额从大到小，「其他」排最后；最后一层按上一层的顺序分组 */
  levels: FlowNode[][];
  /** level 是起点所在层 */
  links: Array<FlowLink & { level: number }>;
  /** 并项之后的每条路径，悬停时据此找出经过某个节点的所有带子 */
  paths: Array<{ path: string[]; value: number }>;
  total: number;
}

/**
 * 多层桑基：每条记录是一条从第一层到最后一层的路径。前几层超过上限的小项并进全局「其他」；
 * 最后一层只留金额最大的几项，其余并进各自上一层节点下的「其他」（key 为 OTHER + 父节点 key）。
 * 某个父节点下只并进一项时直接显示它。
 */
export function flowLevels(rows: Array<{ path: string[]; labels: string[]; value: number }>, max: number[]): FlowLevels {
  const depth = max.length;
  const live = rows.filter((r) => r.value > 0 && r.path.length === depth);
  const total = live.reduce((a, r) => a + r.value, 0);
  const keyed = live.map((r) => ({ ...r, path: [...r.path] }));
  const labels = new Map<string, string>();
  for (let lv = 0; lv < depth; lv++) {
    const sums = new Map<string, number>();
    for (const r of keyed) {
      sums.set(r.path[lv], (sums.get(r.path[lv]) ?? 0) + r.value);
      labels.set(`${lv}\u0001${r.path[lv]}`, r.labels[lv]);
    }
    const ranked = [...sums].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
    if (ranked.length <= max[lv]) continue;
    const keep = new Set(ranked.slice(0, max[lv] - (lv < depth - 1 ? 1 : 0)));
    if (lv < depth - 1) {
      for (const r of keyed) if (!keep.has(r.path[lv])) r.path[lv] = OTHER;
      continue;
    }
    // 最后一层：并进父节点下的「其他」，只并一项的父节点保留原样
    const folded = new Map<string, Set<string>>();
    for (const r of keyed) if (!keep.has(r.path[lv])) folded.set(r.path[lv - 1], (folded.get(r.path[lv - 1]) ?? new Set()).add(r.path[lv]));
    for (const r of keyed) {
      const f = folded.get(r.path[lv - 1]);
      if (!keep.has(r.path[lv]) && f && f.size > 1) r.path[lv] = OTHER + r.path[lv - 1];
    }
  }
  const levels: FlowNode[][] = [];
  for (let lv = 0; lv < depth; lv++) {
    const m = new Map<string, FlowNode>();
    for (const r of keyed) {
      const k = r.path[lv];
      const e = m.get(k) ?? { key: k, label: k.startsWith(OTHER) ? '' : (labels.get(`${lv}\u0001${k}`) ?? ''), value: 0 };
      e.value += r.value;
      m.set(k, e);
    }
    const byValue = (a: FlowNode, b: FlowNode) =>
      Number(a.key.startsWith(OTHER)) - Number(b.key.startsWith(OTHER)) || b.value - a.value || a.label.localeCompare(b.label);
    let nodes = [...m.values()].sort(byValue);
    if (lv > 0 && lv === depth - 1) {
      // 按父节点分组，父节点的顺序沿用上一层；子节点归到给它金额最多的父节点
      const prev = new Map(levels[lv - 1].map((n, i) => [n.key, i]));
      const parent = new Map<string, { key: string; v: number }>();
      const via = new Map<string, number>();
      for (const r of keyed) {
        const k = `${r.path[lv - 1]}\u0001${r.path[lv]}`;
        via.set(k, (via.get(k) ?? 0) + r.value);
        const v = via.get(k)!;
        const cur = parent.get(r.path[lv]);
        if (!cur || v > cur.v) parent.set(r.path[lv], { key: r.path[lv - 1], v });
      }
      nodes = nodes.sort((a, b) => prev.get(parent.get(a.key)!.key)! - prev.get(parent.get(b.key)!.key)! || byValue(a, b));
    }
    levels.push(nodes);
  }
  const links = new Map<string, FlowLink & { level: number }>();
  for (const r of keyed)
    for (let lv = 0; lv < depth - 1; lv++) {
      const k = `${lv}\u0001${r.path[lv]}\u0001${r.path[lv + 1]}`;
      const e = links.get(k) ?? { level: lv, from: r.path[lv], to: r.path[lv + 1], value: 0 };
      e.value += r.value;
      links.set(k, e);
    }
  const order = levels.map((nodes) => new Map(nodes.map((n, i) => [n.key, i])));
  return {
    levels,
    links: [...links.values()].sort(
      (a, b) => a.level - b.level || order[a.level].get(a.from)! - order[a.level].get(b.from)! || order[a.level + 1].get(a.to)! - order[a.level + 1].get(b.to)!,
    ),
    paths: keyed.map((r) => ({ path: r.path, value: r.value })),
    total,
  };
}

export interface ProfileAxis {
  key: string;
  /** 0–1，占各自期间合计的比例 */
  a: number;
  b: number;
}

/**
 * 雷达图的轴：两期合并后按金额取前几名，其余并进「其他」；值是各期内部的占比，
 * 两期总额不同也能比结构。任一期合计不为正，或轴少于 3 条时返回空（画不成多边形）。
 */
export function shareProfile(a: Array<{ key: string; value: number }>, b: Array<{ key: string; value: number }>, max = 7): ProfileAxis[] {
  const sum = (xs: Array<{ key: string; value: number }>) => {
    const m = new Map<string, number>();
    for (const x of xs) if (x.value > 0) m.set(x.key, (m.get(x.key) ?? 0) + x.value);
    return m;
  };
  const A = sum(a);
  const B = sum(b);
  const ta = [...A.values()].reduce((s, v) => s + v, 0);
  const tb = [...B.values()].reduce((s, v) => s + v, 0);
  if (!(ta > 0) || !(tb > 0)) return [];
  const keys = [...new Set([...A.keys(), ...B.keys()])].sort(
    (x, y) => (B.get(y) ?? 0) / tb + (A.get(y) ?? 0) / ta - ((B.get(x) ?? 0) / tb + (A.get(x) ?? 0) / ta) || x.localeCompare(y),
  );
  const head = keys.length <= max ? keys : keys.slice(0, max - 1);
  const axes: ProfileAxis[] = head.map((k) => ({ key: k, a: (A.get(k) ?? 0) / ta, b: (B.get(k) ?? 0) / tb }));
  if (keys.length > head.length) {
    const rest = keys.slice(head.length);
    axes.push({ key: OTHER, a: rest.reduce((s, k) => s + (A.get(k) ?? 0), 0) / ta, b: rest.reduce((s, k) => s + (B.get(k) ?? 0), 0) / tb });
  }
  return axes.length >= 3 ? axes : [];
}

/**
 * 河流图分层：每列各层的上下沿（以 0 为中线对称堆叠，silhouette 基线）。
 * 层按全期合计从大到小排，大的在中间附近更稳；缺的层按 0。
 */
export function streamLayers(columns: Array<Map<string, number>>): { keys: string[]; y0: number[][]; y1: number[][]; peak: number } {
  const totals = new Map<string, number>();
  for (const col of columns) for (const [k, v] of col) if (v > 0) totals.set(k, (totals.get(k) ?? 0) + v);
  const keys = [...totals.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([k]) => k);
  const y0: number[][] = keys.map(() => []);
  const y1: number[][] = keys.map(() => []);
  let peak = 0;
  columns.forEach((col, j) => {
    const vals = keys.map((k) => Math.max(0, col.get(k) ?? 0));
    const sum = vals.reduce((a, v) => a + v, 0);
    peak = Math.max(peak, sum);
    let y = -sum / 2;
    vals.forEach((v, i) => {
      y0[i][j] = y;
      y += v;
      y1[i][j] = y;
    });
  });
  return { keys, y0, y1, peak };
}

/**
 * 截断纵轴的瀑布：总额远大于变化量时，纵轴从接近最低累计值处开始，变化量才看得见。
 * 返回纵轴下限与上限；所有柱子在这个区间内。
 */
export function waterfallDomain(totals: number[]): { lo: number; hi: number } {
  const finite = totals.filter((v) => Number.isFinite(v));
  if (!finite.length) return { lo: 0, hi: 1 };
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = Math.max(max - min, Math.abs(max) * 0.02, 1);
  const lo = Math.max(0, min - span * 1.2);
  return { lo, hi: max + span * 0.25 };
}
