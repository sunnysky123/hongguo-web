# 红果短剧 · 网页版
---

## 一键启动

### Windows

    scripts\start.bat

双击即可。脚本会检查 Node.js、校验签名资产、启动 unidbg 签名服务，
等待就绪后自动拉起 API 服务，并**自动打开浏览器**访问
**<http://127.0.0.1:8000/>**（服务真正就绪后才会打开，不会撞上白屏）。

**未安装 Node.js 时会自动调用 `install-node.bat` 下载安装最新 LTS 版本**，
装完自动刷新 PATH 并继续启动，无需手工干预。
若需跳过自动安装（CI / 离线环境），先设置环境变量 `HG_SKIP_NODE_INSTALL=1`，
此时只会提示缺失并退出。

不想自动开浏览器时，设置 `HG_OPEN_BROWSER=0` 即可。

其他模式：

    scripts\start.bat --no-sign     仅列表页（免签，免 Java 启动）
    scripts\start.bat --sign-only   仅签名服务
    scripts\sign.bat 9099           仅签名服务并指定端口
    scripts\install-node.bat        补装 Node.js（LTS）
    scripts\install-jre.bat         补装 Java 运行时
    scripts\stop.bat                停止全部服务

### PowerShell 版

每个 `.bat` 都有等价的 PowerShell 版本，行为与输出一致。
在 PowerShell 5.1（Win10/11 自带）和 PowerShell 7+ 下均可运行。

    .\scripts\start.ps1                            # 完整（签名 + API）
    .\scripts\start.ps1 -NoSign                    # 仅 API
    .\scripts\start.ps1 -SignOnly                  # 仅签名服务
    .\scripts\sign.ps1 -Port 9098                  # 指定签名端口
    .\scripts\install-node.ps1 -Force              # 装 Node.js LTS，跳过确认
    .\scripts\install-jre.ps1 -Force               # 装 Java 运行时，跳过确认
    .\scripts\stop.ps1                             # 停止全部服务

首次运行若提示脚本被禁止执行，先放开当前用户限制：

    Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

也可以只对这一次调用放开：

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1

`.bat` 与 `.ps1` 功能完全等价，**双击请继续用 `.bat`**（`.ps1` 双击默认是用记事本打开）。

### Linux / macOS

    scripts/start.sh                # 完整（签名 + API）
    scripts/start.sh --no-sign      # 仅 API
    scripts/stop.sh                 # 停止

### 免 Java 手动方式

    node server/src/server.js       # 仅免签接口，无需签名服务

---

## 环境要求

| 组件 | 版本 | 是否必需 |
|---|---|---|
| Node.js | **>= 18**（需全局 `fetch`） | 必需 |
| Java | 已自带 `signer/jre`（Temurin 25 LTS） | 仅签名接口需要 |
| ffmpeg | 任意近期版本 | 可选，剥离 CENC 信令 |

无需 `npm install`。装了 `sharp` 会用于 HEIC 封面转换，装不上自动降级。

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

    node scripts/selftest.js

预期输出 `🎉 全部自检通过`（305 项）。不联网，可在离线环境运行。

---

## 文档

| 文档 | 内容 |
|---|---|
| `研究报告.md` | 逆向分析结论、架构、算法说明、API 契约、合规声明 |
| `使用说明.md` | 环境配置、全部接口、18 个环境变量、常见问题 |
| `签名服务说明.md` | **签名服务集成细节**：目录约束、JRE、协议、排查 |

---

## 目录结构

```
hongguo-web/
├── scripts/
│   ├── start.bat              Windows 一键启动
│   ├── start.sh / stop.sh     Linux / macOS
│   ├── *.ps1                  PowerShell 版（与同名 .bat 等价）
│   └── launcher.js            跨平台启动器（核心）
├── signer/
│   ├── unidbg-sign.jar      unidbg 签名服务（跨平台 fat JAR）
│   └── jre/                 自带 Windows JRE 25 LTS
├── capture/fq_oversea/      签名算法依赖的 so（路径不可改）
├── server/src/              Node.js 后端（8 模块，零依赖）
└── web/                     前端静态资源
```

---

## 致谢

本项目的逆向分析思路与部分实现，参考自以下开源项目：

- **[hongguo-desktop-releases](https://github.com/waligoraamodio288-rgb/hongguo-desktop-releases)** —— 桌面端版本，提供了本项目最初的分析起点与对照实现，感谢原作者的分享。

---

## 注意事项

- 签名服务默认只监听 `127.0.0.1`；若把 API 改为对外暴露，
  **必须**设置 `ADMIN_TOKEN`。
- 签名服务无鉴权，勿直接暴露到公网。
- 本项目仅供技术研究与学习，请勿用于批量抓取或传播受版权保护的内容。
