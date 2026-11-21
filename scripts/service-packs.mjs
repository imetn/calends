// 把 app/src/catalog/ 下的常用服务分包接进 Worker（Worker 没有 import.meta.glob）；分包仍可选，删掉后重新构建即可。
import { readdirSync, writeFileSync } from 'node:fs';

const files = readdirSync(new URL('../app/src/catalog/', import.meta.url))
  .filter((f) => f.endsWith('.ts'))
  .sort();
const imports = files.map((f, i) => `import pack${i} from '../../app/src/catalog/${f}';\n`).join('');
const list = files.map((_, i) => `pack${i}`).join(', ');
writeFileSync(
  new URL('../worker/ai/service-packs.gen.ts', import.meta.url),
  `// 由 scripts/service-packs.mjs 生成，请勿手改\n${imports}\nexport const SERVICE_PACKS = [${list}];\n`,
);
console.log(`service packs: ${files.length}`);
