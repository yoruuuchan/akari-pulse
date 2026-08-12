# Akari Pulse：BlueOS / vivo 研究结论

更新：2026-08-12（新增 BlueXlink WA2456C 判定与 HTTPS relay 路线）；初版 2026-08-09。仅使用 vivo/BlueOS/OrbitV 第一方资料、本机 SDK 工具链取证和固定提交的原始上游；未连接、修改或逆向用户设备。

## 2026-08-12：BlueXlink 在 WA2456C 上的判定（终结）

真机事实：`0.1.2` 的 `transport init` 在冷启动下 `interconnect.instance({package, fingerprint})` 正常返回实例，随后 `onError` 异步回调 `code=1001, message="interconnectfeature error"`，无 `onOpen`，未发送任何消息。

三路独立证据：

1. **官方支持表**：[BlueXlink 概述](https://developers-watch.vivo.com.cn/api/connect/introduce/)的设备支持表只列出 vivo WATCH3 一款智能终端；WATCH GT / GT2 / WATCH 5 均未列出。（官方，强）
2. **官方错误码表**：[watch 侧 API 页](https://developers-watch.vivo.com.cn/api/connect/interconnect/)定义 `onError` 码：`1000` 未知错误、`1001` 手机 APP 未安装、`1002` 手机三方 APP 和健康未连接、`1006` 蓝牙未连接、`1007` 指纹校验失败。`1001` 的官方语义与本项目现状吻合：`dev.akari.pulse.bridge` 从未持有 vivo `appid`/`encryStr`，从未在手机侧初始化 `DeviceRpcManager`，在 vivo 健康的 RPC 注册视角下等价于"未安装"。（官方，强）
3. **本机工具链取证**：`blueos.bluexlink.connectionManager` 由 blueos-pack 编译为原生 feature `system.interconnect`（build 产物 manifest 与编译后 `$app_require$("@app-module/system.interconnect")` 证实）；字符串 `interconnectfeature` 在 BlueOS Studio 2.0.5 全部扩展、模拟器、SDK 中零命中，说明该错误文本由手表原生 runtime 产生；工具链中不存在 per-feature 平台版本表或设备兼容表（manifest 缺省统一补 `minPlatformVersion: 1070`）。（本地取证，中强）

分类结论：`code=1001` 属于"**设备不支持 / vivo 凭证缺失联合阻断**"。二者无法在没有企业级 vivo 开放平台凭证或一台 WATCH 3 的情况下进一步区分，且任一修复路径（企业实名申请 appid/encryStr、换 WATCH 3）都超出本项目边界。判定：**停止在 WA2456C 上投入 BlueXlink**；`transport init` 按钮仅保留为证据生成器。不是 manifest 声明错误（feature 正确编译且实例可创建），不是指纹配置错误（那是 `1007`），不是蓝牙断开（那是 `1006`）。

## 2026-08-12：替代路线判定 → watch 直连 HTTPS（Cloudflare relay）

网络能力证据：

- WATCH GT 蓝牙版（WA2456C）**无 WiFi 硬件**（官方产品页无 WiFi 条目；多个规格库明确 "No WLAN/WiFi"）；eSIM 版走 4G。
- 但蓝牙版手表官方自带应用商店、天气、百度地图等在线功能，[PConline 问答](https://product.pconline.com.cn/itbk/top/qa/1864/18641200.html)明确"一旦手机成功连接到WiFi网络，vivoWatch GT就可以从手机获取网络接入"——即系统级存在经手机蓝牙代理的网络通路。（官方行为+社区，中强）
- [官方 fetch 文档](https://developers-watch.vivo.com.cn/api/system/fetch/)未记载协议限制、域名白名单或代理行为；[通用错误码](https://developers-watch.vivo.com.cn/api/common/error-code/)只有 200/202/300。工具链中同样没有对 http/https 的任何校验。
- **唯一残留真机门（已于 2026-08-12 关闭）**：侧载 quick app 的 `@blueos.network.fetch` 是否同样享有该代理通路。`0.1.3` 的 `net probe` 真机结果：relay HTTPS/HTTP 均 200（首次 TLS ~4 s）,miui generate_204 对照 `code=0 generic error` 且约 40 s 才失败（`timeout` 参数在该固件上不生效）。同日首个真机批次完成 watch → relay → drain → 本地服务 → MCP 全链路。详见 REAL_DEVICE_RESULTS.md。

选定路线：`watch fetch → https://pulse.yoru-and-akari.dev (Cloudflare Worker akari-pulse-relay, D1 缓冲) → scripts/drain-relay.mjs → 本地 Akari Health /v1/health/batches（契约不变）→ 既有 MCP`。理由：完全绕开 BlueXlink、vivo 凭证、Android 后台存活三个独立故障源；watch 端 http-adapter 与批次 ACK 语义零改动复用；relay 侧 2026-08-12 已完成宿主侧全链路冒烟（ingest 202/重放 200/冲突 409/校验 400/鉴权 401/drain 后 pending=0，事件落入本地 SQLite）。Android HTTP 监听（手机 LAN）与 BLE 自定义通道降级为 `net probe` 失败后的后备，优先级见下方原有 fallback 顺序。

## 2026-08-12 evening: network-path attribution experiment (0.1.4)

Controlled test on `WA2456C` to isolate which Bluetooth link provides internet to a sideloaded quick app's `@blueos.network.fetch`.

Setup: during the first `collect hr live` run the watch's only active Bluetooth link was the operator's Windows PC (used for OrbitV sideloading). The HTTPS sync failed instantly: `SEND_FAIL code=-6 message="generic error"` (same-second rejection, no timeout — contrast with the ~40 s `code=0` stall shape observed in `0.1.3` when a route exists but the endpoint is unreachable). The PC Bluetooth link provides no internet proxy.

Attribution step: operator turned the PC's Bluetooth OFF entirely, confirmed the vivo Health app on the paired phone showed the watch connected and the phone was online, cold-launched, pressed `send batch https`. Result: `BEGIN_HTTPS_POST` → `ACK_VALID` in 3 s. The frozen batch from the failed attempt (~11.5 min earlier, same `batch_id`) was accepted by the relay (accepted=8, duplicates=0).

Conclusion: the sideloaded quick app's internet path runs exclusively through the **paired phone** (vivo Health Bluetooth proxy). OrbitV on the PC is the install channel only; the PC Bluetooth link demonstrably provides no internet. This confirms the `0.1.3` `net probe` finding with a controlled single-variable experiment.

Additionally, the `code=-6` immediate-rejection shape is now distinguished from `code=0` ~40 s timeout: `-6` means no network path exists at all (only a non-internet BT link is active); `0` with ~40 s delay means a route exists but the fetch stalls (e.g. endpoint unreachable).

## 结论

优先做官方 BlueXlink/device RPC 真机 gate，并保留 watch 通过[官方 `@blueos.network.fetch`](https://developers-watch.vivo.com.cn/api/system/fetch/)直连 Akari HTTPS 的上传基线。OrbitV/vbook 只作探测，不作生产协议；仅当 RPC 在 WA2456C 上明确不可用且必须双向控制时才做 custom BLE。[BlueXlink 概述](https://developers-watch.vivo.com.cn/api/connect/introduce/)目前只明确列 vivo WATCH3，未列第一代 WATCH GT；所以 WA2456C 的 RPC、健康权限、payload 上限、后台行为均保持 `UNKNOWN`，不能由“BlueOS 3.0”推断。

## health / sensor 精确符号

[运动健康 API](https://developers-watch.vivo.com.cn/api/health/health/)声明/manifest feature 为 `blueos.health.health`，导入 `import health from '@blueos.health.health'`，权限 `watch.permission.READ_HEALTH_DATA`。公开符号：`DATA_TYPES`、`STATISTIC_TYPES`、`getRecentSamples`、`subscribeSample`/`unsubscribeSample`、`getTodayStatistic`、`getStatistic`、`subscribeTodayStatistic`/`unsubscribeTodayStatistic`。当前在线签名是 `getRecentSamples({dataTypes:[...],success,fail})`、`subscribeSample({dataType,callback,fail})`；SDK 1.1.0 d.ts 仍把前者写成单数 `dataType`，应采用 2025-06-30 在线文档并真机记录原始回调。`HEART_RATE=0`、`STEP_COUNT=5`（仅统计，时间段最小小时粒度）、`SPO2=6`、`STRESS=9`；`SLEEP_UNIT/SLEEP_STAGES/ENERGY/SPEED` 被明确标为暂不支持，必须输出 `UNSUPPORTED`，不可造零。

[传感器 API](https://developers-watch.vivo.com.cn/api/system/sensor/)声明/feature 为 `blueos.hardware.sensor.sensor`，导入 `import sensor from '@blueos.hardware.sensor.sensor'`。计步需 `watch.permission.STEP_COUNTER`：`subscribeStepCounter({callback(ret){ret.steps},fail})`、`unsubscribeStepCounter()`；`steps` 是本次手表重启后的累计值。加速度为 `subscribeAccelerometer({interval,callback,fail})`/`unsubscribeAccelerometer()`，`interval=game/ui/normal` 约为 20/60/200 ms；陀螺仪为 `subscribeGyroscope`/`unsubscribeGyroscope`，均返回 `{x,y,z}`。错误 `1000` 表示设备不支持，各符号仍须在 WA2456C 分别 probe。

## BlueXlink / Android AAR

[watch API](https://developers-watch.vivo.com.cn/api/connect/interconnect/)的 feature 为 `blueos.bluexlink.connectionManager`，导入 `@blueos.bluexlink.connectionManager`。公开面只有 `getPeerDeviceStatus`、`instance({package,fingerprint})`，以及实例的 `getReadyState`、`getPeerDeviceClientVersion`、`send`、`sendFile`、`close`、`onOpen/onClose/onMessage/onError`；watch 端没有公开 `call/notify/onResponse`，缺失即记 `API_MISSING`。当前 API/d.ts 是 `onMessage`；[2023 watch 示例](https://developers-watch.vivo.com.cn/api/connect/development-guidance/watch-guidance/)的小写 `onmessage` 不应照抄。在线 ready state 为 1/2，SDK d.ts 为 0/1，也需真机取证。

[手机 SDK 指导](https://developers-watch.vivo.com.cn/api/connect/development-guidance/rpc-sdk-guidance)公开 [device-rpc.aar](https://h5.vivo.com.cn/health/rpcsdk/new/device-rpc.aar)：`com.vivo.health.deviceRpcSdk` 1.0.0.17，versionCode 10017，min/target SDK 19/33，SHA-256 `38B9C774B7C52B16F2BA7018C37864529E8656166E3DB438C864EBC6043C95DE`。AAR 可编译，但运行必须有 appid、智能终端密钥 `encryStr` 和与 watch `fingerprint` 一致的 APK SHA-256 signer。在线文档只写 manifest key `appid`；同一 AAR 的 bytecode 先读 `vivo.health.rpc.appid`、缺失再读 `appid`，故兼容配置应将两个 key 写成同一值；`health.device.manager.version=1` 也须保留。

当前 AAR 的接收 API 是 `DeviceRpcManager.registerDataReceiver(IDataReceiver)`，回调 `onReceiveRequest/onReceiveNotification`；旧页的 `startDataReceiver/onReceiveData` 不存在。发送 API 是 `RpcClient.callSync`、`callAsync`、`notify`，action 为 `ACTION_DEVICE_BUSINESS_DATA`、目标 `pkgName("com.vivo.health")`；[手机 API](https://developers-watch.vivo.com.cn/api/connect/mobile-side/)明确 `notify` 无返回。协议建议：watch→phone `{type:"akari.health.batch.v1",data:<watch-batch>}`；phone→watch notification 为 `akari.session.start`（`session_id/started_at`）和 `.stop`（`session_id/ended_at`）。`connect.send.success()` 无响应参数，不能出队；只有 phone POST server 成功并调用 `DeviceRpcManager.onResponse(Util.responseData(...))`，且 watch 收到匹配 `batch_id` 的 `{code:0,result}` 才 ACK。该回包在 watch `onMessage` 的精确 shape 尚未被公开材料充分证明，是首要真机门。

## vbook / OrbitV 证据边界

固定 vbook commit `dfbfe35bf272cdd42046680c610e66c028e54adf`：[Transfer 只用普通 fetch，当前为 `127.0.0.1:23101`，LAN 地址明确标“模拟器用”](https://github.com/Star7-Github/vbook-master/blob/dfbfe35bf272cdd42046680c610e66c028e54adf/src/pages/Transfer/index.ux#L210-L245)；[manifest 没有 BlueXlink/BLE](https://github.com/Star7-Github/vbook-master/blob/dfbfe35bf272cdd42046680c610e66c028e54adf/src/manifest.json#L10-L50)。[日志](https://github.com/Star7-Github/vbook-master/blob/dfbfe35bf272cdd42046680c610e66c028e54adf/log/test.log#L29-L36)显示模拟器请求 `192.168.0.105:23101`，返回 `/data/user/0/com.yyh.orbitv/...`，只证明 OrbitV 当时提供手机 LAN HTTP 数据源；物理表 loopback 如何跨到手机并未证明。地址历史见 [`381f9e7`](https://github.com/Star7-Github/vbook-master/commit/381f9e7f76947c4bb084b298b072b8ab55fda184) 与 [`0fad5a6`](https://github.com/Star7-Github/vbook-master/commit/0fad5a681c87644949283861bcd7f68a308f18b6)。

[OrbitV 更新 API](https://orbitv.top/api/v1/orbitv/check-update?platform=android)当前为 2.2.1，[changelog](https://orbitv.top/api/v1/orbitv/changelog)提到扩展、SPP/RPC，但[官方 Wiki](https://wiki.orbitv.cn/)没有版本化开发 API、Android library 或消息协议。因此它可用于安装、日志和对照实验，不能作为可维护的 Akari 接口。

## Health Kit 与 fallback

[Health Kit 简介](https://developers.vivo.com/doc/d/bb71c60ceaf645b7af51a4365a5676bb)明确用户授权后可取得 vivo WATCH 运动、心率等数据；[注册说明](https://developers.vivo.com/doc/d/fe1c4a7379334f508fcbc5345db88493)要求商业账户实名、App ID/Secret、权限申请，敏感权限和正式发布各约七个工作日；[云云接口](https://developers.vivo.com/doc/d/4ea8ba1ec4cd44bd8bdaca9f3fecf795)还要求 H5 授权、预配置 redirect URI、HmacSHA256、出口 IP、默认 50 天测试期和有效合同。当前公开树没有新版地 SDK，云端运动/步数/汇总字段也不能证明可提供实时原始 PPG 或高频运动数据。

历史接口只能参考固定上游 `LFStepUtil@0cb652e445e0bcaa53f9ede3d55b12f5844d6052`：它[携带 `vivohealthkit-1.0.0.23.aar`](https://github.com/shancheli321/LFStepUtil/blob/0cb652e445e0bcaa53f9ede3d55b12f5844d6052/StepUtil/build.gradle#L23-L49)，并调用 [`PermissionController/RecordController/DataType.STEPS_DELTA`](https://github.com/shancheli321/LFStepUtil/blob/0cb652e445e0bcaa53f9ede3d55b12f5844d6052/StepUtil/src/main/java/com/lf/steputil/LFVOStepUtil.java#L47-L145)，但不是当前官方分发，不能进入发行构建。

Fallback 顺序：①真表 health/sensor 原始结果；②正式 Health Kit 并核数据粒度；③向 vivo 索取当前本地 SDK；④用户授权后按[官方 dumpsys](https://developer.android.com/tools/dumpsys)只读检查 `com.vivo.health` 的 exported component 与 permission；⑤仅对合法 APK 用官方 [apkanalyzer](https://developer.android.com/tools/apkanalyzer) 与 [apksigner](https://developer.android.com/tools/apksigner)；⑥只有具体操作已证明属于 shell 权限才考虑固定上游 [Shizuku@b844bc4](https://github.com/RikkaApps/Shizuku/blob/b844bc491f1790c72328e1a8e5b2349f8978f0ea/README.md#L28-L52)，其 README 明确提示 ADB 权限有限；⑦更深静态分析；⑧ firmware/root 最后且另立风险项目。

真机 RPC gate：验证 `initResult=true`、`getHealthDeviceVersion()>=2`、包名/签名、watch `onOpen`、双向 ping、phone response 的 watch 原始 shape、1/10/50 event、蓝牙断开后保持同一 batch/event id 重试及前后台/息屏。另用受控 Android HTTP listener 分测 watch 的 `127.0.0.1`、手机 LAN IP、公网 HTTPS，并在仅 vivo 健康、仅 OrbitV、两者同时连接时记录实际接收进程；完成前 WA2456C 的 RPC 与 loopback 状态均为 `UNKNOWN`。
