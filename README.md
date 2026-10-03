# bt-v1-checker —— 本地 BitTorrent v1 元信息与分片校验后端

仅做**离线**的 `.torrent`（BitTorrent v1）元信息解析与本地内容逐片 SHA-1 核对：

- 不连接 tracker / peer，不下载任何内容；
- 不支持磁力链接、BitTorrent v2、v1/v2 混合种子（导入即拒绝）；
- 原始 `.torrent` 与样例文件一律**只读**，不会自动修复、移动或删除。

后端形态：TypeScript + Node.js（内置 `node:sqlite`）+ HTTP JSON API + 命令行（CLI）。无 Docker、WSL、付费服务或外部在线 API 依赖。

## 工作原理

1. 用自带的 bencode 解码器解析种子，并记录顶层 `info` 字典**值**在原始文件中的字节区间。
2. `info hash` = 对该区间**原始编码字节**计算 SHA-1，绝不重新序列化/重排键后冒充原摘要。
3. 按元信息中的文件顺序，把单文件或多文件内容视为**一条连续字节流**，按 `piece length` 切片（分片可跨越文件边界，最后一片允许不足整长），逐片更新 SHA-1 后与 `pieces` 中对应的 20 字节摘要比对——**不是**把每个文件各自切片再拼结果。
4. 校验同时检查 `pieces` 长度（必须为 20 的非零倍数）及其数量与「总字节数 / piece length 向上取整」是否一致。
5. 所有文件路径只允许解析到配置的样例根目录内，`..`、绝对路径、盘符与 Windows 保留设备名一律拒绝。
6. 元信息与报告写入项目内 SQLite（`data/checker.db`），报告可保存为文件或导出 JSON；服务重启后仍可查询历史报告。

### 错误分类（不会“缺一个文件就把其余片判为通过”）

| 错误码 | 含义 |
| --- | --- |
| `METADATA_CORRUPT` | bencode 损坏、字段缺失/类型错、`pieces` 长度或数量与总字节不符等 |
| `UNSUPPORTED_FORMAT` | v2 / 混合种子（`meta_version`、`file_tree` 等） |
| `PATH_TRAVERSAL` | 文件路径逃逸出样例根目录 |
| `FILE_MISSING` | 某分片涉及的文件不存在（含应存在的空文件） |
| `LENGTH_MISMATCH` | 文件存在但长度与元信息不一致 |
| `CONTENT_MISMATCH` | 长度正确但拼接后该分片 SHA-1 不一致 |
| `TOO_LARGE` | 超过读取上限（见下） |
| `BAD_REQUEST` / `NOT_FOUND` / `INTERNAL` | 参数错误 / 资源不存在 / 内部错误 |

### 批量读取上限

- 单个 `.torrent` 文件：≤ **16 MiB**（HTTP 导入同样限制）；
- 单次连续读取预算：每 **64 MiB** 让出一次事件循环，避免长时间阻塞；
- 可校验内容总长度：≤ **20 GiB**（本工具定位为小样例核对，不做海量资源扫描、不做断点续传）。

## 环境要求

- Windows 本地运行，Node.js **≥ 22.12**（开发与验证使用 Node v25，使用内置 `node:sqlite`，无需原生编译）。

## 安装、构建

```powershell
npm install
npm run build
```

构建产物为 `dist/*.js`（`dist/cli.js` 为入口）。测试与脚本通过 Node 的 TypeScript 类型擦除直接运行源码，无需额外构建步骤。

## 生成自带样例

```powershell
npm run samples
```

生成的确定性样例（可重复运行，会重建 `samples/`）：

- `samples/torrents/single.torrent`：单文件，100 000 字节，2 片（尾片 34 464 字节）；
- `samples/torrents/multi.torrent`：多文件，共 200 000 字节、4 片，piece length 64 KiB；
  - 片 0 `[0, 65536)` 横跨 `part_a.bin` 与 `part_b.bin`；
  - 片 1 横跨 `part_b.bin`、空文件 `empty.txt`、`sub/part_c.bin`；
  - 片 3 为不足整长的尾片（3 392 字节）；
- `samples/multi/{good,bad-flip,missing,short}`：
  - `good` 全部通过；`bad-flip` 翻转 1 个字节（落在片 1）；
  - `missing` 删除 `sub/part_c.bin`；`short` 将 `part_d.bin` 截短 123 字节；
- `samples/torrents/multi.corrupt.torrent`：截断的损坏种子；
- `samples/torrents/evil-traversal.torrent`：内含 `..` 越界路径，用于安全演示。

## CLI 使用

默认使用项目内 `samples/` 与 `data/`，可用 `--sample-root`、`--data-dir` 覆盖。

```powershell
# 导入种子（输出 infoHash、分片长度/数量、文件清单与字节流偏移）
node dist/cli.js import samples/torrents/multi.torrent

# 列出已导入种子 / 文件清单 / 每个分片的字节范围与涉及文件
node dist/cli.js list
node dist/cli.js files <infoHash>
node dist/cli.js pieces <infoHash>

# 按场景目录校验（内容根为 样例根/<rootRel>）
node dist/cli.js verify <infoHash> --root-rel multi/good
node dist/cli.js verify <infoHash> --root-rel multi/bad-flip
node dist/cli.js verify <infoHash> --root-rel multi/missing
node dist/cli.js verify <infoHash> --root-rel multi/short

# 查看失败分片涉及哪些文件；列出/查看历史报告
node dist/cli.js failed-pieces <infoHash>
node dist/cli.js reports <infoHash>
node dist/cli.js report <infoHash> --report-id 2

# 保存报告到数据目录 / 导出 JSON 到指定位置
node dist/cli.js save-report <infoHash>
node dist/cli.js export <infoHash> --out report.json
```

`verify` 退出码：`0` 全部通过，`1` 存在失败分片或业务错误，`2` 参数错误。
加 `--no-save` 可只校验不落库；加 `--api http://127.0.0.1:<port>` 可改为通过运行中的 HTTP API 执行。

## HTTP API

启动服务（仅监听 `127.0.0.1`；`--port` 可省略，默认自动选择空闲端口）：

```powershell
npm start                         # 等价于 node dist/cli.js serve
node dist/cli.js serve --port 8080 --sample-root samples --data-dir data
```

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/health` | 健康检查与读取上限 |
| `POST /api/torrents` | 导入种子（原始字节为请求体，可用 `X-Torrent-Name` 传文件名） |
| `GET /api/torrents` | 列出种子 |
| `GET /api/torrents/{hash}` | 元信息摘要（分片长度/数量/文件清单） |
| `GET /api/torrents/{hash}/files` | 文件清单与字节流偏移 |
| `GET /api/torrents/{hash}/pieces` | 分片字节范围、期望 SHA-1 与涉及文件 |
| `POST /api/torrents/{hash}/verify` | 校验，body：`{"rootRel":"multi/good","save":true}` |
| `GET /api/torrents/{hash}/failed-pieces?reportId=` | 失败分片及涉及文件 |
| `GET /api/torrents/{hash}/reports` / `GET .../reports/{id}` | 历史报告列表 / 详情 |
| `POST /api/torrents/{hash}/reports/{id}` | 保存报告文件到数据目录 |
| `POST /api/torrents/{hash}/export` | 导出 JSON，body：`{"outPath":"...","reportId":1}` |
| `GET /api/reports?infoHash=` | 全部或指定种子的报告索引 |

错误响应统一为 `{ "error": "错误码", "message": "...", "details": null }`。

PowerShell 调用示例：

```powershell
$bytes = [System.IO.File]::ReadAllBytes("samples/torrents/multi.torrent")
Invoke-RestMethod -Uri http://127.0.0.1:8080/api/torrents -Method Post -ContentType application/octet-stream -Body $bytes
Invoke-RestMethod -Uri http://127.0.0.1:8080/api/torrents/<infoHash>/verify -Method Post -ContentType application/json `
  -Body '{"rootRel":"multi/bad-flip"}'
```

## 一键演示与测试

```powershell
npm run demo     # 导入→四个场景校验→失败片定位→保存报告→导出 JSON（使用 data/demo）
npm test         # 22 个测试：bencode/info hash、跨文件边界、尾片、空文件、
                 # 缺文件、长度变化、翻转字节、损坏元信息、v2 拒绝、路径越界、
                 # 源文件未被修改、SQLite 重启持久化、CLI 与 HTTP API 全流程
```

## 目录结构

```
src/            bencode / 元信息解析 / 安全路径 / 分片校验 / SQLite / API / CLI
scripts/        样例生成、一键演示、源码直跑用的 ESM 钩子
tests/          单元与集成测试
samples/        自建种子与配套样例文件（只读输入）
data/           SQLite 数据库与导出的报告（运行时生成）
```

## 明确的假设与限制

- 仅支持 BitTorrent v1（SHA-1 分片）；不处理 DHT、tracker、peer、加密、填充文件（v2 `__pad`）等。
- 文件以 `O_RDONLY` 方式打开读取；任何校验、导入、导出都不会修改种子或样例内容。
- 不做内容修复、不做断点/增量校验；历史报告以整份 JSON 存库，便于随时复查。
- 服务仅绑定本机回环地址，不提供鉴权（设计为本地单机工具）。
