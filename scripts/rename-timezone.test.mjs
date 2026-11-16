import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameStart } from '../app/src/name-edit.ts';
import { timeZones } from '../app/src/timezones.ts';

// 用户反馈：登录设备没起过名时，点改名输入框是空的；应像 Passkey 一样带着显示的名字
test('设备改名从按钮上显示的名字开始', () => {
  assert.equal(renameStart('', 'Chrome\nmacOS'), 'Chrome macOS');
  assert.equal(renameStart('MacBook', 'Chrome\nmacOS'), 'MacBook');
  assert.equal(renameStart('', undefined), '');
});

// 用户反馈：界面为日语时，时区选择仍是英文 IANA 名
test('时区名称跟随界面语言，偏移与搜索用的 IANA 名保留', () => {
  const pick = (lang, z) => timeZones('Asia/Shanghai', lang).find((o) => o.value === z);
  assert.equal(pick('ja', 'Asia/Tokyo').label, '日本標準時 · Tokyo');
  assert.equal(pick('zh-CN', 'Europe/Paris').label, '中欧时间 · Paris');
  assert.equal(pick('ja', 'Asia/Tokyo').hint, 'GMT+9');
  assert.equal(pick('ja', 'UTC').label, 'UTC');
  // 浏览器给不出本地名的时区（只得到 GMT±hh:mm）退回 IANA 名
  assert.equal(timeZones('Etc/GMT+5', 'ja').find((o) => o.value === 'Etc/GMT+5').label, 'Etc/GMT+5');
  // 当前值不在 IANA 列表里也保留
  assert.ok(timeZones('Custom/Zone', 'ja').some((o) => o.value === 'Custom/Zone'));
});
