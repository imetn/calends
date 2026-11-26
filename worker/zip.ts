// 流式 ZIP：逐个读入文件、原样存储（PDF 与图片本身已压缩），边打包边发送，内存只占当前这一块。
// 用纯 JS 版：Node 版带 createRequire，和 Docker 打包的启动横幅重名
import { Zip, ZipPassThrough } from 'fflate/browser';

export interface ZipEntry {
  name: string;
  body: ReadableStream<Uint8Array> | Uint8Array;
}

/** 同名文件加序号：a.pdf、a (2).pdf */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) return (used.add(name), name);
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 2; ; i++) {
    const next = `${base} (${i})${ext}`;
    if (!used.has(next)) return (used.add(next), next);
  }
}

export function zipStream(entries: AsyncIterable<ZipEntry>): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const pending: Uint8Array[] = [];
  let failed: unknown;
  const zip = new Zip((err, chunk) => {
    if (err) failed = err;
    else pending.push(chunk);
  });
  const flush = async () => {
    if (failed) throw failed;
    while (pending.length) await writer.write(pending.shift()!);
  };
  void (async () => {
    const used = new Set<string>();
    // 正在读的源文件：下载方中途断开时要关掉它，否则 Docker 下会留着文件句柄
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      for await (const e of entries) {
        const file = new ZipPassThrough(uniqueName(e.name, used));
        zip.add(file);
        if (e.body instanceof Uint8Array) {
          file.push(e.body, true);
        } else {
          reader = e.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            file.push(value ?? new Uint8Array(), done);
            await flush();
            if (done) break;
          }
          reader = undefined;
        }
        await flush();
      }
      zip.end();
      await flush();
      await writer.close();
    } catch (e) {
      await reader?.cancel(e).catch(() => {});
      await writer.abort(e).catch(() => {});
    }
  })();
  return readable;
}
