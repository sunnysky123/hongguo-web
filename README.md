# 红果短剧 · 网页版
---

## 一、先下载仓库

启动前先把整个仓库下载到本地（或把仓库克隆到本地），后续步骤都基于这份本地代码。

```bash
# 克隆仓库
git clone https://github.com/sunnysky123/hongguo-web.git

# 或直接下载 ZIP 压缩包
# https://github.com/sunnysky123/hongguo-web/archive/refs/heads/main.zip
```

下载完成后进入目录，确认结构完整：

```bash
cd hongguo-web
ls
```

应能看到 `web/`、`java/`、`server/`、`signer/`、`scripts/`、`capture/` 等目录。
`signer/` 自带了签名服务与 Windows JRE，体积较大，克隆需耐心等待。

---

## 二、一键启动

### Windows

    scripts\start.bat

双击即可。脚本会检查 Java 运行时、校验签名资产、按需构建 API 服务 JAR，
启动 unidbg 签名服务，等待就绪后拉起 API 服务，并**自动打开浏览器**访问
**<http://127.0.0.1:8000/>**（服务真正就绪后才会打开，不会撞上白屏）。

**未安装 Java 时会自动调用 `install-jre.bat` 下载安装 Temurin 25 LTS**，
装完自动刷新 PATH 并继续启动，无需手工干预。
若需跳过自动安装（CI / 离线环境），先设置环境变量 `HG_SKIP_JRE_INSTALL=1`，
此时只会提示缺失并退出。

不想自动开浏览器时，设置 `HG_OPEN_BROWSER=0` 即可。

其他模式：

    scripts\start.bat --no-sign     仅列表页（免签接口）
    scripts\start.bat --sign-only   仅签名服务
    scripts\sign.bat 9099           仅签名服务并指定端口
    scripts\install-jre.bat         补装 Java 运行时
    scripts\build-java.bat          手动构建 API 服务 JAR
    scripts\stop.bat                停止全部服务

### Linux / macOS

    scripts/start.sh                # 完整（签名 + API）
    scripts/start.sh --no-sign      # 仅 API
    scripts/stop.sh                 # 停止

### 免脚本手动方式

    java -jar java/dist/hongguo-api.jar                # 完整（自动拉起签名服务）
    java -jar java/dist/hongguo-api.jar --no-sign      # 仅 API
    java -jar java/dist/hongguo-api.jar --selftest     # 跑自检

JAR 不存在时先构建：`bash scripts/build-java.sh`（或 Windows 下双击 `build-java.bat`）。

---

## 环境要求

| 组件 | 版本 | 是否必需 |
|---|---|---|
| Java | **>= 17**（自带 `signer/jre` Temurin 25 LTS，推荐 25） | 必需 |
| ffmpeg | 任意近期版本 | 可选，剥离 CENC 信令让浏览器可直接播 |

**全链路（API 服务 + 签名服务）都跑在 Java 上，不再需要 Node.js。**
无任何第三方依赖，无需 `npm install`，也不用联网拉包 ——
构建只用 JDK 自带的 `javac` 与 `jar`。

---

## 前端功能

- 推荐 / 榜单 / 最新 / 筛选四个 tab，**回车或点按钮**触发搜索
- 弹层播放器：横屏 16:9 固定占位，加载前后不跳版；HEVC 直出不转码
- 集数按钮 + 一行五列的选集卡片
- 简介悬浮气泡（默认隐藏，不占位不抖动）
- **播放历史**：自动记录播过的剧与集数，「继续播放」从对应集数接着看
- **打开即续播**：从推荐/搜索点开看过的剧，自动跳到上次看到的那一集；
  卡片封面左下角标出「看到第 N 集」
- **收藏**：播放器内一键收藏，列表可续播；数据存浏览器 `localStorage`（各 200 条上限）
- **密钥自动获取**：首次启动自动取密钥，取不到时按 1s→2s→4s 退避重试并显示
  「获取中」状态行；拿到后卡片自动关闭。服务重启换密钥（401）也会自动换新并恢复加载
- 自动连播与下一集后台预热、暗色/浅色主题

历史与收藏的完整说明见 [使用说明.md](使用说明.md) 第 3.4 节。

---

## 自检

    java -jar java/dist/hongguo-api.jar --selftest

预期输出 `结果：62/62 全部通过`。不联网、不依赖签名服务，可在离线环境运行。

覆盖 spade 解包 5 组真值、CTR 计数器构造、逐样本 IV、AVCC 自证、
MP4 盒解析、端到端解密还原、JSON 语义、缓存路径、设备身份、剧集解析等
13 组共 62 项断言 —— 这些都是踩坑后固化的回归基线，用于判断迁移是否等价。

---

## 文档

| 文档 | 内容 |
|---|---|
| `使用说明.md` | 环境配置、全部接口、环境变量、常见问题 |
| `签名服务说明.md` | **签名服务集成细节**：目录约束、JRE、协议、排查 |

---

## 目录结构

```
hongguo-web/
├── scripts/
│   ├── start.bat / start.sh      一键启动（签名 + API）
│   ├── stop.bat / stop.sh        停止全部服务
│   ├── build-java.bat / .sh      构建 API 服务 JAR（纯 javac，无需联网）
│   ├── install-jre.bat           补装 Java 运行时
│   └── sign.bat                  仅签名服务（调试用）
├── java/
│   ├── src/com/hongguo/api/      Java 后端源码（18 个文件，零第三方依赖）
│   │   ├── Main.java             入口
│   │   ├── Launcher.java         进程编排（拉起签名服务并等就绪）
│   │   ├── Server.java           HTTP 路由
│   │   ├── SelfTest.java         自检套件
│   │   ├── core/                 Spade / Mp4 / Device / KeyStore / Safeguards
│   │   ├── service/              Signer / Client / Stream / Res
│   │   └── util/                 Json / Crypto / Http / Log
│   ├── dist/hongguo-api.jar      构建产物（不入库，start.bat 会自动构建）
│   └── build/                    编译中间产物
├── signer/
│   ├── unidbg-sign.jar           unidbg 签名服务（跨平台 fat JAR，未改动）
│   └── jre/                      自带 Windows JRE 25 LTS
├── capture/fq_oversea/           签名算法依赖的 so（路径不可改）
├── server/
│   ├── config/content-config.json  上游配置与 base_query
│   └── data/                       运行时数据（密钥、设备标识、解密缓存）
└── web/                          前端静态资源
```

> `server/src/` 下保留了迁移前的 Node.js 源码，仅作迁移对照参考，**不再参与运行**。

---

## 致谢

本项目的逆向分析思路与部分实现，参考自以下开源项目：

- **[hongguo-desktop-releases](https://github.com/waligoraamodio288-rgb/hongguo-desktop-releases)** —— 桌面端版本，提供了本项目最初的分析起点与对照实现，感谢原作者的分享。

---

## 注意事项

- 签名服务默认只监听 `127.0.0.1`；若把 API 改为对外暴露，
  **必须**设置 `ADMIN_TOKEN`。
- 签名服务无鉴权，勿直接暴露到公网。
- 不要随意删除 `server/data/device.json`：重新生成设备标识可能触发上游风控。
- 本项目仅供技术研究与学习，请勿用于批量抓取或传播受版权保护的内容。
