import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(dirname(fileURLToPath(import.meta.url)));
const root = resolve(here, '../..');
const cli = resolve(here, '../src/cli.js');

function run(args: string[]): void {
  console.log(`\n$ btcheck ${args.join(' ')}`);
  const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', cli, ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.status !== 0) console.log(`(退出码 ${r.status})`);
}

console.log('===== BitTorrent v1 本地校验演示（全程离线） =====');
run(['import', 'torrents/multi-good.torrent']);
run(['import', 'torrents/single-good.torrent']);
run(['list']);
run(['pieces', '1']);
run(['verify', '1', 'multi-good']);
run(['verify', '1', 'multi-bad']);
run(['import', 'torrents/corrupted.torrent']);
run(['reports']);
run(['export', '2', 'data/report-good.json']);
console.log('\n演示完成。报告已写入 data/report-good.json');
