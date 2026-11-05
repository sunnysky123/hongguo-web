# 红果短剧 · 网页版

## 应用预览

**主界面**

![主界面截图](screenshot/main.png)

**播放器**

![播放器界面截图](screenshot/player.png)

红果短剧网页版 —— 后端 Node.js（零第三方依赖，Node 18+）+ 前端静态网页。

---

## 一、下载发行包

启动前先去 **[Releases 页](https://github.com/sunnysky123/hongguo-web/releases)**
下载与自己系统匹配的那个压缩包，解压就能跑。
**不需要克隆仓库，也不需要预装 Node** —— 每个包都自带对应平台的 Node 运行时。

### 挑哪个包

| 你的系统 | 下载的文件（`1.2.3` 为例） |
|---|---|
| Windows x86-64（绝大多数 PC） | `hongguo-web-1.2.3-Windows-x64.zip` |
| Windows ARM64（骁龙等 ARM 电脑） | `hongguo-web-1.2.3-Windows-arm.zip` |
| Linux x86-64（主流发行版、x86 云服务器） | `hongguo-web-1.2.3-Linux-x64.zip` |
| Linux ARM64（树莓派、ARM 云主机、ARM 发行版） | `hongguo-web-1.2.3-Linux-arm.zip` |
| macOS Apple 芯片（M 系列） | `hongguo-web-1.2.3-macOS-arm.zip` |
| **旧版 Linux**（x86-64，新版 Node 跑不动） | `hongguo-web-1.2.3-Linux-x64-node24.zip` |
| **旧版 Linux**（ARM64，新版 Node 跑不动） | `hongguo-web-1.2.3-Linux-arm-node24.zip` |

> 文件名里的版本号就是 `package.json` 的 `version` 字段，
> 和包内「平台说明.txt」末尾标的版本一致 —— 两者对得上就说明下对了。
>
> 七个包内置的都是**目标平台原生的** Node 运行时（nodejs.org 对
> Windows on ARM64、Linux arm64、macOS arm64 都有官方构建）。

#### `-node24` 后缀的包是什么

**仅供不兼容新版 Node.js 的机器使用**，正常环境请忽略它们。

默认包内置的是当前最新 LTS（本文写作时为 Node 26.x，实际版本以包内
「平台说明.txt」为准）。Node 26 的官方 Linux 二进制
要求较新的系统库（glibc 2.28+ 等），在 CentOS 7、Debian 9/10、
Ubuntu 18.04 这类较老的发行版上会直接起不来，典型报错：

```
./node/bin/node: /lib64/libc.so.6: version `GLIBC_2.28' not found
./node/bin/node: /usr/lib64/libstdc++.so.6: version `GLIBCXX_3.4.25' not found
bash: ./node/bin/node: cannot execute binary file
```

确认 `node -v` 或 `scripts/start.sh` 报上面这类错误时，改下带 `-node24`
的包即可 —— 它内置 Node 24.x（同一份代码，功能完全一致，只是运行时更旧、
兼容更多老系统）。能正常跑默认包的机器**不要**用这个版本，它不会更快，
也不会更省内存。

> 这两个包由 `scripts/pack.sh` 一并产出，代码、功能、配置与默认包完全相同，
> 唯一差别是 `node/` 目录里放的是 Node 24 运行时。判断包内到底是哪一版：
> 看包内「平台说明.txt」，或执行 `./node/bin/node -v`。

### 解压并确认结构

用系统自带的解压工具（Windows 下右键「全部解压缩」，
Linux / macOS 下 `unzip hongguo-web-1.2.3-*.zip`）解开后，进入解压出来的目录：

```bash
# Linux / macOS 示例：包内结构直接铺在当前目录
ls
```

应看到 `web/`、`server/`、`scripts/`、
`node/` 以及「平台说明.txt」。`node/` 就是内置的 Node.js LTS 运行时，**无需再装 Node**。

* Windows 资源管理器会多套一层 `hongguo-web-1.2.3-Windows-x64\` 同名文件夹，进不去记得再钻一层。
* 命令行 `unzip` 不会自动套文件夹，包内结构直接铺在当前目录。

包内结构就是完整可运行的程序，后面所有命令都在这个目录里执行。

### 只想跑源码的话（可选）

一般用户用不到。要改代码或自定义构建，才需要克隆仓库：

```bash
git clone https://github.com/sunnysky123/hongguo-web.git
cd hongguo-web
```

仓库本身不含 Node 运行时，从源码运行需要本机已有 Node 18+ 或自备运行时；
运行时从哪来、怎么配，见「三、环境要求」。

---

## 二、一键启动

发行包解压后进入解压目录，按平台执行：

| 平台 | 启动 | 停止 |
|---|---|---|
| Windows | 双击 `scripts\start.bat` | 双击 `scripts\stop.bat` |
| Linux / macOS | `bash scripts/start.sh` | `bash scripts/stop.sh` |

`start` 脚本会检查 Node 运行时是否就绪，直接拉起服务，
并**自动打开浏览器**访问 **<http://127.0.0.1:8000/>**。
`stop` 脚本按进程类型 + 入口脚本路径双重匹配，不会误杀其他 Node 进程。

端口、监听地址等配置都集中在「六、配置项」一节，改完保存即生效。

不想用脚本时也可以直接跑入口脚本（各平台通用）：

    node server/src/main.js                # 启动
    node server/src/main.js --config       # 查看生效配置
    node server/src/main.js --selftest     # 跑自检
    node server/src/main.js --stop         # 停掉在跑的实例
    node server/src/main.js --version      # 显示版本

后端是纯 JS 源码，**没有构建步骤**：改完 `server/src/` 下的任意文件，
重跑上面的命令即生效，无需编译、无需打包工具、无需联网。

### 自动打开浏览器

`start` 脚本启动后会在后台轮询 `GET /health`，
待 API 服务**真正就绪**（约 1~2 秒）后自动打开 <http://127.0.0.1:8000/>。

之所以轮询而不是固定延时，是因为 `Server.start()` 返回时端口虽已在听，
前端页面还要等密钥就绪才能真正可用，过早打开会看到空白页。
临时不想自动打开，见「六、配置项」的 `HG_OPEN_BROWSER`。

---

## 三、环境要求

| 组件 | 版本 | 是否必需 |
|---|---|---|
| Node 运行时 | **>= 18**；发行包已内置 `node`（**Node.js LTS**，按目标平台） | 必需 |

除此之外**不需要任何外部程序**：解密与 CENC 信令剥离全部由 Node 代码完成，
不调用 ffmpeg，也不做转码（源流 H.264 / HEVC 原样直出，由浏览器解码）。

### Node 运行时从哪来

**发行包**：每个平台的包都由 `scripts/pack.sh` 打包时放入对应平台的
Node.js LTS 运行时，解压即用，目标机无需预装 Node；
启动脚本也不会联网下载任何运行时。

Linux 另有两个 `-node24` 变体，内置 Node 24 而非最新 LTS，专供跑不动
新版 Node 的老发行版（glibc 过旧等）使用，详见「一、下载发行包 → 挑哪个包」。

**源码 checkout**：仓库里没有 Node，`start.bat` / `start.sh` 按以下顺序查找：

    node\（自行解压的） > NODE_HOME > PATH

三者都没找到时脚本会提示如何处理并退出，不会自动下载。两种处理方式：

1. 安装 Node.js 18+：<https://nodejs.org/>
2. 或把任意 Node 18+ 解压到项目的 `node\` 目录（Unix 需含 `bin/node`，Windows 需含 `node.exe`）

```bash
node -v          # 需 18+
```

> **若你的 Node 低于 18**：`package.json` 的 `engines` 声明下限为 18。
> 低版本可能缺少本项目用到的 API，建议升级，或直接用发行包自带的 `node/`。
> 发行包内的运行时与打包机同版本，不受本机 Node 影响。

---

## 四、前端使用

前端代码无需任何改动即可使用；以下为交互与行为说明。

### 打开方式

| 方式 | 地址 | 说明 |
|---|---|---|
| 同源（推荐） | <http://127.0.0.1:8000/> | 静态资源与 API 同源，无需额外配置 |
| 本地文件 | `web/index.html` 双击打开 | `API_BASE` 自动回落 `http://127.0.0.1:8000` |

### 首次使用会自动拿密钥

前端首次加载会调用 `GET /api-key` 自动签发本地密钥并存入 `localStorage`，
无需手动配置。

拿不到密钥时（比如后端还在冷启动），页面**不会把你卡在一张空卡片上**：

| 情况 | 页面表现 |
|---|---|
| 刚打开页面 | 不弹卡片，只在列表区提示「未连接到后端服务，正在自动重试…」，并告知运行 `scripts\start.bat` |
| 点「⚿」按钮 | 卡片内显示蓝色状态行「获取中…」并转圈 |
| 连续失败 | 状态行变橙色：「获取中：HTTP 503，正在第 2 次重试…」，退避 1s→2s→4s…最长 10s，最多 12 次 |
| 重试用尽 | 状态行变红并说明原因，同时保留「⚿ 重新获取」按钮 |
| 后端恢复 | 自动拿到密钥 → **卡片自动关闭** → 首页自动继续加载，全程无需操作 |

想让手动保存的密钥不被后台自动获取覆盖，在卡片第二行「或粘贴已有密钥」框里填入后点「保存」即可。

### 播放历史与收藏

两个入口，共享同一套列表组件：

| 入口 | 位置 | 作用 |
|---|---|---|
| 🕘 播放历史 | 顶栏搜索框右侧 | 查看最近播过的剧，点「继续播放」接着看 |
| ★ 我的收藏 | 顶栏搜索框右侧 | 查看收藏的剧，点「继续播放」接着看 |
| ☆/★ 收藏 | 播放器内，剧名右侧「简介」按钮后面 | 收藏/取消当前这部短剧 |

**历史**：任何一次实际起播（点卡片进播放器、点集数按钮切集、自动连播）都会
自动写入，**不需要手动操作**。同一部剧只保留一条，重复观看时更新集数并置顶。
按要求**不记录播放时间**。

**收藏**：默认不收藏，在播放器里点一下收藏按钮才会存。收藏时会记下当时播到
第几集；之后从历史/收藏续播到别的集数，收藏条目里的进度也会跟着更新，
不会出现「继续播放往回跳」。

**列表里每条显示**：封面（缺失时显示「无封面」占位块）、剧名、进度
（历史为「看到第 12 集 / 共 95 集」，收藏为「共 95 集 · 已看至第 12 集」）、
以及操作按钮：

| 列表 | 操作按钮 |
|---|---|
| 播放历史 | 继续播放 · 删除（删掉这一条记录） |
| 我的收藏 | 继续播放 · 取消（取消这部剧的收藏） |

弹层右上角还有「清空」，一次清掉当前列表（历史或收藏，二者独立）。
点遮罩或按 `Esc` 关闭弹层。

**数据存放**：全部在浏览器 `localStorage` 里，**不上传服务器**。
想迁移就自己把这两个键的 JSON 复制过去。

| 键 | 内容 | 上限 |
|---|---|---|
| `hg_history` | 播放历史 | 200 条 |
| `hg_fav` | 收藏列表 | 200 条 |

超过 200 条自动丢弃最旧的。清缓存/清站点数据会一并清掉历史与收藏。

**行为说明**：
- **从推荐/搜索点开看过的剧，会自动续播到上次看到的那一集**（例如历史记录是第 15 集，
  点开直接播第 15 集）。没看过的剧、或历史只到第 1 集时，才从第 1 集开始。
  搜索结果与推荐列表里，看过但没看完的剧会在封面左下角标出「看到第 N 集」，
  提示点开会续播。
- 历史记录里的集号超出当前总集数（剧下架、集数缩减）时，自动回落到第 1 集。
- 列表里的封面通过后端 `/img` 代理加载（与搜索结果同一套白名单），
  所以换浏览器打开时封面可能需要重新加载。

### 自动连播与预热

播放任意一集时，前端会**并行预热下一集**：

```
播放第 N 集  ──┬──> /stream?vid=<第N集>     （正在播）
                └──> /prewarm?vid=<第N+1集>  （后台解密落盘，不阻塞）
```

`/prewarm` 立即返回（实测 11ms），解密在后台进行。返回体里的 `state` 表示：

| state | 含义 |
| --- | --- |
| `cached` | 已在缓存目录，直接可用（切集秒开） |
| `warming` | 后台解密中 |

前端播放器右上角有「连播 开 / 连播 关」开关，状态存在 `localStorage` 的
`hg_autonext`（`0` 为关闭）。关闭后播完停在当前集，状态栏提示
「播放结束（连播已关闭）」；播完最后一集提示「已播完最后一集」。
单集播放（无剧集列表）时不会触发连播。

> **不做转码**：服务端只剥离 CENC 信令，源流（H.264 / HEVC）原样直出。
> 主流浏览器的 `<video>` 都能解 HEVC，服务端再转一遍只会多花十几秒并损失画质。
>
> 解密产物落在 `server/stream-cache/<vid>_<清晰度>.play.mp4`。
> 注意扩展名是 `.play.mp4` 而非 `.mp4`（剥离 CENC 信令后会改名），
> 手写脚本判断缓存是否存在时不要只找 `.mp4`。
>
> **信令剥离全程纯 JS，不调用任何外部程序**：解密后由 Node 代码删信令盒、
> 修补盒尺寸、平移 chunk 偏移、原样流拷 mdat，产物即 `.play.mp4`。
> 极端情况下文件布局超出减壳支持范围（如 moov 在文件尾部）时，产物保留为
> `<vid>_<清晰度>.raw.mp4`——内容已是解密后的明文，只是还带着 CENC 信令，
> 部分播放器会拒播；此时日志会打一条 `减壳不适用` 的 WARN。缓存命中判定
> 同时覆盖 `.play.mp4` / `.mp4` / `.raw.mp4` 三个变体。

### 剧集下载

播放器底部「集数按钮」右边有一个**「下载」按钮**（单集播放时隐藏），点击弹出范围选择卡片：

- 默认范围为**第一集到最后一集**，可手动改起始/结束集号（按上游真实集号，即选集按钮上显示的数字）；
- 确认后由**服务端后台下载**：逐集走与播放同一套流水线（取直链 → 下载 → spade 解密 → 减壳），
  成品保存到**项目根目录 `download/<剧名>/第N集.mp4`**（剧名非法字符已替换，目录可用
  `HONGGUO_DOWNLOAD_DIR` 或 `runtime.download.dir` 更改）；
- 每集最多尝试 **3 次**（含首次）。为避免批量下载时日志刷屏，**单集成功不打印日志**
  （进度看网页上的进度条，或调 `GET /download/task`）；只有每集 3 次都失败时输出一行
  WARN，任务结束时输出一行汇总（成功/失败集号、用时、目录），均在**服务端控制台**；
- 前端每 1.5 秒轮询一次进度（已完成 x/y、失败集号）。发起任务后会自动弹出**下载进度卡片**；
  之后可随时点击**主页右上角「⤓」按钮**（位于「收藏」与「切换主题」之间）重新打开，
  按钮角标显示进行中的任务数，多个剧的任务在卡片里并列展示，关闭卡片不影响后台下载；
  同一部剧同时只跑一个任务，重复发起会直接回到那个任务的进度；
- **失败剧集可手动重试**：任务结束后若存在失败集，进度卡片该行右侧会出现**「失败重试」按钮**，
  点击后在**原任务上继续跑**（任务 id 不变、进度条延续），只重下失败的那些集，成功集不重复下载；
  每集最多手动重试 **3 次**（每次重试内部仍按上面的 3 次尝试），防止无限重试 —— 已达上限的集
  按钮会置灰并提示原因；
- 已播放过的集会命中解密缓存，复制即完成，不会重复下载；
- 播放失败覆盖层里的**「下载本集」**走的是**同一条链路**，只是把范围收窄成当前这一集
  （`start === end`）：任务照样进前端任务表，顶栏「⤓」的角标与进度卡片里能看到它；
  单集播放（没有 `series_id`）时该按钮不显示，因为任务按剧建，没有剧就没有任务可排；
- **只有 ByteVC2 片源的分集也能下载**（在线播放会提示「不支持浏览器播放」，
  下载不受影响），落盘位置与批量下载一致（`download/<剧名>/第N集.mp4`），
  成品同样是剥净 CENC 信令的普通 mp4；容器标签还会自动改写为标准 VVC
  （`bvc2`→`vvc1`、`bv2C`→`vvcC`），ffmpeg / VLC 4 / mpv 可直接打开。
  这类编码的播放器选择见常见问题「当前剧集不支持浏览器播放」。

```bash
# 等价 API：启动任务（后台执行，立即返回）
curl -X POST -H "x-api-key: <key>" -H "Content-Type: application/json" \
  -d '{"series_id":"7621200213801176126","start":1,"end":10}' \
  http://127.0.0.1:8000/download/task

# 查询进度
curl -H "x-api-key: <key>" "http://127.0.0.1:8000/download/task?id=<task_id>"
```

### 列表分页与「加载更多」

「推荐 / 榜单 / 最新 / 筛选」与搜索的网格末尾会挂一张**「加载更多」卡片**，
点击它加载下一页，点击后卡片转为「加载中…」并转圈，此时不可再次点击；
数据取尽后该卡片变为「已经到底了」并停止响应。

> 用的是显式点击而非滑动到底自动加载：移动端浏览器的滚动到底触发不稳定
> （快速滚动、列表重排、惯性未停时都容易漏触发），显式按钮更可控。

新卡片只追加不重绘，滚动位置不会跳动，「加载更多」卡片始终保持在网格最后一项。

列表类接口都接受分页参数，便于脚本按需取全量：

| 接口 | 分页参数 | 说明 |
|---|---|---|
| `/rank` | `offset` | 偏移量，响应含 `has_more` 与 `next_offset` |
| `/latest` | `offset` + `seen` | `seen` 为已取过的 series_id 逗号串，用于去重 |
| `/browse` | `offset` + `seen` | 同上 |
| `/search` | `offset` | 响应含 `has_more` 与 `next_offset` |

首屏不带分页参数时行为与从前一致。`seen` 只回传最近一段（前端取尾部
若干条），因为上游 `filter_ids` 过长会显著增大请求体。

---

## 五、API 列表

除 `/`、`/ui`、`/img`、`/health`、`/api-key`、`/stats`、`/admin/*` 外，
所有接口都需带本地密钥：

```bash
curl -H "x-api-key: <你的 key>" "http://127.0.0.1:8000/rank?board=recommend"
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 服务与端点自述 |
| GET | `/health` | 健康检查（含签名方式状态） |
| GET | `/api-key` | 自动签发本地密钥（免鉴权） |
| GET | `/search?q=&page=` | 搜索（本地签名，自动走官网/App 双通道） |
| GET | `/search/page?q=&page=` | 同上，分页别名 |
| GET | `/share/resolve?text=` | **红果 App 分享文案/链接解析**（返回对应剧集 `series_id` 与分享所在集号） |
| POST | `/share/resolve` | 同上，body `{ "text": "<整段分享文案>" }`（也接受 `url` / `link`） |
| GET | `/rank?board=recommend\|hot\|new&limit=` | 榜单 |
| GET | `/latest?genre=short_play\|comic_series\|ai_series&only_today=true` | 最新 |
| GET | `/filters?genre=short_play` | 筛选维度 |
| GET | `/browse?genre=&theme=&sort=&days=` | 组合浏览 |
| GET | `/episodes?series_id=` | 剧集列表 |
| POST | `/metrics/batch` | 批量上报播放进度 |
| GET | `/play?series_id=&ep=1-10` | 取各集直链（`encrypted_url` 为上游直链，可播放用 `stream_url`） |
| GET | `/video_url?vid=` | 单集取直链 |
| GET | `/stream?vid=&quality=1080p` | **可播放**（服务端离线解密，支持 Range） |
| GET | `/stream?series_id=&ep=1` | 同上，按集号 |
| GET | `/prewarm?vid=` | **预热下一集**（后台解密落盘，立即返回，供自动连播用） |
| GET | `/img?u=<URL>` | 图片代理（含 HEIC 转换） |
| POST | `/download/task` | **下载剧集**（body `{series_id,start,end}`，后台执行，返回任务快照；`start === end` 就是下载单集） |
| GET | `/download/task?id=` | 查询下载任务进度（`done`/`total`/`failed`/`status`） |
| POST | `/download/task/retry` | **重试失败剧集**（body `{id,indexes?}`，在原任务上继续跑，id 不变；`indexes` 省略 = 全部失败集，每集最多手动重试 3 次） |
| GET | `/stats` | 运行统计 |
| GET/POST/DELETE | `/admin/keys`, `/admin/keys/revoke` | 密钥管理（需 `ADMIN_TOKEN`） |

### 健康检查

```bash
curl http://127.0.0.1:8000/health
```

```json
{
  "ok": true,
  "uptime_s": 313,
  "sign_backends": [
    { "url": "local", "ready": true, "probe": "pure-sign" }
  ],
  "api_host": "api5-normal-sinfonlinea.fqnovel.com"
}
```

> `sign_backends` 是兼容旧版 consumers 的形状字段，
> `url: "local"` 表示签名在本进程内完成，恒就绪。
> 响应里已没有 `ffmpeg` / `transcode` / `h264_encoder` 字段：服务端不做转码，
> 也从不调用外部程序。

### 播放示例

```bash
# 按 vid + 清晰度
curl -H "x-api-key: <key>" \
  "http://127.0.0.1:8000/stream?vid=7621226646028160024&quality=1080p" -o ep1.mp4

# 按剧集 + 集号（文件名自动带上剧名）
curl -H "x-api-key: <key>" \
  "http://127.0.0.1:8000/stream?series_id=7621200213801176126&ep=1" -o ep1.mp4
```

`quality` 可取 `360p` / `480p` / `540p` / `720p` / `1080p` 或 `best`（默认，取最大体积）。
支持 `Range` 请求（返回 `206 Partial Content`），播放器可拖动进度。

### 分享链接解析

把手机「红果短剧 App」里复制出来的**整段分享文案**直接丢给接口即可，不需要
自己先把链接抠出来（文案里的《剧名》会作为兜底提示）：

```bash
curl -X POST -H "x-api-key: <key>" -H "Content-Type: application/json" \
  -d '{"text":"漫剧《冷宫开席：陛下又来蹭饭了第四季》 - 免费好剧，尽在红果 点击链接打开👉https://novelquickapp.com/s/5em_xJT-hmg/ 复制本条消息后，打开「红果短剧App」后免费看全集~"}' \
  "http://127.0.0.1:8000/share/resolve"

# 也可以 GET：/share/resolve?text=<URL 编码后的文案或链接>
```

响应（节选）：

```json
{
  "ok": true,
  "share_url": "https://novelquickapp.com/s/5em_xJT-hmg/",
  "landing_url": "https://novelquickapp.com/hongguo/ug/pages/video-animation-share?video_id=7704293880799185982&vid=...",
  "series_id": "7704293880799185982",
  "title": "冷宫开席：陛下又来蹭饭了第四季",
  "episode_cnt": 109,
  "episode": { "index": 94, "vid": "7704295599830486041", "total": 109 },
  "matched_by": "video_id",
  "verified": true,
  "candidates": [],
  "episodes_url": "/episodes?series_id=7704293880799185982"
}
```

解析链路：域名白名单 → 逐跳展开 302 短链 → 取落地页 `video_id`
（漫剧分享里就是 `series_id`）/ `vid` → 读落地页 SSR 数据里的剧名、封面、
简介、分集表 → 调 `/episodes` 校验 id 与剧名一致 → 用 `vid` 定位分享所在集号。
拿不到 id 或 id 与剧名不符时，自动退回按剧名搜索；`matched_by` 说明最终命中方式，
`verified=false` 表示上游校验失败、仅凭链接里的 id 返回。服务端只对分享域名
（如 `novelquickapp.com` / `hongguoduanju.com`）发起请求，结果按短链缓存 10 分钟。

失败时返回 `{ "detail": "..." }`：文案里没有链接或域名不支持为 `400`，
未匹配到剧集为 `404`，分享页打不开为 `502`。

---

## 六、配置项

通过环境变量与 `server/config/config.json` 传入，均有合理默认值；
优先级为 **命令行参数 > 环境变量 > 配置文件 > 内置默认值**。

| 变量 | 默认 | 说明 | 配置文件 |
|---|---|---|---|
| `PORT` | `8000` | 监听端口 | `api.port` |
| `BIND_HOST` | `127.0.0.1` | 监听地址。**改成 `0.0.0.0` 即对外暴露，务必同时设 `ADMIN_TOKEN`** | `api.host` |
| `ADMIN_TOKEN` | 空 | `/admin/*` 与 `/stats` 的管理令牌。不设时首次启动自动生成 64 位口令并写入 `server/config/apikeys.json` 的 `admin_token`，重启沿用；环境变量优先 | `server/config/apikeys.json` 的 `admin_token` |
| `RATE_PER_MIN` | `120` | 每分钟请求上限（限流） | 无，仅环境变量 |
| `HG_THROTTLE_MS` | `260` | 上游请求串行节流间隔（毫秒） | `runtime.throttle_ms` |
| `HONGGUO_HOST` | 见 config | 上游 host | 无（默认取 `config.json` 的 `upstream.api_host`） |
| `HONGGUO_UA` | `hongguo-web/1.0` | 上游 User-Agent | 无（默认取 `config.json` 的 `upstream.session_headers.user-agent`） |
| `HONGGUO_DATA_DIR` | `server` | 视频解密缓存目录（缓存落在其下 `stream-cache/`；设备标识与链路密钥同存于 `server/config/apikeys.json`，不随本项变化） | `runtime.data_dir` |
| `HONGGUO_STREAM_CACHE` | `server/stream-cache` | 解密成品缓存 | 无，仅环境变量 |
| `HONGGUO_DOWNLOAD_DIR` | `download` | 剧集下载目录（相对项目根目录），每剧一个子文件夹 | `runtime.download.dir` |
| `HONGGUO_DOWNLOAD_CONCURRENCY` | `2` | 批量下载时的并发集数（1–8），调大可能拖慢播放 | `runtime.download.concurrency` |
| `HONGGUO_CACHE_MAX_FILES` | `30` | 缓存文件数上限，超出后按最后修改时间删除最旧的；设为 `0` 表示不限 | `runtime.cache.max_files` |
| `HONGGUO_SESSION_API_KEY` | 空 | 设置后进入「托管模式」，固定单设备、禁止刷新登录态 | 无，仅环境变量 |
| `HG_SIGN_LIST` | 见代码 | 免签接口列表（一般不需改） | 无，仅环境变量 |
| `HG_OPEN_BROWSER` | 空（跟随配置） | 设为 `0` 时服务就绪后不自动打开浏览器 | `launcher.open_browser` |
| `WEB_DIR` | `<项目根>/web` | 前端目录 | 无，仅环境变量 |

> 「配置文件」列给出该环境变量在 `server/config/config.json` 里对应的键名，
> 标「无，仅环境变量」的项没有配置文件入口。配置文件里还有一批表中未列出的
> 运行时调优键——缓存 `mem_max` / `mem_max_mb` / `img_max_mb` / `img_max_kb`、
> 限流桶 `rate_buckets_max` / `rate_bucket_idle_ms`、`sweep_interval_ms` 等，
> 每项都带 `_xxx提示` 注释说明用途；环境变量用于临时覆盖，优先级更高。

### 输出与日志

控制台即全部输出：服务地址、首次自动生成的管理口令、运行统计、告警等都直接
打印在终端（管理口令仅在 `apikeys.json` 里没有、系统自动生成时提示一次，重启
沿用不再重复显示）。启动脚本已瘦身为薄壳，不再写任何日志文件——早期版本
`server/data/log/start.log` 一套已随脚本瘦身移除。

若需要留档，自行重定向即可，例如：

```bash
# Linux / macOS
bash scripts/start.sh > run.log 2>&1
```

```bat
:: Windows
start.bat > run.log 2>&1
```

---

## 七、自检

```bash
node server/src/main.js --selftest
```

覆盖 21 组共 **173 项**断言：

| 组 | 内容 |
|---|---|
| 1 | spade 解包 5 组运行时真值、ver2 类型拒绝 |
| 2 | AES-128-CTR 计数器构造（高位保留、进位、`0xff+1`） |
| 3 | 逐样本 IV → CTR 计数器（8字节 IV 位于高 64 位、16 字节原样保留、回退 base_iv） |
| 4 | AVCC / NAL 自证（Annex-B、长度链、多 NAL、越界与 forbidden_zero_bit 拒绝） |
| 5 | AES-128-CTR 加解密往返一致性 |
| 6 | MP4 盒解析（构造最小合法 moov，含 ftyp/moov/tenc/senc） |
| 7 | 端到端解密：IV 自证、全部样本解密、AVCC 自洽、逐字节还原、错误 key 拒绝 |
| 8 | JSON 往返与数字语义（转义、精度、skipNulls、`1.0` 输出为 `1`） |
| 9 | 播放缓存路径（`.play.mp4` 变体命中判定） |
| 10 | 设备身份 device_id（格式、注入 base_query、落盘、`iid` 保持 0） |
| 11 | 本地纯代码签名：六个头齐全、时间戳一致、branchOf 取值与 branch==1 抖动规避、hashF13 三分支固定向量 |
| 12 | 剧集解析：title 清洗（上游 title 实为简介）；官网回落的简介/标签/连载状态透传与 `degraded` 标记 |
| 13 | 本地链路密钥管理；管理口令生成与 apikeys.json 持久化 |
| 14 | moov 定位：尾部 moov 也能找到（流式解密前置） |
| 15 | 流式解密与整文件解密结果一致 |
| 16 | 缓存上限与过期清扫 |
| 17 | stream-cache 数量上限（超出按修改时间淘汰最旧；上限取 `runtime.cache.max_files`，可被 `HONGGUO_CACHE_MAX_FILES` 覆盖） |
| 18 | 搜索分页切片（skip 生效且 has_more 判据正确） |
| 19 | App 取址链路：设备身份字段、python 风格 query 编码（`*!'()` 转 %XX）、媒体 URL 白名单 |
| 20 | CENC 信令纯 JS 减壳（sinf/senc 移除、stco 平移且指向新 mdat、条目类型按 frma/hvcC 改回 hvc1、mdat 逐字节一致、盒链完整、尾部 moov/垃圾输入拒绝、co64 与无 frma 变体） |

这些都是踩坑后固化的回归基线，用于判断算法实现是否被改坏。
预期结尾输出：

```
  结果：171/171 全部通过
```

> 早期文档曾写作 162 / 165 项，是断言项数随迭代增长后未同步更新所致；
> 以 `--selftest` 实际输出的「通过/总数」为准。

自检不访问网络、不依赖任何外部服务，可在离线环境运行。

---

## 八、目录结构

```
hongguo-web/
├── README.md                  ← 本文件：快速上手 + 完整说明
├── package.json               Node 项目描述（npm start / npm run selftest）
├── scripts/
│   ├── start.bat / start.sh   一键启动
│   ├── stop.bat / stop.sh     停止服务
│   └── pack.sh                打包 7 个平台发行版（内置 Node 运行时）
├── server/
│   ├── src/                   Node 后端源码（零第三方依赖）
│   │   ├── main.js            入口（--config / --stop / --selftest / --version）
│   │   ├── launcher.js        启动编排（API 服务 + 浏览器）
│   │   ├── server.js          HTTP 路由 + 鉴权 + 限流
│   │   ├── selftest.js        自检套件
│   │   ├── mp4-fixture.js     自检用最小加密 mp4 夹具
│   │   ├── core/
│   │   │   ├── pure-sign.js   本地纯代码签名（六个请求头）
│   │   │   ├── spade.js       spade -> content key
│   │   │   ├── mp4.js         BMFF 盒树 + CENC 解密 + 纯 JS 减壳（剥离信令）
│   │   │   ├── device.js      本机稳定 device_id
│   │   │   ├── keystore.js    密钥管理
│   │   │   └── safeguards.js  风控 + 缓存 + 节流
│   │   ├── service/
│   │   │   ├── web-source.js  官网数据源（搜索/分集列表）
│   │   │   ├── app-source.js  App 取址链路（注册身份 + 六头签名 + 备用域重试）
│   │   │   ├── playback-device.js 匿名播放设备注册（ttEncrypt）
│   │   │   ├── client.js      上游 API 客户端（签名 + 六请求头）
│   │   │   ├── download.js    剧集批量下载（任务管理 / 重试 / 落盘）
│   │   │   ├── stream.js      下载 + 解密 + remux
│   │   │   └── res.js         响应辅助（JSON/静态/Range）
│   │   └── util/
│   │       ├── config.js      配置加载（JSON + 环境变量覆盖）
│   │       ├── json.js        轻量 JSON
│   │       ├── crypto.js      MD5 / AES-128-CTR / hex
│   │       ├── http.js        HTTP 客户端封装（node:http/https）
│   │       └── log.js         日志与配置读取
│   ├── config/config.json     启动配置（端口、监听、调优参数、上游接口参数 upstream 段）
│   ├── config/apikeys.json    链路密钥、管理口令与 device_id（首次启动自动生成，不入库）
│   └── stream-cache/          解密成品缓存（运行时生成，不入库）
├── download/                  剧集下载目录（运行时生成，不入库）
├── node/                      Node 运行时（仅发行包内有；仓库不含）
└── web/                       前端静态资源（可直接浏览器打开）
    ├── index.html
    ├── styles.css
    └── app.js
```

---

## 九、常见问题

**Q：Linux 上解压后 `start.sh` 起不来，报 `GLIBC_2.28 not found` 或 `cannot execute binary file`？**

A：你下的是默认包，它内置的是最新 LTS（Node 26.x）。Node 26 官方的
Linux 二进制要求较新的系统库，CentOS 7、Debian 9/10、Ubuntu 18.04
这类老发行版会直接无法执行。

改下带 `-node24` 后缀的包：

| 你的架构 | 换成 |
|---|---|
| x86-64 | `hongguo-web-<版本>-Linux-x64-node24.zip` |
| ARM64 | `hongguo-web-<版本>-Linux-arm-node24.zip` |

它内置 Node 24.x，对老系统兼容性更好，**功能与默认包完全一致**。

自查命令：

```bash
./node/bin/node -v    # 看当前包内置的版本（v26.x / v24.x）
ldd ./node/bin/node   # 老系统上会列出 not found 的库
```

另一种办法：如果本机已经装了 Node 18+，删掉包里的 `node/` 目录，
启动脚本会自动回落到系统 Node。

**Q：`/search` 返回 `code:100103 PARAM_INVALID`？**

A：按顺序排查：

1. 确认 `server/config/apikeys.json` 存在且内容合法（`device_id` 与密钥同存此文件）：

   ```json
   { "device_id": "7091873872252626" }
   ```

   缺失则删除该文件重启，服务会自动生成一个新的。
2. 若配置里显式写了 `device_id`，值必须是 10~20 位纯数字。非法值会被忽略并重新生成。
3. 确认没有把 `HONGGUO_DEVICE_ID` 设成非法值。
4. 多实例同时运行时，用 `HONGGUO_DEVICE_ID` 给每个实例指定不同且稳定的值。

若上游明确返回 `device_id` 无效、受限或被拒绝，程序会为本地生成/存储的身份
生成新值、写回 `apikeys.json` 并重试一次。通过环境变量或配置文件显式指定的身份
不会自动覆盖；普通限流、验证码等风控响应也不会触发换号。

> **为什么 `device_id` 是必需的**：搜索接口会比其它接口多校验一项设备标识。
> 实测同一套请求参数，缺 `device_id` 时上游返回 53 字节的
> `PARAM_INVALID`，补上后即 `code=0` + 完整结果（几十~上百 KB）。
>
> **不要手动加 `iid`**：实测 `device_id` 搭配一个随机 `iid` 会被风控拦截，
> 返回 HTTP 200 但 body 为空。修复方案因此只生成 `device_id`。

`device_id` 相当于本机的设备指纹，**请勿随意删除或改动** `apikeys.json` 里的
`device_id`：短时间内身份跳变会被上游判定为异常流量。自动轮换仅在上游明确拒绝
当前身份时发生。

**Q：首播为什么慢？第二集为什么还要等一会儿？**

A：首播需要「下载密文 + 离线解密」，单集约 3–14MB，通常十几秒；
完成后写入 `HONGGUO_STREAM_CACHE`，同集再次播放为秒开
（可用 `quality=360p` 降低首播耗时）。预热能让切集秒开，但只在
**上一集正在播**时触发；若你直接跳到最后一集，前面没有可预热的窗口，
就会正常等待。已预热过的集，日志里能看到 `[prewarm] ...`
且 `/prewarm` 返回 `state=cached`（机制见「前端使用 → 自动连播与预热」）。

**Q：画面全黑，但进度条和时间轴在正常走？**

A：源流是 **HEVC(H.265)**，服务端直出不转码。你的浏览器或系统若缺
HEVC 解码支持，就会这样——`readyState` 正常到 4、`videoWidth` 却是 0。
页面会检测这种情况（进度条在走、`videoWidth` 一直为 0），直接在播放器上盖一层
「当前剧集不支持浏览器播放」，并提供「下载本集」按钮。它和下一节的 BVC2 用的是
**同一套提示**：结论一致、都不弹 toast、都不给「重试」（编码不支持不会自愈），
只有「原因」那句话不同；下载完成任务后覆盖层不再堆路径与播放器建议
（落盘目录看顶栏「⤓」的进度卡片，播放器怎么选看下面两节）。
「下载本集」提交的是一个**单集下载任务**（等价于把「下载」按钮的范围设成 `start = end`），
不发同步请求、不阻塞页面，进度和成品都在顶栏「⤓」里看。

问题在播放端，服务端没有可开的开关，按下面任选其一：

1. 换用最新版 Chrome / Edge：桌面版走硬件解码解 HEVC，需要显卡驱动与
   系统解码组件在位；
2. 补上系统的 HEVC 解码支持：Windows 装「HEVC 视频扩展」，
   macOS / iOS 的 Safari 原生支持；
3. Firefox 目前不支持 HEVC，遇到这类片源请换浏览器。

> **为什么不内置转码**：本项目只做「解密 + 信令剥离」，源流 H.264 / HEVC
> 原样交给浏览器。服务端转码要绑定几十 MB 的 ffmpeg 二进制、每集多花十几秒
> 并损失画质，而主流浏览器早已能解 HEVC，代价远大于收益。
> 实测 1080×1920 整集剥离信令约 1 秒（纯 JS 减壳）。

**Q：提示「当前剧集不支持浏览器播放」，有的集干脆播不了？**

A：这一集上游**只提供 ByteVC2 片源**，浏览器没有对应解码器，不是程序坏了。

上游对新上线的分集换用了 **ByteVC2（字节自研的 BVC2，基于 H.266/VVC）** 编码，
接口返回的 5 档清晰度**全部**是 `bytevc2`，没有 H.264 / HEVC 版本可选。
本项目只放行 H.264 / HEVC（`bytevc1` 也在内），所以会明确拦下并提示，而不是
让播放器黑屏。实测某集（`vid=7701981094404426776`）的返回：

| 档位标签 | 实际分辨率 | 码率 |
|---|---|---|
| 360p | 642×360 | 157 kbps |
| 480p | 854×480 | 203 kbps |
| 540p | 1026×576 | 212 kbps |
| 720p | 1282×720 | 270 kbps |
| 1080p | 1282×720 | 290 kbps |

（`1080p` 只是上游的标签，实际仍是 720p 级别。同期较早的分集还是 `bytevc1`，
所以表现是「越新的集越容易遇到」。）

**怎么办：** 与 HEVC 解码失败共用同一块提示层（标题就是「当前剧集不支持浏览器播放」），
里面有「**下载本集**」按钮。下载走的是与在线播放相同的流水线
（取直链 → 下载 → spade 解密 → 剥除 CENC 信令），
成品落在下载目录（`download/<剧名>/第N集.mp4`，与「下载」按钮同一套任务体系），
是**不带 DRM 的普通 mp4**，容器标签也已改写为标准 VVC，可以拿到任意设备上播放。
批量下载（「下载」按钮）同样支持这类分集，不会再因编码不兼容整批失败。

**播放器怎么选（重要）：** ByteVC2 是字节的私有**封装**，但**码流本身是标准
H.266/VVC**。实测这一集（1080p / 30fps / 4223 帧）：把 mp4 里的视频样本抽出来
转成 Annex B 后，ffmpeg 的 `vvc` 解码器 **4223 帧全解、0 错误**；再把私有的解码
配置盒换成标准 `vvcC`，同一份 mp4 也能整片解开。上游只是把样本条目写成私有的
`bvc2`（标准是 `vvc1`）、配置盒写成私有的 `bv2C`，标准解析器按标签找解码器，
认不出就直接拒播。

所以本项目在减壳完成后会**顺手把容器标签改写为标准 VVC**：条目 `bvc2`→`vvc1`、
配置盒 `bv2C`→`vvcC`，参数集（VPS/SPS/PPS）直接从第一个关键帧里取。码流一个
字节没动，文件长度不变，所以 chunk 偏移也不用平移。改写是幂等的，早期下载的
缓存文件在下次命中也自动升级。

| 播放器 | 能否播放本项目的 BVC2 文件 |
|---|---|
| VLC 4.0 nightly | **可以**：改写后是标准 VVC 容器 |
| mpv（ffmpeg ≥ 7.1） | **可以**，同上 |
| ffmpeg / ffprobe | **可以**：整片解码 0 错误，`-c copy` 重封装或转 H.264 都行 |
| 浏览器（Chrome / Edge / Firefox / Safari） | **不行**：都不支持 H.266 解码 |

浏览器这条路仍然走不通：VVC 在浏览器里没有解码器，要让它直接播只能转成 H.264；
转码需要绑定 ffmpeg、每集多花约半分钟（实测 1080p 整集 29 秒）、体积涨到 5 倍
（6.8 MB → 33 MB），本项目不做这件事。遇到这种集，只能下载到本地用上面这些
播放器打开。

> 顺带一提：这类分集在「自动预热」时只打一条 info 日志（
> `跳过预热 xxx：本集仅 BVC2 片源`），不会像以前那样刷 3 条「预热失败」WARN。

**Q：需要装 ffmpeg 吗？**

A：不需要，也从不需要。解密用 Node 内置 `crypto`，剥离 CENC 信令走**纯 JS
减壳**（删信令盒、修补盒尺寸、平移 chunk 偏移、原样流拷 mdat），全程不调用
任何外部进程，产物即 `.play.mp4`。

只有文件布局超出减壳支持范围时（如 moov 在文件尾部）才生成不了成品：
此时保留 `.raw.mp4`（内容已解密，仍带 CENC 信令，部分播放器会拒播），
并在日志里打一条 `减壳不适用` 的 WARN。缓存命中判定同时覆盖
`.play.mp4` / `.mp4` / `.raw.mp4` 三个变体。

**Q：列表接口返回空 body？**

A：这是上游的风控行为，与本地无关：`search` / `multi_video_detail`
两个接口上游要求带签名，若请求未带或签名不被接受，上游返回 HTTP 200 + 空 body。
本项目对这两个接口固定走本地签名，正常不会触发；若偶发出现，稍后重试即可。

播放取址（b 域名 `multi_video_model/v1`）自 2026-11-02 起恢复**签名请求**：
先由 `playback-device.js` 注册匿名设备，再用 device_id / iid 组装 query，
末尾追加 `ts`（秒）与 `_rticket`（毫秒，递增到 `branchOf === 0` 为止），
并带上六个签名头（x-gorgon / x-khronos / x-ladon / x-argus / x-helios / x-medusa）。
签名全部在本进程内算，没有外部依赖。

该接口返回空 body 时，基本是「同一设备身份短时间内重复取流」被判重
（同一集隔几秒单发就能过，本机实测与签名、出口 IP 都无关）。此时会丢掉
这一次的注册结果、重新注册，换新身份再打备用域 `api5-normal-hl.fqnovel.com`；
两次都空才计入熔断。调试可开 `HG_APPSOURCE_DEBUG=1` 看原始响应。
若注册本身失败，多半是本机到 `log5-applog-lf.fqnovel.com` 的网络问题
（DNS 解析、代理分流、防火墙），可用
`curl -m 10 -X POST 'https://log5-applog-lf.fqnovel.com/service/2/device_register/?tt_data=a'`
看是否能通；注册失败时预热重试会自动重发注册，仍失败则检查网络环境。
排查时先核对上游端点路径（取直链为 b 域名 `multi_video_model/v1`，
其余为 `preload/v1`）。

**Q：播放失败，日志提示「无直链 / video_model」？**

A：个别分集（后集高发）上游已不再从 a 域名 `preload/v1` 返回 video_model，
取直链已统一改走 App 取址链路（`AppSource`：b 域名 `multi_video_model/v1`；
片源内联在 `video_model.video_list` 时直接使用，否则跟随 `fallback_api`
二次请求；媒体 URL 带 `key_seed` 时自动解密）。
若仍失败，将该分集编号与日志反馈给维护者；
临时规避可换其他清晰度或稍后重试。

**Q：启动时报端口被占用（`EADDRINUSE`）？**

A：API 服务端口被占用。改端口重试：

```bat
set PORT=8001 && scripts\start.bat
```

或先运行 `scripts\stop.bat` 清理残留进程。

**Q：Windows 双击 `start.bat` 后服务起不来？**

A：先看窗口里的首行错误。常见两种：
- 端口被占用 → 见上一条 `EADDRINUSE` 的处理
- 「No Node runtime found」→ 本机没装 Node，且不在发行包里运行：
  安装 Node 18+（<https://nodejs.org/>），或把 Node 解压到项目 `node\`（需含 `node.exe`）

**Q：控制台中文显示成乱码？**

A：Node 始终以 UTF-8 输出，现代终端（Windows Terminal、PowerShell、
Linux/macOS 终端）默认按 UTF-8 解码，正常情况下不该出现。若旧版
`cmd.exe` 仍按 GBK(936) 解码，换个终端或执行 `chcp 65001` 即可；
启动脚本本身不含任何 `chcp`，也不给 Node 传任何编码参数。

**Q：启动后浏览器没有自动打开？**

A：日志里会明确写出结果，两种情况：

| 日志 | 含义 |
|---|---|
| `已打开浏览器` | 正常，通过系统桌面 API 打开成功 |
| `自动打开失败，请手动打开网页：…` | 无图形会话（无头服务器/WSL/SSH），手动复制地址即可 |

服务本身不受影响。想关闭自动打开，见「六、配置项」的 `HG_OPEN_BROWSER`。

**Q：包太大？**

A：完整包大部分体积是内置的 Node.js LTS 运行时——
换来的是目标机无需预装 Node。
若目标机已有 Node 18+，删掉包内 `node/` 目录即可正常启动，
启动脚本会自动回落到系统 Node（查找顺序见「三、环境要求」）。

**Q：打包要联网吗？**

A：要。`pack.sh` 从 nodejs.org 按平台下载对应 Node 运行时，首次约 370MB
（5 个常规包约 250MB，两个 Linux `-node24` 包再各约 60MB）。
下载的运行时会用官方的 `SHASUMS256.txt` 做 SHA-256 校验，缓存在 `.pack-cache/`，
同一平台重复打包不再联网。可用 `HG_NODE_VERSION` 固定版本号（缺省取最新 LTS）。

`-node24` 变体的版本号**不受** `HG_NODE_VERSION` 影响，始终取 24.x 的最新 LTS；
除非你把 `HG_NODE_VERSION` 显式设成 24.x（此时两者一致，等于全部固定到 24 线）。

只打常规 Linux 包：`bash scripts/pack.sh Linux-x64 Linux-arm`；
只打 Node 24 兼容包：`bash scripts/pack.sh Linux-x64-node24 Linux-arm-node24`。
只想打一个平台时用 `bash scripts/pack.sh Linux-arm`，
`bash scripts/pack.sh --list` 可列出全部平台名。

**Q：发行包和源码树有什么区别？为什么发行包里没有 pack.sh？**

A：发行包内置 Node 运行时与完整源码，解压即用；`pack.sh` 只在**源码树**里，
是打包工具本身，使用者不需要。改了源码不需要任何构建，重跑
`node server/src/main.js` 即生效；要出新版本包时，在源码树执行
`bash scripts/pack.sh` 重新打包即可。

**Q：停止后端口还被占用？**

A：`stop` 脚本按「进程类型 + 入口脚本路径」双重匹配，不会误杀其他 Node 进程。
若仍占用，先用**管理员身份**重跑该脚本；若提示「端口仍在监听，但未能定位到
进程」，说明服务是以更高权限或从项目另一份拷贝启动的，当前权限读不到它的
命令行 —— 用 `netstat -ano | findstr <端口>` 查到 PID 后 `taskkill /PID <pid> /F`
手动结束，或在任务管理器结束对应的 `node.exe`。

**Q：解密报「content key 与密文不匹配」？**

A：多为 `spade` 与密文不配套（重新请求轨道信息会刷新 `spade_a`），
或该内容为 ver2（AES-GCM）路径 —— 当前实现只支持 ver1。

**Q：缓存目录越来越大？**

A：已自动限量。每次解密落盘后会清理 `stream-cache`，按**最后修改时间**保留最新
30 个成品、最旧的自动删除（`.part` / `.enc` 临时文件不计入也不删）。
上限可在「六、配置项」调整。

**Q：想换成本地 key？**

A：`GET /api-key` 会自动签发；也可用 `ADMIN_TOKEN` 调 `/admin/keys` 管理。

**Q：怎么切换集数？**

A：视频下方左侧有个「第 xx 集」按钮，点击后从按钮**上方**展开选集卡片，
里面按**一行五个**排列全部集数，当前集红色高亮，点任意一个即切换，卡片自动收起。
卡片内可滚动（集数多时），点卡片右上角 ✕、按 `Esc` 或点击卡片外部都可关闭。
单集播放（无剧集列表）时该按钮自动隐藏。想从第 1 集重看，在这里选第 1 集即可。

> 集数**只在左侧按钮上出现**。播放器下方正中的状态区只放播放状态，
> 播放成功后为空；集数信息不再重复出现在状态位。

**Q：剧集简介默认能看到吗？**

A：默认**隐藏**。剧集名右侧有个「简介」小按钮，鼠标移上去就在下方浮出简介段落；
鼠标移开、按 `Esc` 或点别处即收起。点击按钮也能切换显示/隐藏，方便触屏或键盘操作。
简介为空时按钮自动隐藏，不占位。

> 数据来源：简介取自 App 详情接口（`multi_video_detail/preload/v1`）。
> 该接口偶发返回 HTTP 200 + 空 `data`（风控软拦截）。此前实测约 1/3 的请求为空，
> 根因是 `hashF13` 的 branch 0 展开循环里少推进了一次状态（`di0` 未前进），
> 导致 `queryBodyTs` 与 `check` 算错、签名被上游判为无效；2026-11-02 已修复，
> 日志里不应再出现固定比例的空响应。重试仍保留 2 次（间隔 400ms）作为兜底；
> 仍为空则回落官网分集页，
> 官网数据里的简介、标签、连载状态同样会透传（`meta.degraded = true`，
> 缓存 10 分钟而不是 6 小时，便于尽快重试 App 链路）。
> 因此简介一般不会整段消失；若某部剧确实没有简介（新剧未填），按钮会隐藏。

**Q：为什么状态栏文案不会把弹层顶高？**

A：状态栏固定占两行高度（`min-height: 3em` + `line-height: 1.5`），
「解密并缓冲中」这类短提示与 HEVC 兜底长提示占位完全一致，切换时不产生位移。

**Q：手机上顶栏挤得下吗？**

A：320px 起可用。极窄屏（≤430px）下搜索按钮只保留 🔍 图标、图标按钮缩到 30px，
分类标签自己横向滚动。实测 320 / 360 / 390 / 430 / 560 / 768px 六档
`document.scrollWidth` 均等于视口宽度，无横向滚动。

**Q：首次启动一直显示「获取中」，是不是坏了？**

A：不是。后端冷启动约 1~2 秒（签名在本进程内计算，没有外部服务要等），
这期间 `/api-key` 拿不到是正常的。页面会按退避节奏自动重试，后端一就绪就
自动拿到密钥、**卡片自动关闭**、首页自动加载出来，全程不用管
（各状态与重试机制见「前端使用 → 首次使用会自动拿密钥」）。

如果一直失败，按卡片里的橙色/红色状态行看原因：
- 「HTTP 503 / 无法连接」→ 后端没起来，去项目目录跑 `scripts\start.bat`（或 `bash scripts/start.sh`）
- 「已停止自动重试」（红色）→ 多半是反向代理剥掉了 `api_key` 参数，
  或浏览器访问的地址和实际跑后端的实例不是同一个；确认后点「⚿ 重新获取」

**Q：服务重启后提示要重新填密钥？**

A：不用填。收到 401 时前端会自动换新密钥并重新加载，卡片会自己关掉。
这期间最多自动尝试 5 次、每次至少间隔 2 秒；
真的连续失败才会停下来提示，避免无限重试把接口打爆。

---

## 致谢

本项目的逆向分析思路与部分实现，参考自以下开源项目：

- **[hongguo-desktop-releases](https://github.com/waligoraamodio288-rgb/hongguo-desktop-releases)** —— 桌面端版本，提供了本项目最初的分析起点与对照实现，感谢原作者的分享。
- **[jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama)** —— 纯代码签名（x-gorgon / x-khronos / x-ladon / x-argus / x-helios / x-medusa）与官网网页数据源的参考实现，本项目 `core/pure-sign.js` 与 `service/web-source.js` 移植自此。

---

## 注意事项

- 签名与解密全部在服务进程内完成，不监听任何额外端口；
  默认只监听 `127.0.0.1`，若改为 `0.0.0.0` 对外暴露，**必须**设置 `ADMIN_TOKEN`
  （环境变量，或写进 `server/config/apikeys.json` 的 `admin_token`）。
- 目录穿越防护已启用（`path.resolve` + 前缀校验），静态资源优先于鉴权路由。
- 本项目仅供技术研究与学习，请勿用于批量抓取或传播受版权保护的内容。
