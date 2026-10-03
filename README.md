# BitTorrent v1 本地元信息与分片校验后端

仅面向 **Windows 本地离线** 使用的 BitTorrent v1（BEP 3）元信息解析与内容核对服务，提供 **HTTP API** 与 **CLI** 两种入口，TypeScript + Node.js + 内置 SQLite（`node:sqlite`）实现。

- 只解析 `.torrent` 与核对本地样例文件，**不连接 tracker / peer，不下载，不支持磁力链接**
- 明确拒绝 **v2 / 混合种子**（出现 `meta version` 或 `file tree` 即报错）
- 按元信息文件顺序把全部文件视为**一条连续字节流**按 `piece length` 切分计算 SHA-1，分片可跨文件边界，尾片允许不足整长
- **info hash 取自原始文件中 info 字典的实际编码字节**（自实现 bencode 解码器记录字节区间），不会重排键序后重新编码冒充原摘要
- 区分四类问题：`missing`（文件缺失）、`length_mismatch`（长度错误）、`mismatch`（内容不匹配）、元信息损坏（`META_*`）
- 缺文件时相关分片标记为 `unreadable`，**不会把剩余分片当作全部通过**
- 校验路径强制限制在样例根目录内，拒绝 `..` 与绝对路径越界
- 原始 `.torrent` 与样例文件**只读**访问；不自动修复、不删除任何内容
- SQLite 持久化元信息摘要与每次校验报告，重启后仍可查询与导出

## 环境要求

- Windows + Node.js `>= 22.5`（开发实测 Node `v25.5.0`，使用内置 `node:sqlite`，无需安装任何数据库）
- 不需要 Docker、WSL、付费服务或外部在线 API；运行时零第三方依赖（仅构建/测试用 typescript、tsx、@types/node）

## 安装与构建

```powershell
npm install
npm run build
```

## 生成配套样例

```powershell
npm run gen-samples
```

生成内容：

- `samples/multi-good/`：多文件（`a.txt`=100、`b.bin`=150、`sub/c.log`=100、`empty.dat`=0、`d.txt`=50，共 400 字节，piece length = 128，4 片）
  - 分片 `#0` 横跨 `a.txt` + `b.bin`；`#1` 横跨 `b.bin` + `sub/c.log`；`#2` 横跨 `c.log` + 空文件 + `d.txt`；`#3` 为 16 字节尾片
- `samples/multi-bad/`：在 `b.bin` 内翻转 **1 个字节**，用于演示失败分片定位（分片 `#1`）
- `samples/single-good/payload.bin`：单文件 300 字节（3 片，尾片 44 字节）
- `torrents/*.torrent`：对应种子，另含 `torrents/corrupted.torrent`（尾部追加垃圾字节的损坏元信息）

## CLI 用法

全局选项 `--data <目录>`（默认 `./data`）、`--samples <目录>`（默认 `./samples`，校验路径不得越出此根）。

```powershell
# 导入元信息（解析 + 落库，重复导入同一 info hash 为更新）
node dist/src/cli.js import torrents/multi-good.torrent

# 列出已导入种子 / 查看文件清单与偏移
node dist/src/cli.js list
node dist/src/cli.js info 1

# 列出全部分片范围及涉及文件；查看单个分片
node dist/src/cli.js pieces 1
node dist/src/cli.js piece 1 0

# 校验样例子目录（相对 --samples 根），文本摘要或 JSON
node dist/src/cli.js verify 1 multi-good
node dist/src/cli.js verify 1 multi-bad --json

# 历史报告 / 只看错误分片 / 导出 JSON
node dist/src/cli.js reports
node dist/src/cli.js report 4 --bad-only
node dist/src/cli.js export 4 data/report.json

# 损坏元信息（应失败并给出错误码）
node dist/src/cli.js import torrents/corrupted.torrent
```

一键演示（导入、列分片、正常/损坏校验、损坏元信息、导出）：

```powershell
npm run demo
```

## HTTP API

启动服务（默认自动选择空闲端口，仅监听 `127.0.0.1`）：

```powershell
npm start                      # 自动空闲端口，启动后打印实际端口
node dist/src/server.js --port 8080                 # 指定端口
node dist/src/server.js --port 0 --samples ./samples --data ./data
```

所有响应为 JSON，错误形如 `{"error":{"code":"...","message":"..."}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查，返回样例根目录 |
| GET | `/api/torrents` | 种子列表（含文件清单、分片哈希） |
| POST | `/api/torrents` | 导入：`{"torrentPath":"..."}` |
| GET | `/api/torrents/:idOrHash` | 单个种子详情 |
| GET | `/api/torrents/:idOrHash/pieces` | 全部分片字节范围与涉及文件 |
| GET | `/api/torrents/:idOrHash/pieces/:index` | 单个分片范围 |
| POST | `/api/torrents/:idOrHash/verify` | 校验：`{"rootDir":"multi-good"}`（相对样例根，越界 403） |
| GET | `/api/reports?torrentId=1` | 报告摘要列表 |
| GET | `/api/reports/:id` | 完整报告；`?badOnly=1` 仅错误分片 |
| GET | `/api/reports/:id/pieces/:index` | 该失败分片涉及的文件 |
| POST | `/api/reports/:id/export` | `{"outPath":"..."}` 导出 JSON 文件 |

示例（PowerShell）：

```powershell
$base = 'http://127.0.0.1:8080'
Invoke-RestMethod -Method Post "$base/api/torrents" -ContentType 'application/json' `
  -Body '{"torrentPath":"torrents/multi-good.torrent"}'
Invoke-RestMethod -Method Post "$base/api/torrents/1/verify" -ContentType 'application/json' `
  -Body '{"rootDir":"multi-bad"}'
Invoke-RestMethod "$base/api/reports/1?badOnly=1"
```

## 错误码

- 元信息：`META_BENCODE_CORRUPT`（bencode 损坏）、`META_NO_INFO`、`META_NO_PIECES`、`META_PIECES_LENGTH`（pieces 非 20 倍数）、`META_PIECES_MISMATCH`（pieces 数与总字节不符）、`META_BAD_PIECE_LENGTH`、`META_V2_UNSUPPORTED`、`META_INVALID_PATH`、`META_DUP_PATH` 等
- 文件级：`missing` / `length_mismatch` / `not_a_file`（体现在报告 `files[].status`）
- 分片级：`ok` / `mismatch`（内容 SHA-1 不符）/ `unreadable`（缺文件、长度不足等不可读字节）
- 路径：`PATH_TRAVERSAL` / `PATH_ABSOLUTE`（API 返回 403）
- 通用：`MISSING_PARAM`、`BAD_JSON`、`PAYLOAD_TOO_LARGE`、`NOT_FOUND`、`TOO_LARGE`、`TOO_MANY_PIECES`

## 批量读取上限

在 `src/verifier.ts` 中显式定义：

- 单次系统读取块 `MAX_READ_CHUNK = 1 MiB`
- 单次校验总字节 `MAX_TOTAL_BYTES = 256 MiB`
- 最大分片数 `MAX_PIECE_COUNT = 200000`

超限直接返回 `TOO_LARGE` / `TOO_MANY_PIECES`，不做海量目录扫描，也不提供断点恢复。

## 数据目录

- `data/checker.sqlite`（WAL 模式）：表 `torrents`（info hash 唯一、文件清单、pieces 哈希）与 `reports`（每次校验完整 JSON）
- 删除该文件即重置；原始种子与样例始终只读

## 测试

```powershell
npm test
```

覆盖：用**独立拼接**的预期字节流计算 SHA-1 核对跨文件边界、尾片、空文件；单字节翻转定位；缺文件不会误判通过；长度变化；损坏元信息（含 pieces 长度/数量不符、v2 拒绝）；路径越界；重启后查询旧报告；源文件未被修改；JSON 导出一致。

## 目录结构

```
src/        bencode 解码 / 元信息解析 / 连续流校验 / SQLite / Service / HTTP / CLI
scripts/    种子构建、样例生成、端到端演示
test/       node:test 测试
samples/    生成的配套样例文件
torrents/   生成的 .torrent（含损坏样例）
data/       SQLite 与导出报告（运行后产生）
```

## 已知限制

- 仅 BitTorrent v1，单/多文件模式；不支持 v2、混合、磁力链接、加密扩展
- 只读本地核对，不做 announce/peer 通信与任何下载
- 不校验文件符号链接目标内容外的扩展属性，不处理超大（>256 MiB）资源
- HTTP 仅绑定回环地址且无鉴权（设计为本机工具，请勿暴露到网络）
