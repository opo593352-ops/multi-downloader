# 抖音视频 + 音乐下载器

零依赖 Node.js 引擎 + WinForms 原生界面，两个标签页：**抖音视频** 与 **音乐搜索·货比三家**。

核心能力：

- 抖音：无水印原画下载，支持图文作品、4K 档位
- 音乐：同时搜索 **酷我 / QQ音乐 / 网易云**，横评音质体积后择优下载

## 目录

- [图形界面](#图形界面推荐双击即用)
- [音乐搜索 · 货比三家](#音乐搜索--货比三家)
- [命令行用法](#命令行用法)
- [打包成 EXE](#打包成-exe)
- [关键坑](#关键坑改代码前必读)

## 图形界面（推荐，双击即用）

双击 **`抖音下载器UI.exe`**，两个标签页随你切：

### 标签页 ①：抖音视频

```
┌─────────────────────────────────────────────────────────┐
│ 链接（可粘贴多条，或直接粘贴抖音分享文案）              │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ https://v.douyin.com/xxxxx/                         │ │
│ └─────────────────────────────────────────────────────┘ │
│ 画质 [最高画质▾]  保存到 [C:\Users\...\Downloads] [浏览]│
│ ☑图文作品下载原声 ☐显示浏览器  [清空][打开目录][开始下载][停止]│
├─────────────────────────────────────────────────────────┤
│ 状态    │ 标题       │ 类型        │ 画质    │ 文件│ 大小│
│ 完成    │ #精卫填海  │ 视频 720x…  │ 1280p   │ 1个 │3.49MB│
├─────────────────────────────────────────────────────────┤
│ ████████████████████████████████████████ 100%           │
│ 运行日志                                                 │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 选定: 1280p / 334kbps / mp4                          │ │
│ │ ✓ 视频: #精卫填海_1280p.mp4 (3.49 MB)                │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

功能点：

- **多链接批量**：一次粘多条，或直接粘整段分享文案
- **实时进度**：进度条 + 任务列表逐条显示状态/标题/类型/画质/文件数/大小
- **实时日志**：引擎输出原样滚动显示，出错能看到具体原因
- **可停止**：停止按钮会连 Chrome 子进程一起杀掉
- **双击列表行**打开保存目录

> ⚠ **UI 和引擎必须放同一个文件夹**，UI 会自动找同目录的 `抖音下载器.exe` 作为引擎。

### 标签页 ②：音乐搜索 · 货比三家

```
┌──────────────────────────────────────────────────────────┐
│ 搜索歌曲 [雨爱________________________] [搜索对比]        │
│ [下载最优★][下载选中] 每平台[5] 保存到[..\Music] […] [打开]│
├──────────────────────────────────────────────────────────┤
│ 平台   │ 歌名              │ 歌手          │状态│大小  │推荐│
│ 酷我   │ 雨爱              │ 蜡笔小新      │可用│3.66MB│★  │
│ 酷我   │ 雨爱（堵桥版）    │ 沐云轩        │可用│1.38MB│★  │
│ QQ音乐 │ 雨爱              │ 杨丞琳        │受限│  -   │    │
│ QQ音乐 │ 雨爱(IDJ版)       │ YG名刀/…      │可用│1.29MB│★  │
│ 网易云 │ 雨爱              │ 杨丞琳        │可用│3.98MB│★  │
├──────────────────────────────────────────────────────────┤
│ ████████████████████████████████████████████ 100%        │
│ ━━━ 下载: 雨爱 - 杨丞琳  [网易云 3.98 MB] ━━━            │
│   ✓ 雨爱 - 杨丞琳.mp3 (3.98 MB)                          │
└──────────────────────────────────────────────────────────┘
```

**工作方式**：

1. 输入歌名 → 三个平台**并行搜索**（各取 N 条）
2. 每条结果**实时解析直链 + 探测文件大小**（HEAD/Range 请求）
3. 列表里标注「可用 / 受限」，★ 表示该曲的最高音质源
4. 「下载最优」自动选**全局体积最大**的那条（体积≈码率≈音质）
5. 「下载选中」下你点中的那条（比如你就要某个翻唱版）

**实测对比样例（搜索「雨爱」）**：

| 平台 | 歌名 | 歌手 | 大小 | 结果 |
|---|---|---|---|---|
| 网易云 | 雨爱 | 杨丞琳 | **3.98 MB** | ✅ 最优，自动选中 |
| 酷我 | 雨爱 | 蜡笔小新 | 3.66 MB | ✅ 可用 |
| QQ音乐 | 雨爱 | 杨丞琳 | - | ❌ 受限（版权） |
| 酷我 | 雨爱（堵桥版） | 沐云轩 | 1.38 MB | ✅ 可用 |
| QQ音乐 | 雨爱（超燃DJ版） | YG名刀/… | 1.29 MB | ✅ 可用（M4A） |

同一首歌，三个平台音质差 3 倍——这就是为什么要货比三家。

### ③ 双击命令行 EXE（不需要装 Node）

拿到 `抖音下载器.exe` 后双击，进入交互模式：

```
粘贴抖音链接或分享文本（直接回车退出）:
> https://v.douyin.com/xxxxx/

画质:  [1] 最高(默认)  [2] 4K  [3] 1440p  [4] 1080p  [5] 720p  [6] 540p
选择 (回车=最高): 2
```

粘链接 → 选画质 → 等下载完成，可以连续粘多个链接。

> ⚠ **EXE 必须放在普通目录运行**（如 `Downloads`、桌面）。
> 放在 DSH 的 `.dsh` 沙箱工作区里运行，子进程和写盘会被系统限制，
> 表现为 `EPERM mkdir` 和 Chrome 启动失败。

## 命令行用法

### 抖音

```bash
# 源码运行
node douyin-dl.mjs "https://v.douyin.com/xxxxx/"
node douyin-dl.mjs "3.87 :1pm Kws:/ 06/20 某视频 https://v.douyin.com/xxxxx/ 复制此链接"

# EXE
抖音下载器.exe "https://v.douyin.com/xxxxx/" -q 4k
抖音下载器.exe "<url1>" "<url2>" -o D:\videos --audio
抖音下载器.exe --selftest
```

### 音乐

```bash
# 三平台对比搜索（打印对比表）
node music-dl.mjs search "雨爱"
node music-dl.mjs search "雨爱" --limit 5

# 下载最优（自动选体积最大的源）
node music-dl.mjs get "雨爱"

# 指定平台 / 指定第几首
node music-dl.mjs get "雨爱" --platform kuwo
node music-dl.mjs get "雨爱" --platform netease --pick 2

# 纯 JSON 输出（给程序读）
node music-dl.mjs search "雨爱" --jsononly

# EXE 用法完全相同
音乐下载器.exe search "雨爱"
音乐下载器.exe get "雨爱" --platform qq
```

## 命令行选项

### 抖音引擎

| 选项 | 说明 |
|---|---|
| `-o, --out <dir>` | 输出目录，默认 `~/Downloads` |
| `-q, --quality <q>` | 画质：`best`(默认) / `4k` / `2160` / `1440` / `1080` / `720` / `540` |
| `--audio` | 图文作品顺带下载原声 mp3 |
| `--json` | 只打印元数据，不下载（调试用） |
| `--headful` | 显示浏览器窗口，遇验证码时用 |
| `--wait <ms>` | 页面加载后等待时长，默认 6000 |
| `--chrome <path>` | 指定 Chrome/Edge 可执行文件 |
| `--port <n>` | CDP 调试端口，默认 9333 |
| `--profile <dir>` | 浏览器 profile 目录，默认 `~/.douyin-dl-profile` |
| `--fresh` | 不持久化 profile，每次全新会话（风控严时更易 403） |
| `-h, --help` | 显示帮助 |

### 音乐引擎

| 选项 | 说明 |
|---|---|
| `-n, --limit <n>` | 每平台取几条，默认 5 |
| `-o, --out <dir>` | 保存目录，默认 `~/Downloads/Music` |
| `-p, --platform <k>` | 指定平台：`kuwo` / `qq` / `netease` |
| `--pick <n>` | 选第 n 首（按组排序） |
| `--best` | 自动选最优（默认行为） |
| `--json` | 表格 + JSON |
| `--jsononly` | 只输出 JSON（UI 用这个） |
| `-h, --help` | 显示帮助 |

支持一次传多个链接，会依次处理。

## 示例

```bash
# 要 4K
node douyin-dl.mjs "https://v.douyin.com/xxxxx/" -q 4k

# 批量下到指定目录
node douyin-dl.mjs "https://v.douyin.com/aaa/" "https://v.douyin.com/bbb/" -o D:\videos

# 图文作品连原声一起下
node douyin-dl.mjs "https://v.douyin.com/xxxxx/" --audio

# 只看有什么画质，不下文件
node douyin-dl.mjs "https://v.douyin.com/xxxxx/" --json
```

## 工作原理

抖音的 `aweme/detail` 接口需要 `a_bogus` 动态签名，纯 HTTP 请求拿不到（这也是 `yt-dlp` 报 403 的原因）。本脚本的做法：

1. **短链展开** — 跟 302 拿到真实作品页，正则抠出 `aweme_id`
2. **启动 Chrome** — headless 模式，走 CDP 协议，profile 持久化
3. **反检测注入** — 抹掉 `navigator.webdriver` 等无头特征，改真实 UA
4. **暖场养 cookie** — 回首页让 JS 把 `ttwid` / `__ac_signature` / `odin_tt` / `s_v_web_id` / `UIFID` 种齐
5. **页面内取数** — 在**页面上下文里 `fetch`** detail 接口。签名由页面自己算，`credentials: 'include'` 带完整会话 cookie
6. **解析档位** — 从 `bit_rate[]` 里挑。优先选 `format: "mp4"`（音视频已封装），`dash` 是纯视频流没有音轨
7. **下载** — Node 侧带 `Referer: douyin.com` 和桌面 UA 拉流，边下边显示进度，断流自动重试 3 次

图文作品（`/note/`）没有视频轨道，会下载全部图片；加 `--audio` 顺带抓原声。原声地址有时在 `music.play_url`，有时塞在 `video.play_addr` 里，脚本两处都查。

## 音乐引擎工作原理

三个平台的可用性差异很大，逐家说明：

### 酷我（最省事）

| 步骤 | 接口 | 要点 |
|---|---|---|
| 搜索 | `search.kuwo.cn/r.s?all=关键词&ft=music&rformat=json` | 返回**单引号 JSON**，要 `.replace(/'/g,'"')` 才能 parse |
| 取直链 | `antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_xxx` | **直接返回 mp3 URL 文本**，无需登录、无需签名 |

酷我是三个平台里唯一**纯 HTTP 零门槛**的，所以最稳。

### QQ 音乐（要一枚 cookie）

| 步骤 | 接口 | 要点 |
|---|---|---|
| 搜索 | `c.y.qq.com/soso/fcgi-bin/client_search_cp?w=关键词&format=json` | 拿到 `songmid` |
| 取直链 | `u.y.qq.com/cgi-bin/musicu.fcg` + `vkey.GetVkeyServer` | **必须先访问 `y.qq.com` 拿 cookie**，否则 `result=104003` 无权限 |

拿到 `purl` 后与 `sip` 拼接。`purl` 是相对路径，`sip` 是 CDN 域名（注意 `http:` 要换成 `https:`）。

### 网易云（部分受限）

| 步骤 | 接口 | 要点 |
|---|---|---|
| 搜索 | `music.163.com/api/search/get/web?s=关键词&type=1` | 返回 `result.songs[].id` |
| 取直链 | `music.163.com/song/media/outer/url?id=xxx.mp3` | 会 302；若跳到 `/404` 说明该曲需登录或已下架 |

网易云可用的曲目音质往往最高（实测 3.98 MB vs QQ 1.29 MB），但**受限比例也最高**——列表里那些灰色的「受限」大多是它。

### 文件大小怎么比出来的

拿到直链后先 `HEAD` 请求取 `Content-Length`；服务器不支持 HEAD 时退回 `GET` + `Range: bytes=0-0`，从 `Content-Range` 里读总长度。体积≈码率≈音质，所以「最大 = 最优」是合理近似。

## 关键坑（改代码前必读）

### 1. `Network.getAllCookies` 必须带 sessionId

```js
// ✗ 错：Chrome 报 "'Network.getAllCookies' wasn't found"，返回空
cdp.send('Network.getAllCookies', {})

// ✓ 对：带上 page 的 sessionId
cdp.send('Network.getAllCookies', {}, sessionId)
```

这个坑会让 cookie 探测永远返回 0，误判成"环境没养好"，白等好几轮。

### 2. 无头特征会导致 `Uifid Not Found`

抖音的 Argus 风控会检测无头环境，检测到就直接：

```
Blocked by ArgusSecurityPlugin Uifid Not Found
```

必须同时做三件事：
- 启动参数加 `--disable-blink-features=AutomationControlled`
- 用 `--user-agent=` 覆盖 UA（否则 UA 里带 `HeadlessChrome`）
- `Page.addScriptToEvaluateOnNewDocument` 注入脚本抹掉 `navigator.webdriver`

### 3. `msToken` 不是 cookie

它是页面动态生成的 query 参数，`Network.getAllCookies` 里查不到。所以暖场门槛只看 5 个持久 cookie，别把 `msToken` 算进去。

### 4. profile 必须持久化

全新临时 profile 每次都要从零被风控拦一遍，几乎必然 403。默认存在 `~/.douyin-dl-profile`，第二次运行秒过。

## 关于画质

档位是发布者上传时决定的，`bit_rate[]` 里有几档就是几档，不存在的东西变不出来。

- 想确认某条最高多少，先跑 `--json` 看 `rates` 字段
- 竖屏作品的高度才是真实分辨率（如 `1024p` 实际是 576×1024）
- 同一作品不同请求环境返回的档位可能不同，profile 养熟后通常能拿到更高档

实测案例：

| 作品 | 最高档 | 文件大小 |
|---|---|---|
| 民国纪录片·汪精卫原声演讲 | 2160p (2880×2160) | 29.5 MB |
| #精卫填海 | 1280p (576×1024) | 3.49 MB |
| 猎奇#猎奇（图文 2 张） | 图片原图 | 215 KB + 原声 135 KB |

## 打包成 EXE

双击 `build.cmd` 一键构建，或手动执行：

```bash
# 1. 打包成单文件 CJS
npx esbuild douyin-dl.mjs --bundle --platform=node --format=cjs --target=node24 --outfile=build/bundle.cjs

# 2. 生成 SEA blob
node --experimental-sea-config sea-config.json

# 3. 复制 node.exe
copy "C:\Program Files\nodejs\node.exe" 抖音下载器.exe

# 4. 移除原始签名（关键！见下）
signtool remove /s 抖音下载器.exe

# 5. 注入 blob
npx postject 抖音下载器.exe NODE_SEA_BLOB build\sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

### 为什么第 4 步不能省

node.exe 带 Authenticode 签名，postject 注入会破坏它。**签名损坏比完全无签名更糟**：Windows 会把进程当作不可信，表现为

- 写盘 `EPERM: operation not permitted`
- 启动子进程直接 `exit=2147483648`（`0x80000003 STATUS_BREAKPOINT`）

先 `signtool remove /s` 清掉签名，注入后进程就是正常的未签名程序，一切照常。

signtool 一般在这里：
`C:\Program Files (x86)\Windows Kits\10\bin\<版本>\x64\signtool.exe`

### EXE 体积

约 **89 MB**（内嵌整个 Node 运行时）。SEA 没有官方瘦身手段，这个大小是正常的。
如果嫌大，用源码 + `下载.cmd` 的方式，只需要装个 Node。

## 打包图形界面

UI 是纯 WinForms + 系统自带 C# 编译器，**不依赖任何第三方库**：

```bash
cd gui
build-gui.cmd
```

或者手动：

```bash
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe ^
  /target:winexe /out:DouyinUI.exe ^
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll ^
  /optimize+ Program.cs
```

产物只有 **21 KB**（对比引擎 89 MB，因为 UI 只是外壳，逻辑都在引擎里）。

### UI 的两个坑

**① Anchor=Right 会让控件飞出可视区**

在控件加入容器**之前**设置 `Anchor = Top | Right`，父容器初始尺寸较小时，控件会被推到很远。

```csharp
// ✗ 错：btnStart.Anchor = AnchorStyles.Top | AnchorStyles.Right;
// ✓ 对：手动算位置，挂 Resize 事件
void LayoutTop(Panel top) {
    int w = top.ClientSize.Width;
    int x = w - pad;
    x -= stopW;   btnStop.Left = x;
    x -= gap + startW; btnStart.Left = x;
}
```

**② 列表列宽要延后一拍再算**

`Resize` 触发时子控件还没完成布局，`listTasks.ClientSize.Width` 是旧值，
列宽会算错导致最后一列被挤出窗口。用 `BeginInvoke` 推到下一轮消息循环：

```csharp
Resize += delegate {
    LayoutTop(top);
    BeginInvoke((MethodInvoker)delegate { LayoutList(); });
};
```

**③ DPI 缩放会让手动布局全错位**

150% DPI 下 WinForms 自动把控件放大 1.5 倍（110px 的按钮实际 165px），
但你在代码里写的 `Left = w - 14 - 110` 是**物理像素**，两边单位不一致，
按钮就会互相压住或跑出窗口。

```csharp
// ✗ 错：设计尺寸当物理像素用
btnStart.Left = w - 14 - 132;

// ✓ 对：过一遍 LogicalToDeviceUnits
int S(int v) { return LogicalToDeviceUnits(v); }
btnStart.Left = w - S(14) - S(132);
```

**④ 模态对话框会卡住 `SendMessage(BM_CLICK)`**

用 `BM_CLICK` 点按钮是同步等待：如果按钮里弹了 `MessageBox`，
发送方会一直阻塞到对话框关闭（自动化测试时表现为超时）。
改用 `PostMessage` 投递即可立刻返回。

## 遇到验证码

页面弹 captcha 不影响取数（签名在页面上下文里完成，验证码拦的是人机交互不是 XHR）。如果确实取不到数据：

```bash
node douyin-dl.mjs "<url>" --headful --wait 15000
```

打开可见窗口，手动过一下验证码，之后 profile 里会留下通过记录。

## 环境要求

**用 EXE**：什么都不用装，只要系统里有 Chrome 或 Edge。

**用源码**：
- Node.js ≥ 18（需要全局 `fetch` 和 `WebSocket`；Node 22+ 最稳）
- Chrome 或 Edge（脚本自动探测常见安装路径）

不需要 Playwright / Puppeteer。

## 文件结构

```
douyin-dl/
├── douyin-dl.mjs      # 引擎主程序（源码）
├── douyin-dl.mjs       # 抖音引擎源码
├── 抖音下载器.exe       # 抖音引擎成品（88.7 MB）
├── music-dl.mjs        # 音乐引擎源码（三平台聚合）
├── 音乐下载器.exe       # 音乐引擎成品（88.7 MB）
├── 下载.cmd            # 源码版交互式启动器（抖音）
├── build.cmd           # 抖音引擎打包脚本
├── build-music.cmd     # 音乐引擎打包脚本
├── sea-config.json     # 抖音 SEA 配置
├── music-sea.json      # 音乐 SEA 配置
├── music-probe.py      # 三平台接口探测脚本（调试用）
├── build/              # 打包中间产物
├── gui/
│   ├── Program.cs          # WinForms 界面源码（双标签页）
│   ├── build-gui.cmd       # 界面一键编译脚本
│   └── DouyinUI.exe        # 界面成品（34 KB）
└── README.md           # 本文件
```

运行时要用的三个文件（必须放同一目录）：

```
抖音下载器UI.exe   ← 界面，双击这个
抖音下载器.exe     ← 抖音引擎
音乐下载器.exe     ← 音乐引擎
```

UI 会自动找同目录的引擎；找不到会弹提示告诉你缺哪个。


