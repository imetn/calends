// 接口层的小工具：请求体解析失败是客户端的错（400），不应落成 500
import { t } from '../shared/i18n.ts';

/** 带状态码的错误：由 worker/index.ts 的总兜底转成对应的 JSON 响应 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 读取 JSON 请求体；不是合法 JSON 时抛 400 */
export async function readJson<T = unknown>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, t('server.invalidJson'));
  }
}

/** 外部请求的边缘缓存只存成功响应：限流 429、上游故障页若也缓存，会把失败钉住一整个 TTL */
export const edgeCache = (ttl: number, everything = false) => ({
  cf: { cacheTtlByStatus: { '200-299': ttl, '300-599': 0 }, ...(everything ? { cacheEverything: true } : {}) },
});
