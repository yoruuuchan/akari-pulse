# Akari Pulse

[English](README.md) | 中文

把 vivo WATCH GT（第一代蓝牙版，型号 `WA2456C`，BlueOS 3.0）的健康数据取出来、送进自托管后端和 MCP 服务器的研究笔记与可运行参考实现。完整手表链路——手表 RPK → Cloudflare 中转 Worker → 排水进本地 Node.js 服务 → SQLite → MCP（stdio 与 Streamable HTTP）——已于 2026-08-12 在真机上端到端验证。独立的 vivo 手机本地自然日汇总链路——provider → Android Room/outbox → 单独鉴权的中转路由 → SQLite → MCP——已于 2026-08-14 端到端验证，全部证据见 [docs/REAL_DEVICE_RESULTS.md](docs/REAL_DEVICE_RESULTS.md)。

状态：参考 / 研究性质，按原样发布，不承诺维护和支持。与 vivo 无任何隶属、授权或赞助关系。可运行代码与配置中的所有端点、数据库 ID 和令牌均已替换为占位符（`REPLACE_WITH_*` 或 `pulse.example.com`）——请自备 Cloudflare Worker、D1 数据库、VPS 和隧道，默认配置不会指向任何他人的基础设施。叙述性文档中保留了作者自己部署所用的域名（`pulse.yoru-and-akari.dev`、`pulse-mcp.yoru-and-akari.dev`），因为它们是 2026-08-12 真机验证故事的一部分。

隐私提示：本项目处理的是真实的个人健康数据。请自行运行中转、数据库和 MCP，不要指向第三方的基础设施，也不要用于他人的手表。RPK 安装包刻意不随仓库发布，因为其中编译了私有入库令牌——见 [artifacts/README.md](artifacts/README.md)。

RPK 侧载路径依赖 OrbitV 社区的工作成果；没有它，这块手表根本无法安装未签名的开发者构建。

Akari Pulse 是为第一代蓝牙版 vivo WATCH GT 打造的一条私有、可审查的健康数据通路：

```text
WA2456C / BlueOS 3.0
  -> BlueOS 健康与传感器 API
  -> 手表端持久化未发送队列
  -> 经配对手机的蓝牙网络代理发起 HTTPS
  -> Cloudflare Worker 中转（D1 缓冲）
  -> 排水进 Akari Health 服务（Node.js + SQLite）
  -> 独立的 Akari Health MCP（stdio / Streamable HTTP）
  -> ChatGPT / Claude

vivo 手机本地今日活动
  -> Android Room 当前行 + 不可变 outbox
  -> 单独手机鉴权的 Worker 路由
  -> 与手表事件并列进入同一后端与 MCP 的日汇总
```

仓库包含真实的手表、安卓、服务端和 MCP 实现。其中不含演示用健康数值、vivo 开发者凭据、账号令牌或私有签名密钥。宿主机构建成功不等于真机成功：已确认的 `WA2456C / DPD2346C_A_1.54.5` 真机观测结果与未解决的重启边界，独立记录在 [REAL_DEVICE_RESULTS.md](docs/REAL_DEVICE_RESULTS.md) 中，与宿主机证据分开。

## 当前交付状态

| 层 | 宿主机结果 | 真机结果 |
|---|---|---|
| BlueOS 手表应用 | `0.1.5` 证据与边界 RPK，用 BlueOS Studio 工具链构建（`0.1.4` 的超集：`collect stats` 新增 ZERO_SENTINEL 规则和每次调用的原始负载证据、层级诊断改为逐指标分解、新增 `probe sleep` 按钮） | `0.1.2` 通过完整隔离健康链路（3/3 次冷启动全管线通过，无重启）；`0.1.3` 的 `net probe` 与 `send batch https` 于 2026-08-12 通过；`0.1.4` 三个采集+同步按钮 2026-08-12 全部真机验证——真实非零心率、血氧、压力、静息心率端到端落入 VPS 存储；`0.1.5`（versionCode 6，SHA-256 `C8AFBE32446E30D745CBCFE68C8C7D5DA101B7B58DD78CCD52167C2D7343AE76`，89,461 字节）2026-08-12 真机验证：sentinel 规则确认、SUM 统计与睡眠边界结论性确立、NOT_APPLICABLE 层语义已在服务端生效（见 [REAL_DEVICE_RESULTS.md](docs/REAL_DEVICE_RESULTS.md)） |
| 手表健康链路 | 每次启动只跑一项测试的测试框架 | `PASS` —— `getRecentSamples([HEART_RATE])` → 回调 → 解析 → UI → 队列 → 快照 → 存储稳定；没有新的失败证据不要重做 |
| 官方 BlueXlink RPC | 公开手表 API 与官方 Android AAR 均已集成 | **已关闭**：`transport init` 报 `code=1001 interconnectfeature error`；官方支持表只列 WATCH 3；vivo `appid`/`encryStr` 无法获取——见 [RESEARCH.md](docs/RESEARCH.md) |
| Cloudflare 中转 | 严格分离手表事件与手机日汇总入库路由；重放/冲突/鉴权测试通过 | `PASS` —— 2026-08-12 真机手表 HTTPS；2026-08-14 真机手机日汇总使用独立手机 secret，排空后待处理行回到 0 |
| Akari Health 服务 | 手表事件鉴权路由与幂等日汇总路由均以临时数据库测试 | `PASS` —— 既有 105 条手表记录保持不变；两批真实手机数据均 3/3 接收，当前表保留较新的三条 source-day 行 |
| Akari Health MCP | 官方 SDK 客户端可列出并调用全部 14 个工具 | `PASS` —— `health_today` 与 `health_steps` 并列暴露手机/手表；`health_latest` 仍返回真机手表记录 |
| 常驻 VPS + 远程 MCP | 部署于东京 VPS（systemd：服务、2 分钟排水定时器、Streamable-HTTP MCP、Cloudflare Tunnel） | `PASS` —— 2026-08-12 完成公网远程手表验证；2026-08-14 再验生产 MCP：协议 `2026-07-28`、14 个工具、backend ingest PASS、MCP query PASS；见 [deploy/tokyo](deploy/tokyo/README.md) |
| Android 应用 | 调试 APK 已构建、单测、lint，并验证 Room 1 -> 2 迁移 | `PASS` 2026-08-14 —— vivo 原地升级；真实 2210 步 / 1682.3701171875 米 / 98.30199432373047 千卡 provider 汇总；Room 当前行和两笔不可变 outbox 全部完成；手表接收器仍是独立后备路径 |

精确证据与"每次启动只测一项"的自适应流程见 [REAL_DEVICE_RESULTS.md](docs/REAL_DEVICE_RESULTS.md) 与 [DIAGNOSTICS.md](docs/DIAGNOSTICS.md)。

**当前工件（`0.1.5`，2026-08-12 真机验证）**：保留 `0.1.4` 全部按钮不变；给 `collect stats` 加上 `heart_rate_today_max/min` 的 `ZERO_SENTINEL` 规则（0 bpm 生理上不可能，MIN 聚合会包含离体窗口，因此判为 NO_DATA），并在每一条 stat 事件里都保留原始负载作证据；`sample_acquisition` 层诊断改成"按指标分解"的消息，代替原来的 "N PASS of M"；新增一个"每次启动只跑一个"的按钮 `probe sleep`，经 `getRecentSamples` 读取 `SLEEP_STATUS`/`SLEEP_UNIT`/`SLEEP_STAGES` 的真机结果。真机结论：sentinel 规则确认；SUM 统计的 success 回调是字面上的空对象 `{}`（没有任何字段），是本固件对侧载 quick app 的能力边界；睡眠能力边界已确立——只能拿到瞬时 `SLEEP_STATUS`，`SLEEP_UNIT`、`SLEEP_STAGES`、`health.getStatistic` 在运行时均不可用；服务端 `NOT_APPLICABLE` 层语义已生效。VPS 存储：94 条记录（67 PASS，25 NO_DATA，2 ERROR）。完整验收结果见 [REAL_DEVICE_RESULTS.md](docs/REAL_DEVICE_RESULTS.md)，收紧后的契约与设备怪癖见 [DIAGNOSTICS.md](docs/DIAGNOSTICS.md)。

上一版真机验证工件（`0.1.4`，2026-08-12）：三个采集+同步按钮均端到端通过——真实非零心率（实时 62 bpm、静息 61）、血氧（99%）、压力（35）落入 VPS 存储并可经远程 MCP 查询。全部 SUM 日统计返回空（设备能力边界，`0.1.5` 的原始负载 dump 已结论性回答这个悬案）。

本仓库不发布二进制文件（见 [artifacts/README.md](artifacts/README.md)）；下表是私有构建并经真机验证的工件的历史哈希记录。

| 工件 | 字节数 | SHA-256 |
|---|---:|---|
| `akari-pulse-android-debug-0.1.0.apk` | 31,164,014 | `D5F43C1D2F0468DF7CF71594320DE9E9748DB2410D480361E825A3ACC570C6D5` |
| `akari-pulse-watch-debug-0.1.5.rpk` | 89,461 | `C8AFBE32446E30D745CBCFE68C8C7D5DA101B7B58DD78CCD52167C2D7343AE76` |
| `akari-pulse-watch-debug-0.1.4.rpk` | 84,899 | `AF16F9E39CEBB67AB79408B03668907CD40BBBFB6F6705599A9C8808FC63372B` |
| `akari-pulse-watch-debug-0.1.3.rpk` | 75,466 | `BFCCEA5B7181BFE20C7B547EA05E5025DC7DE76703A98A60D75BF95D1328E0A1` |
| `akari-pulse-watch-debug-0.1.2.rpk` | 69,649 | `D5A368469F556A379575178ACFA57530D35546D44742433788F13ED8EE0E98C6` |
| `akari-pulse-server-0.1.0.tgz` | 15,674 | `58AEC6FC70C221D0E910AB2820CA2512AE4F058F1E29E0B18532A19E88C2A07C` |
| `akari-pulse-mcp-0.1.0.tgz` | 8,757 | `7D7DA216EBF343045282EB335863184E5DAC23BF289452CA03B76FD3409DD3C1` |

Cloudflare 中转由 [relay/](relay/README.md) 部署（Worker + D1 缓冲 + 自定义域名）；令牌保存在 Cloudflare secrets 与不入库的 `relay/.secrets.local` 中。

机器可读清单、APK 签名证书摘要与内置 AAR 摘要见 [SHA256SUMS.txt](artifacts/SHA256SUMS.txt)。

## 仓库结构

```text
akari-pulse/
|-- watch/       BlueOS 健康采集、持久化队列、HTTPS/RPC 适配器、诊断 UI
|-- relay/       Cloudflare Worker 入库缓冲与 D1 表结构
|-- android/     手机本地日汇总，以及后备手表接收器
|-- server/      Node.js 24 HTTP 服务与 SQLite 持久化
|-- mcp/         独立 MCP（stdio + Streamable HTTP），基于官方 TypeScript SDK
|-- deploy/      东京 VPS systemd 单元与运维手册（常驻存储 + 远程 MCP）
|-- contracts/   严格的共享事件与批次模式
|-- scripts/     安装、启动、冒烟、中转排水与精确 tailnet 绑定脚本
|-- docs/        架构、调研、诊断、测试与真机证据
`-- artifacts/   构建交付物说明与 SHA-256 清单
```

## 架构选择

手表生产路线仍是直连 HTTPS：`@blueos.network.fetch` 把不可变事件批次 POST 到 `pulse.yoru-and-akari.dev` 的 Cloudflare 中转，中转在 D1 中缓冲，再由 `scripts/drain-relay.mjs` 排水进本地 Akari Health 服务。与它独立的是，Android 应用读取 vivo 手机累计自然日活动汇总，经单独鉴权的 `/v1/health/daily-summaries` 路由上行。vivo 官方的 BlueXlink/设备 RPC 组合是最初的手表到手机候选，现仍在此硬件上关闭：真机 `WA2456C` 在 `interconnect` 连接时报 `code=1001 interconnectfeature error`，官方支持表只列 vivo WATCH 3，且本项目无法获取所需的 vivo `appid`/`encryStr`。证据与归类见 [RESEARCH.md](docs/RESEARCH.md)（中文）；Android 手表接收器仍保留可构建状态作为后备。OrbitV 仅用于 RPK 侧载，不当作通用桥接 API 使用。

所有传输共享同一份持久化契约。接收方只有在持久化存储完成后才确认手表批次（中转：D1 插入；安卓：Room 事务），手表只有在收到匹配的 `batch_id` 及准确的 accepted/duplicates 计数后才出队。中转只有在本地服务确认同一批次后才删除对应行——任何一层都不会丢弃尚未交接的数据。

手机日汇总刻意不复用手表事件契约。`source_day` 与 `source_timezone` 来自手机 provider 并决定自然日；`sampled_at` 只是桥接观察时间，绝不解释成最后一步的时间。PASS/NO_DATA/ERROR 与真实 0 原样保留。同一 `(source, metric, source_day)` 的后续观察替换当前行，同时每个上行批次保持不可变；MCP 分开返回手机和手表，不做合并或优先级覆盖。

后端是基于 `node:sqlite` 的本地 Node.js 24 服务。MCP 调用该服务而不直接打开数据库，暴露只读的原始健康工具和非破坏性的会话元数据操作。

细节与证据见 [ARCHITECTURE.md](docs/ARCHITECTURE.md) 与 [RESEARCH.md](docs/RESEARCH.md)。

## 前置条件

- Windows PowerShell 7 或 Windows PowerShell 5.1。
- Node.js 24 及以上（服务与 MCP 需要）。
- JDK 17 与 Android SDK API 35（重新构建安卓应用需要）。
- BlueOS Studio 2.x（含其自带 Node.js 与 `blueos-pack`，重新构建 RPK 需要）。
- 可选：Tailscale，用于手机到 Windows 的私网访问。
- 若要在运行时使用官方 vivo RPC：需要 vivo 开发者 `appid`、智慧终端 SDK 密钥（`encryStr`）、手机上的 vivo 健康，以及手表认可的包名/签名指纹组合。

## 安装并验证服务/MCP

在仓库根目录：

```powershell
.\scripts\install.ps1
.\scripts\verify-service.ps1
```

启动回环服务：

```powershell
.\scripts\start-server.ps1
```

若要只绑定本机当前的 Tailscale IPv4，先提供一个强随机令牌：

```powershell
$env:AKARI_HEALTH_TOKEN = '<strong-random-token>'
.\scripts\start-server-tailnet.ps1
```

tailnet 脚本从 `tailscale ip -4` 读取精确 IPv4，不会执行 `tailscale up`、不改动授权、不改 Windows 防火墙，也不修改既有 Serve/Funnel 配置。

在另一个终端启动独立 MCP：

```powershell
$env:AKARI_HEALTH_URL = 'http://127.0.0.1:8787'
$env:AKARI_HEALTH_TOKEN = '<same-token-if-configured>'
.\scripts\start-mcp.ps1
```

可直接改用的客户端示例：[codex.example.toml](mcp/config/codex.example.toml) 与 [claude-desktop.example.json](mcp/config/claude-desktop.example.json)。Bearer 令牌只放本地环境/配置，不要提交。

## 构建与配置安卓端

官方公开 AAR 内置于 `android/app/libs/device-rpc-1.0.0.17.aar`，附 SHA-256 校验文件。重新构建时，只把本机值写进已被忽略的 `android/local.properties`：

```properties
sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
VIVO_RPC_APP_ID=<numeric-vivo-appid>
```

没有 appid 就省略第二行；APK 仍能构建，UI 会如实把官方 RPC 报告为 `API_MISSING`。构建与校验：

```powershell
Set-Location .\android
.\gradlew.bat testDebugUnitTest assembleDebug lintDebug --no-daemon --max-workers=1
.\scripts\verify-device-rpc.ps1
```

用 Android Studio 或以下命令安装调试 APK：

```powershell
adb install -r .\app\build\outputs\apk\debug\app-debug.apk
```

在应用内配置 Akari Health 地址，并把手机专用上行凭据填入 `server bearer token`；Android Keystore 负责静态加密。`read today activity` 会在事务中保存三项手机日汇总，并用 WorkManager 排队上行到 `/v1/health/daily-summaries`。该凭据必须与手表中转的 `INGEST_TOKEN` 分开。`encryStr` 只填写在它自己的安全运行时输入框；appid 和密钥都就位后再启动 `official vivo rpc`。`session notification` 控件明确是尽力而为：派发不等于手表已执行，也不会创建后端会话。

仅调试构建的 HTTP 接收器允许明文，用于受控的回环/tailnet 探针。非回环监听要求至少 16 字符的独立桥接令牌。发布构建拒绝明文服务地址。

## 构建与配置手表端

手表应用直接调用当前官方模块：

- `@blueos.health.health`，权限 `watch.permission.READ_HEALTH_DATA`；
- `@blueos.hardware.sensor.sensor`，权限 `watch.permission.STEP_COUNTER`；
- `@blueos.bluexlink.connectionManager`，原生产 RPC 候选；
- `@blueos.network.fetch`，显式 HTTP 探针。

若要构建配对 RPC 版本，先把 `watch/src/config.js` 的 `phonePackage` 设为 `dev.akari.pulse.bridge`，`phoneSha256` 设为将要安装的那个 APK 的签名 SHA-256 指纹。换调试/开发者证书重打 APK 会改变指纹，需要重新构建 RPK。

按 [watch/README.md](watch/README.md) 记录的命令构建，然后通过当前的 OrbitV 侧载流程安装 RPK。仓库不携带任何手表签名私钥。BlueOS Studio 的调试构建器可生成本地调试签名；发布版 RPK 需要操作者自己的开发者证书与密钥。

自 `0.1.3` 起，手表适配器默认走 `http`，指向你自己中转的 `/v1/health/batches` 端点，入库令牌经 `watch/src/config.js` 编译进包（本仓库中为占位符 `pulse.example.com` / `REPLACE_WITH_YOUR_INGEST_TOKEN`）。把适配器改指安卓 LAN 监听器属于后备方案：填一个真机手表实际可达的地址和安卓桥令牌；本项目刻意不宣称 `127.0.0.1:23102` 在真机上会映射到手机。

## 数据与失败语义

每条手表观测都是一个不可变事件，含生产者时间戳、指标、来源设备、状态，以及可选的真实值/样本时间戳/回调间隔/会话/错误。手机自然日汇总则是由不可变上行批次支撑的带版本当前行，绝不伪装成手表事件。`PASS` 必须携带真实值，其中可以包含合法数值 0。缺失或失败的测量保持 `NO_DATA`、`DENIED`、`UNSUPPORTED`、`API_MISSING` 或 `ERROR`；任何一层都不得用旧值顶替。

失败归因到 `watch_module_api`、`permission`、`sample_acquisition`、`watch_transport`、`phone_receive`、`phone_persistence`、`uplink`、`backend_ingest`、`database` 或 `mcp_query`。从第一个非 `PASS` 的层开始，按 [DIAGNOSTICS.md](docs/DIAGNOSTICS.md) 排查。

原始健康记录没有任何更新/删除的 HTTP 或 MCP 路由。会话摘要可以基于真实样本和带时间戳的事件计算基线、峰值、增量、上升延迟和到峰时间，但都会声明：时间上的关联不构成因果。

## 测试与工件

完整可复现的验证记录见 [TESTING.md](docs/TESTING.md)。构建物校验和见 [artifacts](artifacts) 下的 `SHA256SUMS.txt`；不要假设本地同名构建就是同一份字节。

不要把 RPK/APK 构建成功、RPC 发送回调、模拟器请求或 `/healthz` 当作真机端到端通过。只有在指定基线设备上采到证据后才更新 [REAL_DEVICE_RESULTS.md](docs/REAL_DEVICE_RESULTS.md)，且不得包含令牌、SDK 密钥、序列号、MAC 地址、Cookie 或账号标识。
