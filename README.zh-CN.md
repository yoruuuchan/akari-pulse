# Akari Pulse

[English](README.md) | 中文

**Akari Pulse 是一套自托管的健康数据桥：把你自己的 vivo 手机和手表已经在采集的健康数据，
存进你自己的数据库，再通过 MCP 交给你自己的 AI 助手。**

每一层都由你自己跑：手机读取它自己的健康 Provider，你的中转缓冲上行，你的服务器存储，
你的 MCP 端点回答查询——来自 ChatGPT、Claude，或者任何你愿意接上的 MCP 客户端。
中间没有一个「Akari Pulse 云」，因为这样的服务根本不存在。

大多数人想要它的理由很直接：让 AI 助手——或者 AI 伴侣——真的能看见你昨晚睡得怎么样、
今天身体状态如何，而不是每天早上等你自己打字告诉它。这是个人健康 MCP 的一种自然用法，
但不是唯一一种；同一个端点用来做自己的健康看板或分析脚本一样合适。

## 现在能读到什么

| 数据源 | 内容 |
|---|---|
| **vivo 手机** | 每日步数 · 距离 · 卡路里 · 昨晚完整睡眠汇总（分期、中途醒来次数、睡眠评分）· 最新心率 · 最新血氧 · 最新压力 |
| **vivo 手表**（`WA2456C`） | 心率 · 静息心率 · 血氧 · 压力 · 采集器已支持的手表端诊断项 |

睡眠和三项最新体征来自 vivo 的**私有** Provider：侧载应用默认拿不到它们，
需要你自己用 ADB 授权一次——见下面的[机主 ADB 授权](#机主-adb-授权)。
步数、距离、卡路里不需要这一步。

## 这个项目守住的几条底线

- **手机和手表分开。**两个来源并列返回，不合并，也不给谁设优先级。
- **不做静默兜底。**读取失败绝不会变成缓存值、旧值、UI 抓取结果或凭空的 0。
- **缺数据就明明白白地缺。**每条观测的状态只会是 `PASS`、`NO_DATA`、`DENIED`、
  `UNSUPPORTED`、`API_MISSING` 或 `ERROR`。真实测出来的 0 仍然是 `PASS`；
  但没测到的东西永远不会被当成 0。
- **没有公共云、没有遥测、没有统计上报。**没有任何东西往外发。中转、数据库、后端、
  MCP 端点都由你自己部署。
- **AI 客户端只会拿到你这次查询的那一小段结果**，拿不到数据库。

这里处理的是真实的个人健康数据，尤其睡眠数据本身就是一份「你几点在家、几点失去意识」的
详细记录。把任何端点放到回环之外以前，请先读 [PRIVACY.md](PRIVACY.md) 和
[SECURITY.md](SECURITY.md)。

## 已验证环境

兼容性按「机型 + 固件」处理。构建成功不能证明任何一台没测过的设备也能跑。

| 设备 | 状态 |
|---|---|
| vivo X200 Pro（`V2405A` / `PD2405`，Android 15） | **已验证**，2026-08-14，基于测试当时该机上的 ROM。今日活动、私有睡眠、最新体征全部读取成功，且与 vivo 健康 UI 对照一致。 |
| vivo WATCH GT 第一代蓝牙版 `WA2456C`（BlueOS 3.0，固件 `DPD2346C_A_1.54.5`） | **已验证**，2026-08-12，手表健康链路端到端通过。 |
| 其它任何 vivo / iQOO 手机、手表、ROM 或固件 | **未验证。**私有 Provider 路线可能被 ROM 直接拒绝，那种情况下 Akari Pulse 会如实报 `NOT_GRANTED` 或 `UNSUPPORTED`，不会想办法绕过去。 |

vivo 官方 Health Kit 仍然是受支持的、不需要 ADB 的第三方路线。Akari Pulse 是机主对
自己设备的可控通路，不是一种分发机制。

状态：参考 / 研究性质，按原样发布，不承诺维护和支持。与 vivo 无任何隶属、授权或赞助关系。
仓库里所有端点都是占位符——`pulse.example.com`、`pulse-mcp.example.com`、`REPLACE_WITH_*`
——不含任何真实令牌、凭据或签名密钥。

RPK 侧载路径依赖 OrbitV 社区的工作成果；没有它，这块手表根本无法安装未签名的开发者构建。

## 各个部分怎么串起来

```text
vivo 手机                                        vivo WATCH GT（WA2456C）
  步数 Provider   -> 日活动汇总                    BlueOS 健康与传感器 API
  私有 sleep      -> 睡眠汇总                      手表端持久化未发送队列
  私有 care       -> 最新心率 / 血氧 / 压力         经配对手机发起 HTTPS
      |                                                 |
      +--> Android 桥接：Room + 不可变 outbox <----------+
                              |
                              v
              Cloudflare Worker 中转（D1 缓冲）       你自己部署
                              |
                              v
              Akari Health 服务（Node.js + SQLite）   你自己部署
                              |
                              v
              Akari Health MCP（stdio / Streamable HTTP）
                              |
                              v
                  ChatGPT / Claude / 任意 MCP 客户端
```

这条路上跑着三种形状的数据，刻意分开：

- **日活动**是自然日累计汇总——每个 `(source, metric, source_day)` 一条当前行，
  同一天的后续读取替换它。
- **睡眠**是一段有边界、有分期的区间，不是日计数器，所以给它单独一份契约——
  每个 `(source, source_day)` 一条当前行。
- **最新体征**是单个带时间戳的观测，各自携带 provider 自己的测量时间，
  绝不改头换面变成日最小值、最大值、平均值或静息值。

每个上行批次都是不可变的，每个接收方都只在持久化完成之后才确认。中转只有在后端确认了
同一个批次之后才删除对应行——任何一层都不会丢弃尚未交接的数据。

完整细节见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)，逆向调研证据见
[RESEARCH.md](docs/RESEARCH.md)。

## 仓库结构

每个组件都有自己的 README，先从你要改的那一层看起。

| 路径 | 是什么 |
|---|---|
| [`watch/`](watch/README.md) | BlueOS 健康采集、持久化队列、HTTPS/RPC 适配器、诊断 UI |
| [`android/`](android/README.md) | 手机本地日汇总、vivo 私有睡眠/体征，以及后备手表接收器 |
| [`relay/`](relay/README.md) | Cloudflare Worker 入库缓冲与 D1 表结构 |
| [`server/`](server/README.md) | Node.js 24 HTTP 服务与 SQLite 持久化 |
| [`mcp/`](mcp/README.md) | 独立 MCP（stdio + Streamable HTTP），基于官方 TypeScript SDK |
| [`deploy/`](deploy/tokyo/README.md) | 常驻存储 + 远程 MCP 的 systemd 单元与运维手册 |
| [`contracts/`](contracts/README.md) | 严格的共享事件与批次模式 |
| [`docs/`](docs/ARCHITECTURE.md) | 架构、调研、诊断、测试与真机证据 |
| [`artifacts/`](artifacts/README.md) | 交付物策略与 SHA-256 清单（不发布二进制） |
| `scripts/` | 安装、启动、冒烟、中转排水、ADB 授权与 tailnet 绑定脚本 |

[SPEC.md](SPEC.md) 是实现要满足的产品与数据模型要求。

## 前置条件

- Windows PowerShell 7 或 Windows PowerShell 5.1。
- Node.js 24 及以上（服务与 MCP 需要）。
- JDK 17 与 Android SDK API 35（重新构建安卓应用需要）。
- Android platform-tools（`adb`）在 `PATH` 上（私有 Provider 授权需要）。
- BlueOS Studio 2.x（含其自带 Node.js 与 `blueos-pack`，重新构建 RPK 需要）。
- 可选：Tailscale，用于手机到 Windows 的私网访问。
- 可选，若要在运行时用 vivo 官方 RPC：vivo 开发者 `appid`、智慧终端 SDK 密钥
  （`encryStr`）、手机上的 vivo 健康，以及手表认可的包名/签名指纹组合。

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

tailnet 脚本从 `tailscale ip -4` 读取精确 IPv4，不会执行 `tailscale up`、不改动授权、
不改 Windows 防火墙，也不修改既有 Serve/Funnel 配置。

在另一个终端启动独立 MCP：

```powershell
$env:AKARI_HEALTH_URL = 'http://127.0.0.1:8787'
$env:AKARI_HEALTH_TOKEN = '<same-token-if-configured>'
.\scripts\start-mcp.ps1
```

可直接改用的客户端示例：[codex.example.toml](mcp/config/codex.example.toml) 与
[claude-desktop.example.json](mcp/config/claude-desktop.example.json)，路径按你自己的机器改。
Bearer 令牌只放本地环境/配置，不要提交。

想要「电脑关机也能查」的常驻部署，systemd 单元与运维手册在
[deploy/tokyo](deploy/tokyo/README.md)。请把最终那个 MCP URL 当成密码：
那串猜不到的路径**本身就是**凭据。

## 构建与配置安卓端

官方公开 AAR 内置于 `android/app/libs/device-rpc-1.0.0.17.aar`，附 SHA-256 校验文件。
重新构建时，只把本机值写进已被忽略的 `android/local.properties`：

```properties
sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
VIVO_RPC_APP_ID=<numeric-vivo-appid>
```

没有 appid 就省略第二行；APK 仍能构建，UI 会如实把官方 RPC 报告为 `API_MISSING`。
构建与校验：

```powershell
Set-Location .\android
.\gradlew.bat testDebugUnitTest assembleDebug lintDebug --no-daemon --max-workers=1
.\scripts\verify-device-rpc.ps1
```

用 Android Studio 或以下命令安装调试 APK：

```powershell
adb install -r .\app\build\outputs\apk\debug\app-debug.apk
```

在应用内配置 Akari Health 地址，并把手机专用上行凭据填入 `server bearer token`；
Android Keystore 负责静态加密。`read today activity` 会在一个事务里保存三项手机日汇总，
并用 WorkManager 排队上行到 `/v1/health/daily-summaries`。该凭据必须与手表中转的
`INGEST_TOKEN` 分开。

仅调试构建的 HTTP 接收器允许明文，用于受控的回环/tailnet 探针。非回环监听要求至少
16 字符的独立桥接令牌。发布构建拒绝明文服务地址。

### 机主 ADB 授权

睡眠和三项最新体征在 `com.vivo.health.widget.permission` 后面，vivo 把它声明为
`signature|privileged`。**一个装好的第三方 APK 永远拿不到它**，manifest 里怎么写都没用。
在授权之前，Akari Pulse 会报 `NOT_GRANTED` 并返回空值。

这不是绕过 vivo 的权限系统，也不改动 vivo 健康的任何东西。它就是机主用 ADB
——Android 官方为此提供的工具——说一句：*这个应用，在我的手机上，可以读我自己的健康
Provider。*你随时可以撤销。

每次安装后授权一次：

```powershell
pwsh -File .\scripts\bootstrap-vivo-private-health.ps1
```

脚本不信任授权命令本身。有的 ROM 会让 `pm grant` 返回 0 却什么都没改，所以最终结论是
**从 `dumpsys package` 回读**出来的，再打印 `PASS` 或 `FAIL`。另外，遇到 adb 不存在、
没有已授权设备、接了多台设备却没给 `-Serial`、包没装、或者设备上根本没有这两个 Provider
authority 时，脚本会直接拒绝执行，不做任何改动。

撤销走同一条路，用同样的方式回读验证：

```powershell
pwsh -File .\scripts\bootstrap-vivo-private-health.ps1 -Revoke
```

授权成功后，在应用里点 `read sleep and vitals`，并确认它的能力卡片：

| 能力状态 | 含义 | 该做什么 |
|---|---|---|
| `GRANTED` | 权限已持有，两个 Provider 可读 | 什么都不用做，读取会正常工作 |
| `NOT_GRANTED` | Provider 存在，但这个构建没有权限 | 跑一遍授权脚本 |
| `UNSUPPORTED` | 这台设备上根本没有这两个 Provider authority | 这条路线在这台手机上不可用 |
| `ERROR` | 探测本身失败了，原始原因会保留 | 看它报出来的原因 |

下面这些都是在已验证设备上实测出来的，不是推测：

- **重装 APK 会清掉授权。**每次安装后都要重新跑一遍脚本。
- **系统升级、恢复出厂、换手机都可能清掉或拒绝它。**重新验证，别默认上次的结果还成立。
- **ROM 有权说不。**这时脚本报 `FAIL`，应用报 `NOT_GRANTED`。两者都不会被绕过，
  也都不会退回去用旧数据。
- **这不是 Android 或 vivo 的通用保证。**它是一台手机、一个 ROM、某个时间点的结果。

## 构建与配置手表端

手表应用直接调用当前官方模块：

- `@blueos.health.health`，权限 `watch.permission.READ_HEALTH_DATA`；
- `@blueos.hardware.sensor.sensor`，权限 `watch.permission.STEP_COUNTER`；
- `@blueos.bluexlink.connectionManager`，原生产 RPC 候选；
- `@blueos.network.fetch`，显式 HTTP 探针。

若要构建配对 RPC 版本，先把 `watch/src/config.js` 的 `phonePackage` 设为
`dev.akari.pulse.bridge`，`phoneSha256` 设为将要安装的那个 APK 的签名 SHA-256 指纹。
换调试/开发者证书重打 APK 会改变指纹，需要重新构建 RPK。

按 [watch/README.md](watch/README.md) 记录的命令构建，然后通过当前的 OrbitV 侧载流程安装
RPK。仓库不携带任何手表签名私钥。BlueOS Studio 的调试构建器可生成本地调试签名；
发布版 RPK 需要操作者自己的开发者证书与密钥。

自 `0.1.3` 起，手表适配器默认走 `http`，指向你自己中转的 `/v1/health/batches` 端点，
入库令牌经 `watch/src/config.js` 编译进包（本仓库中为占位符 `pulse.example.com` /
`REPLACE_WITH_YOUR_INGEST_TOKEN`）。因为令牌是编译进包里的，**千万不要公开发布构建好的
RPK**——轮换它需要 `wrangler secret put INGEST_TOKEN`（或等价的 REST 调用）加上重新构建手表包。
把适配器改指安卓 LAN 监听器属于后备方案：填一个真机手表实际可达的地址和安卓桥令牌；
本项目刻意不宣称 `127.0.0.1:23102` 在真机上会映射到手机。

vivo 官方的 BlueXlink/设备 RPC 组合是最初的手表到手机候选，现仍在此硬件上**关闭**：
真机 `WA2456C` 在 `interconnect` 连接时报 `code=1001 interconnectfeature error`，
官方支持表只列 vivo WATCH 3，且本项目无法获取所需的 vivo `appid`/`encryStr`。
Android 手表接收器仍保留可构建状态作为后备。OrbitV 仅用于 RPK 侧载，
不当作通用桥接 API 使用。

## 数据与失败语义

每条手表观测都是一个不可变事件，含生产者时间戳、指标、来源设备、状态，以及可选的
真实值/样本时间戳/回调间隔/会话/错误。手机自然日汇总则是由不可变上行批次支撑的
带版本当前行，绝不伪装成手表事件。手机睡眠是第三种形态：每个 source_day 一条当前行，
同样由不可变批次支撑。`PASS` 必须携带真实值，其中可以包含合法数值 0。缺失或失败的测量
保持 `NO_DATA`、`DENIED`、`UNSUPPORTED`、`API_MISSING` 或 `ERROR`；任何一层都不得用旧值顶替。

失败归因到 `watch_module_api`、`permission`、`sample_acquisition`、`watch_transport`、
`phone_receive`、`phone_persistence`、`uplink`、`vivo_private_health`、`backend_ingest`、
`database` 或 `mcp_query`。从第一个非 `PASS` 的层开始，按
[DIAGNOSTICS.md](docs/DIAGNOSTICS.md) 排查。

原始健康记录没有任何更新/删除的 HTTP 或 MCP 路由。会话摘要可以基于真实样本和带时间戳的
事件计算基线、峰值、增量、上升延迟和到峰时间，但都会声明：时间上的关联不构成因果。

MCP 暴露 14 个窄工具，每个读工具都标注了 `readOnlyHint`。完整列表与语义见
[mcp/README.md](mcp/README.md)。

## 当前交付状态

| 层 | 宿主机结果 | 真机结果 |
|---|---|---|
| BlueOS 手表应用 | `0.1.5` 证据与边界 RPK，用 BlueOS Studio 工具链构建（`0.1.4` 的超集：`collect stats` 新增 ZERO_SENTINEL 规则和每次调用的原始负载证据、层级诊断改为逐指标分解、新增 `probe sleep` 按钮） | `0.1.2` 通过完整隔离健康链路（3/3 次冷启动全管线通过，无重启）；`0.1.3` 的 `net probe` 与 `send batch https` 于 2026-08-12 通过；`0.1.4` 三个采集+同步按钮 2026-08-12 全部真机验证——真实非零心率、血氧、压力、静息心率端到端落入 VPS 存储；`0.1.5`（versionCode 6，SHA-256 `C8AFBE32446E30D745CBCFE68C8C7D5DA101B7B58DD78CCD52167C2D7343AE76`，89,461 字节）2026-08-12 真机验证：sentinel 规则确认、SUM 统计与睡眠边界结论性确立、NOT_APPLICABLE 层语义已在服务端生效（见 [REAL_DEVICE_RESULTS.md](docs/REAL_DEVICE_RESULTS.md)） |
| 手表健康链路 | 每次启动只跑一项测试的测试框架 | `PASS` —— `getRecentSamples([HEART_RATE])` → 回调 → 解析 → UI → 队列 → 快照 → 存储稳定；没有新的失败证据不要重做 |
| 官方 BlueXlink RPC | 公开手表 API 与官方 Android AAR 均已集成 | **已关闭**：`transport init` 报 `code=1001 interconnectfeature error`；官方支持表只列 WATCH 3；vivo `appid`/`encryStr` 无法获取——见 [RESEARCH.md](docs/RESEARCH.md) |
| Cloudflare 中转 | 严格分离手表事件、手机日汇总、手机睡眠汇总三条入库路由；重放/冲突/鉴权测试 5/5 通过 | `PASS` —— 2026-08-12 真机手表 HTTPS；2026-08-14 真机手机日汇总使用独立手机 secret；当天稍后真机手机事件与睡眠汇总批次同样排空到 0 待处理行 |
| Akari Health 服务 | 手表事件鉴权路由、幂等日汇总与睡眠汇总路由均以临时数据库测试，21/21 通过 | `PASS` —— schema 2 -> 3 迁移后既有手表记录原样保留；同一晚多次读取只收敛成该 source_day 的一条当前行 |
| Akari Health MCP | 官方 SDK 客户端可列出并调用全部 14 个工具，端到端 3/3 | `PASS` —— `health_sleep`、`health_heart_rate`、`health_spo2`、`health_stress` 均并列返回手机/手表，不合并、不设优先级；记录按时间倒序并给出 `latest`/`latest_by_source`，睡眠窗口按睡眠区间重叠过滤，`health_activity` 会返回手机日汇总，ACTIVE 来源停止上报时状态为 `DEGRADED` 并附带数据年龄，而不是静默 `PASS`；手动的 `WA2456C` 手表探针标记为 `HISTORICAL`——历史数据照常可查、年龄照实显示，但不参与生产健康判定 |
| 常驻 VPS + 远程 MCP | 部署于一台东京 VPS（systemd：服务、2 分钟排水定时器、Streamable-HTTP MCP、Cloudflare Tunnel） | `PASS` —— 2026-08-12 完成公网远程手表验证；2026-08-14 私有 Provider 接入后再验生产 MCP：backend ingest PASS、MCP query PASS；2026-08-17 查询层修复后再次以公网连接器 URL 对线上库复验；见 [deploy/tokyo](deploy/tokyo/README.md) |
| Android 应用 | 调试 APK 已构建、35 项单测、lint，并验证 Room 1 -> 2 与 2 -> 3 迁移 | `PASS` 2026-08-14 —— vivo 原地升级保留数据，多次真实 provider 读取，真机迁移测试 `OK (2 tests)`；今日活动、睡眠、最新体征三类读取均与 vivo 健康 UI 对照通过；公开仓库刻意不保留作者的真实健康数值 |
| vivo 私有健康 Provider | reader 单测只用合成 cursor 与合成 payload | `PASS` 2026-08-14，机型 vivo X200 Pro（`V2405A` / `PD2405`，Android 15），**且必须先有机主一次性 ADB 授权** —— 38 列睡眠 cursor 全部按列名读取，三条 provider 恒等式精确成立，中途醒来次数与 UI 一致；撤销授权后正确报 `NOT_GRANTED` 且所有值为 null，没有任何缓存兜底。其它机型 / 固件未验证 |

精确证据与「每次启动只测一项」的自适应流程见
[REAL_DEVICE_RESULTS.md](docs/REAL_DEVICE_RESULTS.md) 与 [DIAGNOSTICS.md](docs/DIAGNOSTICS.md)。

## 测试与工件

完整可复现的验证记录见 [TESTING.md](docs/TESTING.md)。跑一遍仓库级测试：

```bash
npm test
```

**本仓库不发布任何二进制**，理由见 [artifacts/README.md](artifacts/README.md)。
`SHA256SUMS.txt` 作为历史记录保留，记下了当时私有构建并经真机验证的工件：

| 工件 | 字节数 | SHA-256 |
|---|---:|---|
| `akari-pulse-android-debug-0.1.0.apk` | 31,164,014 | `D5F43C1D2F0468DF7CF71594320DE9E9748DB2410D480361E825A3ACC570C6D5` |
| `akari-pulse-watch-debug-0.1.5.rpk` | 89,461 | `C8AFBE32446E30D745CBCFE68C8C7D5DA101B7B58DD78CCD52167C2D7343AE76` |
| `akari-pulse-watch-debug-0.1.4.rpk` | 84,899 | `AF16F9E39CEBB67AB79408B03668907CD40BBBFB6F6705599A9C8808FC63372B` |
| `akari-pulse-watch-debug-0.1.3.rpk` | 75,466 | `BFCCEA5B7181BFE20C7B547EA05E5025DC7DE76703A98A60D75BF95D1328E0A1` |
| `akari-pulse-watch-debug-0.1.2.rpk` | 69,649 | `D5A368469F556A379575178ACFA57530D35546D44742433788F13ED8EE0E98C6` |
| `akari-pulse-server-0.1.0.tgz` | 15,674 | `58AEC6FC70C221D0E910AB2820CA2512AE4F058F1E29E0B18532A19E88C2A07C` |
| `akari-pulse-mcp-0.1.0.tgz` | 8,757 | `7D7DA216EBF343045282EB335863184E5DAC23BF289452CA03B76FD3409DD3C1` |

机器可读清单、APK 签名证书摘要与内置 AAR 摘要见
[SHA256SUMS.txt](artifacts/SHA256SUMS.txt)。

不要把 RPK/APK 构建成功、RPC 发送回调、模拟器请求或 `/healthz` 当作真机端到端通过。
只有真机验证后才能更新 [REAL_DEVICE_RESULTS.md](docs/REAL_DEVICE_RESULTS.md)，
公开证据不得包含真实健康数值、令牌、SDK 密钥、序列号、MAC 地址、Cookie、
私人 endpoint 或账号标识。贡献前请看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

Copyright (c) 2026 Yoru。以
[GNU Affero General Public License v3.0](LICENSE) 授权。

选 AGPL-3.0 是有意的：如果你改了 Akari Pulse 并把它通过网络提供给别人用，
那些用户有权拿到你改过的源码。自己跑一个私有实例给自己用，则没有任何义务。
