// 容器内的 R2：把对象存成数据目录下的文件，只实现 worker/files.ts 用到的接口（head/get/put/delete/list）。
// 键只允许「前缀/64 位十六进制」，按哈希前两位分目录：/data/files/files/ab/<sha256>。写入先写临时文件再改名，读到的永远是完整内容。
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';

const KEY = /^([a-z]+)\/([a-f0-9]{64})$/;

function pathOf(root, key) {
  const m = KEY.exec(key);
  if (!m) throw new TypeError(`R2: unsupported key ${key}`);
  return join(root, m[1], m[2].slice(0, 2), m[2]);
}

/** 类型存在旁边的 .type 文件里：只在写入时由服务端判定，读取时原样带回 */
const typePath = (p) => `${p}.type`;

async function info(root, key) {
  const p = pathOf(root, key);
  try {
    const st = await stat(p);
    let contentType;
    try {
      contentType = (await readFile(typePath(p), 'utf8')).trim() || undefined;
    } catch {
      contentType = undefined;
    }
    return { p, key, size: st.size, uploaded: st.mtime, httpMetadata: contentType ? { contentType } : {} };
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

async function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return new Uint8Array(await new Response(value).arrayBuffer());
}

export function openR2(root) {
  return {
    async head(key) {
      const o = await info(root, key);
      if (!o) return null;
      const { p: _p, ...rest } = o;
      return rest;
    },
    async get(key) {
      const o = await info(root, key);
      if (!o) return null;
      const { p, ...rest } = o;
      return {
        ...rest,
        get body() {
          return Readable.toWeb(createReadStream(p));
        },
        arrayBuffer: () => new Response(Readable.toWeb(createReadStream(p))).arrayBuffer(),
      };
    },
    async put(key, value, opts = {}) {
      const p = pathOf(root, key);
      await mkdir(dirname(p), { recursive: true });
      const bytes = await toBytes(value);
      const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, bytes);
      const type = opts.httpMetadata?.contentType;
      if (type) await writeFile(typePath(p), type);
      await rename(tmp, p);
      return { key, size: bytes.byteLength, uploaded: new Date() };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const p = pathOf(root, key);
        await rm(p, { force: true });
        await rm(typePath(p), { force: true });
      }
    },
    /** 一次列出前缀下全部对象（单人账本几百个文件），不分页 */
    async list({ prefix = '' } = {}) {
      const top = prefix.replace(/\/$/, '');
      if (!/^[a-z]+$/.test(top)) throw new TypeError(`R2: unsupported prefix ${prefix}`);
      const objects = [];
      let shards = [];
      try {
        shards = await readdir(join(root, top));
      } catch (e) {
        if (e?.code !== 'ENOENT') throw e;
      }
      for (const shard of shards) {
        for (const name of await readdir(join(root, top, shard))) {
          if (!/^[a-f0-9]{64}$/.test(name)) continue;
          const st = await stat(join(root, top, shard, name));
          objects.push({ key: `${top}/${name}`, size: st.size, uploaded: st.mtime });
        }
      }
      return { objects, truncated: false };
    },
  };
}
