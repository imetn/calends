// 打非 Docker 部署用的压缩包，目录和镜像的 /app 相同。用法：npm run package:tarball（在干净的检出里）
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.argv[2] ?? process.cwd();
// 前端构建会带上 local/ 里的个人文件，它们不能进公开的压缩包
if (existsSync(join(repo, 'local'))) {
  console.error('local/ exists: run this from a clean checkout so personal files stay out of the tarball');
  process.exit(1);
}

// 压缩包只按根路径构建，也不带个人部署的资源
for (const k of ['BASE_PATH', 'CALENDS_LOCAL']) {
  if (process.env[k]) {
    console.error(`${k} is set: unset it so the tarball matches the published build`);
    process.exit(1);
  }
}

const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const name = `calends-${version}`;
const out = join(repo, 'build', 'release');
const stage = join(out, name);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(stage, 'docker'), { recursive: true });
cpSync(join(repo, 'dist'), join(stage, 'dist'), { recursive: true });
cpSync(join(repo, 'build', 'docker', 'entrypoint.mjs'), join(stage, 'docker', 'entrypoint.mjs'));
cpSync(join(repo, 'docker', 'calends.service'), join(stage, 'calends.service'));
cpSync(join(repo, 'LICENSE'), join(stage, 'LICENSE'));

const file = `${name}.tar.gz`;
// 解压时不把 CI 的用户带到服务器上；只有 GNU tar 认这两个参数，发布都在 Linux 上打
const owner = process.platform === 'linux' ? ['--owner=0', '--group=0', '--numeric-owner'] : [];
const tar = spawnSync('tar', ['-czf', join(out, file), ...owner, '-C', out, name], { stdio: 'inherit' });
if (tar.status !== 0) process.exit(tar.status ?? 1);
rmSync(stage, { recursive: true });
const sha = createHash('sha256')
  .update(readFileSync(join(out, file)))
  .digest('hex');
writeFileSync(join(out, `${file}.sha256`), `${sha}  ${file}\n`);
console.log(join(out, file));
