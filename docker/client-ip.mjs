// 访客 IP：只相信本机和内网连过来的代理，以及 Cloudflare 的边缘节点；从 X-Forwarded-For 右边往左，第一个不可信的地址就是访客。
// 左边的项可能是客户端自带的，所以不能直接取最左项；从公网直连时根本不看这个头。
import { BlockList, isIP } from 'node:net';

const LOCAL = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '::1/128', 'fc00::/7', 'fe80::/10'];
// https://www.cloudflare.com/ips/ ，发版时核对。过期的后果只是新节点的访客共用限速桶
const CLOUDFLARE = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

const family = (ip) => (isIP(ip) === 6 ? 'ipv6' : 'ipv4');
/** 写法不对返回 false，由调用方决定怎么提示 */
function addCidr(list, cidr) {
  const [ip, bits, extra] = cidr.split('/');
  const kind = isIP(ip);
  const max = kind === 6 ? 128 : 32;
  const prefix = bits === undefined ? max : /^\d+$/.test(bits) ? Number(bits) : -1;
  if (!kind || extra !== undefined || prefix < 0 || prefix > max) return false;
  list.addSubnet(ip, prefix, family(ip));
  return true;
}
const listOf = (cidrs) => {
  const list = new BlockList();
  for (const cidr of cidrs) addCidr(list, cidr);
  return list;
};
const CLOUDFLARE_LIST = listOf(CLOUDFLARE);

/** 去掉 IPv4 映射前缀和 IPv6 的网卡后缀（BlockList 不认） */
const plainIp = (ip) => ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').replace(/%.*$/, '');

/**
 * TRUST_PROXY 留空就是自动判断。off、false、0 不看转发头；逗号分隔的 IP 或网段是额外信任的代理（Cloudflare 以外的 CDN）。
 * 1.26 及更早填的层数已经用不上，按自动判断处理。写错的项跳过并交给 warn。
 */
export function proxyTrust(value, warn = () => {}) {
  const text = (value ?? '').trim().toLowerCase();
  if (['off', 'false', 'no', '0'].includes(text)) return null;
  const proxies = listOf(LOCAL);
  if (text && !['auto', 'on', 'true', 'yes'].includes(text) && !/^[1-9]$/.test(text)) {
    for (const item of text.split(',').map((s) => s.trim())) {
      if (!addCidr(proxies, item)) warn(item);
    }
  }
  return proxies;
}

/** 写给 Worker 的访客 IP；trust 为 null 时只看真实连接 */
export function clientIp(req, trust) {
  const peer = plainIp(req.socket.remoteAddress ?? '');
  if (!trust || !isIP(peer)) return peer;
  // Cloudflare Worker 发出的请求也来自边缘地址，头却是写脚本的人定的；CF-Worker 由平台加上且去不掉，这种请求不信边缘节点
  const viaWorker = req.headers['cf-worker'] !== undefined;
  const trusted = (ip) => trust.check(ip, family(ip)) || (!viaWorker && CLOUDFLARE_LIST.check(ip, family(ip)));
  if (!trusted(peer)) return peer;
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',');
  let visitor = peer;
  for (const item of forwarded.reverse()) {
    const ip = plainIp(item.trim());
    if (!isIP(ip)) break;
    visitor = ip;
    if (!trusted(ip)) break;
  }
  // 走到头还是边缘地址：前面的代理（比如 Caddy）把 XFF 换成了连接方。此时请求确实经过 Cloudflare，它写的头可信
  if (!viaWorker && CLOUDFLARE_LIST.check(visitor, family(visitor))) {
    const edge = plainIp(String(req.headers['cf-connecting-ip'] ?? '').trim());
    if (isIP(edge)) return edge;
  }
  return visitor;
}
