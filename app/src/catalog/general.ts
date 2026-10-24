// 通用：域名、应用商店等需要预设续费规则的条目
import type { CatalogEntry } from '../catalog.ts';

const entries: CatalogEntry[] = [
  {
    name: 'Cloudflare Registrar',
    file: 'cloudflare',
    aka: ['cloudflare', 'domain', '域名'],
    cat: 'domains',
    url: 'https://www.cloudflare.com/products/registrar/',
    icon: '/brands/cloudflare.svg',
    chargeLeadDays: 30,
  },
  {
    name: 'Apple App Store',
    file: 'appstore',
    aka: ['apple', 'app store', '苹果订阅'],
    cat: 'tools',
    url: 'https://apps.apple.com',
    icon: '/brands/appstore.svg',
    cancelLeadDays: 1,
  },
];

export default entries;
