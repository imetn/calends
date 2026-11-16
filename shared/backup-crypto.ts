// 自动备份文件的加密格式：完整备份 JSON 先 gzip，再用 AES-256-GCM 加密；密钥由口令经 PBKDF2-SHA256 派生。
// 口令只在浏览器里派生成密钥，服务端只存派生后的密钥（定时任务不用每次跑几十万轮派生），文件里记下盐和轮数，
// 换一台机器只凭口令就能解开。只用 Web Crypto 与 CompressionStream，浏览器、Worker、Node 都有。

export const ENCRYPTED_FORMAT = 'calends-encrypted';
export const PBKDF2_ITERATIONS = 600_000;
const MAX_ITERATIONS = 10_000_000;

/** 派生好的密钥：key 是 AES-256 原始密钥，salt 与 iterations 写进每个文件 */
export interface BackupKey {
  key: string;
  salt: string;
  iterations: number;
}

export interface EncryptedBackup {
  format: typeof ENCRYPTED_FORMAT;
  version: 1;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: 'AES-256-GCM';
  compression: 'gzip';
  iv: string;
  data: string;
}

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

/** 由口令派生密钥；不给盐时随机生成（设置口令时），给盐时用文件里记的（解密时） */
export async function deriveBackupKey(passphrase: string, salt?: string, iterations = PBKDF2_ITERATIONS): Promise<BackupKey> {
  const s = salt ? fromB64(salt) : crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: s, iterations }, base, 256);
  return { key: toB64(new Uint8Array(bits)), salt: toB64(s), iterations };
}

const aesKey = (k: string, use: KeyUsage) => crypto.subtle.importKey('raw', fromB64(k), 'AES-GCM', false, [use]);

export async function sealBackup(json: string, k: BackupKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const packed = await pipe(new TextEncoder().encode(json), new CompressionStream('gzip'));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(k.key, 'encrypt'), packed));
  const file: EncryptedBackup = {
    format: ENCRYPTED_FORMAT,
    version: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: k.iterations, salt: k.salt },
    cipher: 'AES-256-GCM',
    compression: 'gzip',
    iv: toB64(iv),
    data: toB64(data),
  };
  return JSON.stringify(file);
}

export const isEncryptedBackup = (raw: unknown): raw is EncryptedBackup => (raw as EncryptedBackup | null)?.format === ENCRYPTED_FORMAT;

/** 口令不对或文件被改过时 AES-GCM 校验失败，抛 WrongPassphrase */
export class WrongPassphrase extends Error {}

export async function openBackup(file: EncryptedBackup, passphrase: string): Promise<string> {
  // 轮数来自文件本身：设上限，免得一个改过的文件让浏览器卡死
  const n = file.kdf?.iterations;
  if (file.version !== 1 || file.cipher !== 'AES-256-GCM' || file.kdf?.name !== 'PBKDF2' || !Number.isInteger(n) || n < 1 || n > MAX_ITERATIONS)
    throw new Error('unsupported');
  const k = await deriveBackupKey(passphrase, file.kdf.salt, file.kdf.iterations);
  let packed: ArrayBuffer;
  try {
    packed = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(file.iv) }, await aesKey(k.key, 'decrypt'), fromB64(file.data));
  } catch {
    throw new WrongPassphrase();
  }
  return new TextDecoder().decode(await pipe(new Uint8Array(packed), new DecompressionStream('gzip')));
}
