# 红果短剧 · 网页版
---

## 一键启动

### Windows

    scripts\start.bat

双击即可。脚本会检查 Node.js、校验签名资产、启动 unidbg 签名服务，
等待就绪后自动拉起 API 服务。浏览器访问 **<http://127.0.0.1:8000/>**。

其他模式：

    scripts\start.bat --no-sign     仅列表页（免签，免 Java 启动）
    scripts\start.bat --sign-only   仅签名服务
    scripts\sign.bat 9099           仅签名服务并指定端口
    scripts\install-jre.bat         补装 Java 运行时
    scripts\stop.bat                停止全部服务

**中文显示乱码时**：

    scripts\fix-encoding.bat        一键修复所有 bat 的 BOM / CRLF
    scripts\start-ascii.bat         纯 ASCII 启动器，乱码时直接用这个

`cmd.exe` 按系统 OEM 代码页（简体中文为 936/GBK）解析 `.bat`，
UTF-8 无 BOM 时中文会读错，脚本内的 `chcp 65001` 无法补救（它只影响运行时输出）。
官方包内的脚本均已带 BOM + CRLF；`start-ascii.bat` / `fix-encoding.bat`
更是零非 ASCII 字节，即使解压工具剥离 BOM 也始终可读可用。

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
│   ├── start-ascii.bat        纯 ASCII 启动器（乱码兜底）
│   ├── fix-encoding.bat       bat 编码一键修复
│   ├── start.sh / stop.sh     Linux / macOS
│   └── launcher.js            跨平台启动器（核心）
├── signer/
│   ├── unidbg-sign.jar      unidbg 签名服务（跨平台 fat JAR）
│   └── jre/                 自带 Windows JRE 25 LTS
├── capture/fq_oversea/      签名算法依赖的 so（路径不可改）
├── server/src/              Node.js 后端（8 模块，零依赖）
└── web/                     前端静态资源
```

---

## 注意事项

- 签名服务默认只监听 `127.0.0.1`；若把 API 改为对外暴露，
  **必须**设置 `ADMIN_TOKEN`。
- 签名服务无鉴权，勿直接暴露到公网。
- 本项目仅供技术研究与学习，请勿用于批量抓取或传播受版权保护的内容。
