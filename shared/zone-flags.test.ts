import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';

// 应用模块读 Vite 的 import.meta.env；地区名只需要 base 的路径函数
registerHooks({
  resolve(specifier, ctx, next) {
    if (specifier.endsWith('/base.ts') && ctx.parentURL?.includes('/app/src/'))
      return { url: 'data:text/javascript,export const base=(p)=>p;export const storageKey=(k)=>k;export const BASE_PATH="";', shortCircuit: true };
    return next(specifier, ctx);
  },
});

const { zoneCountry } = await import('../app/src/zone-countries.ts');
const { deviceLocation, regionLabel } = await import('../app/src/region.ts');
const flags = new Set(readdirSync(new URL('../app/public/flags/', import.meta.url)).map((f) => f.replace('.png', '')));

test('时区对应国家：IANA 新旧名都有国旗，UTC 没有国家', () => {
  assert.equal(zoneCountry('Asia/Shanghai'), 'cn');
  assert.equal(zoneCountry('Asia/Calcutta'), 'in');
  assert.equal(zoneCountry('Asia/Kolkata'), 'in');
  assert.equal(zoneCountry('Europe/Kiev'), 'ua');
  assert.equal(zoneCountry('America/Indianapolis'), 'us');
  assert.equal(zoneCountry('UTC'), undefined);
  assert.equal(zoneCountry('Etc/GMT+3'), undefined);
  for (const zone of Intl.supportedValuesOf('timeZone')) {
    const cc = zoneCountry(zone);
    if (cc) assert.ok(flags.has(cc), `${zone} → ${cc} 没有国旗`);
    else assert.match(zone, /^(UTC|Etc\/|GMT)/, `${zone} 没有对应国家`);
  }
});

test('登录设备位置：国家代码换成国名并带国旗，未知位置不写字', () => {
  const has = (cc: string) => flags.has(cc);
  assert.deepEqual(deviceLocation('Tokyo, JP', has), { cc: 'jp', text: `${regionLabel('jp')} · Tokyo` });
  assert.deepEqual(deviceLocation('', has), { text: '' });
  assert.deepEqual(deviceLocation('T1', has), { text: 'T1' });
});
