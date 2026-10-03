#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Store } from './db.js';
import { CheckerService, ServiceError } from './service.js';
import { MetaError } from './torrent.js';
import { badPieces } from './verifier.js';

interface CliOptions {
  dataDir: string;
  samplesRoot: string;
}

function parseGlobal(argv: string[]): { opts: CliOptions; rest: string[] } {
  let dataDir = resolve('data');
  let samplesRoot = resolve('samples');
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data') dataDir = resolve(argv[++i]);
    else if (argv[i] === '--samples') samplesRoot = resolve(argv[++i]);
    else rest.push(argv[i]);
  }
  return { opts: { dataDir, samplesRoot }, rest };
}

function fail(e: unknown): never {
  const code = e instanceof MetaError ? e.code : e instanceof ServiceError ? e.code : 'ERROR';
  console.error(`[${code}] ${(e as Error).message}`);
  process.exit(1);
}

function usage(): never {
  console.log(`btcheck — 本地 BitTorrent v1 元信息与分片校验 CLI

用法:
  btcheck import <file.torrent>
  btcheck list
  btcheck info <id|infohash>
  btcheck pieces <id|infohash>
  btcheck piece <id|infohash> <index>
  btcheck verify <id|infohash> <相对样例根目录的子目录> [--json]
  btcheck reports [torrentId]
  btcheck report <reportId> [--bad-only]
  btcheck export <reportId> <out.json>

全局选项:
  --data <目录>      SQLite 数据目录（默认 ./data）
  --samples <目录>   样例根目录，校验路径不得越界（默认 ./samples）
`);
  process.exit(0);
}

export async function main(argv: string[]): Promise<void> {
  const { opts, rest } = parseGlobal(argv);
  const [cmd, ...args] = rest;
  if (!cmd || cmd === '-h' || cmd === '--help') usage();

  mkdirSync(opts.dataDir, { recursive: true });
  const store = new Store(resolve(opts.dataDir, 'checker.sqlite'));
  const service = new CheckerService(store);

  try {
    switch (cmd) {
      case 'import': {
        if (!args[0]) throw new ServiceError('MISSING_PARAM', '用法: import <file.torrent>');
        const { torrentId, created, meta } = service.importTorrent(resolve(args[0]));
        console.log(`${created ? '已导入' : '已更新'} #${torrentId}  infoHash=${meta.infoHash}`);
        console.log(`name=${meta.name}  pieceLength=${meta.pieceLength}  pieces=${meta.pieceCount}  total=${meta.totalLength}  files=${meta.files.length}`);
        break;
      }
      case 'list': {
        for (const t of service.listTorrents()) {
          console.log(`#${t.id}  ${t.infoHash}  ${t.name}  pieces=${t.pieceCount} files=${t.fileCount} total=${t.totalLength}`);
        }
        break;
      }
      case 'info': {
        const t = service.getTorrent(args[0]);
        console.log(JSON.stringify(t, null, 2));
        break;
      }
      case 'pieces': {
        console.log(JSON.stringify(service.listPieces(args[0]), null, 2));
        break;
      }
      case 'piece': {
        console.log(JSON.stringify(service.getPiece(args[0], Number(args[1])), null, 2));
        break;
      }
      case 'verify': {
        const asJson = args.includes('--json');
        const positional = args.filter((a) => a !== '--json');
        if (!positional[0] || !positional[1]) throw new ServiceError('MISSING_PARAM', '用法: verify <id|hash> <子目录>');
        const { reportId, report } = service.runVerify(positional[0], positional[1], opts.samplesRoot);
        if (asJson) {
          console.log(JSON.stringify({ reportId, report }, null, 2));
        } else {
          console.log(`报告 #${reportId}  状态=${report.status}  正常=${report.okCount} 内容不匹配=${report.badCount} 不可读=${report.unreadableCount}`);
          for (const f of report.files) {
            if (f.status !== 'ok') console.log(`  文件[${f.status}] ${f.path} 期望=${f.expectedLength} 实际=${f.actualLength}`);
          }
          for (const p of badPieces(report)) {
            console.log(`  分片#${p.index} [${p.status}] 字节[${p.start},${p.end}) 涉及: ${p.files.map((x) => x.path).join(', ')}`);
            for (const reason of p.reasons) console.log(`      - ${reason}`);
          }
        }
        break;
      }
      case 'reports': {
        for (const r of service.listReports(args[0] ? Number(args[0]) : undefined)) {
          console.log(`#${r.id} torrent=${r.torrentId} ${r.status} ok=${r.okCount} bad=${r.badCount} unreadable=${r.unreadableCount} ${r.verifiedAt}`);
        }
        break;
      }
      case 'report': {
        const badOnly = args.includes('--bad-only');
        const id = Number(args[0]);
        if (!id) throw new ServiceError('MISSING_PARAM', '用法: report <reportId> [--bad-only]');
        console.log(JSON.stringify(service.getReport(id, badOnly), null, 2));
        break;
      }
      case 'export': {
        if (!args[0] || !args[1]) throw new ServiceError('MISSING_PARAM', '用法: export <reportId> <out.json>');
        const out = resolve(args[1]);
        mkdirSync(dirname(out), { recursive: true });
        const written = service.exportReport(Number(args[0]), out);
        console.log(`已导出: ${written}`);
        break;
      }
      default:
        console.error(`未知命令: ${cmd}`);
        usage();
    }
  } catch (e) {
    fail(e);
  } finally {
    store.close();
  }
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
