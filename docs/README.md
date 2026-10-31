# 抖音 · 音乐 · 知乎 三合一工具箱

一个 EXE 引擎 + 一个图形界面，解决三类下载需求：

| 能力 | 说明 |
|---|---|
| **抖音视频** | 无水印原画，支持 4K 档位、图文作品 |
| **音乐** | 酷我 / QQ音乐 / 网易云 三平台横评，选音质最好的下，支持试听 |
| **知乎文章** | 抓正文转 Markdown，保留图片/代码块/表格 |

> 全部零依赖：引擎是 Node.js SEA 单文件，界面是 .NET Framework 自带的 WinForms。
> 用户机器上**不需要装 Node、不需要装任何运行库**。

---

## 一、快速开始

```
双击  下载器UI.exe
```

三个标签页：

- **抖音视频** —— 粘分享文案 → 选画质 → 开始下载
- **音乐搜索** —— 输歌名 → 三平台对比 → 选最优/试听/下载
- **知乎文章** —— 粘链接 → 开始抓取 → 得到 .md

两个 EXE 必须放在同一个文件夹：

```
下载器.exe      引擎（88.7 MB）
下载器UI.exe    界面（45.5 KB）
```

UI 找不到引擎会明确提示，不会静默失败。

---

## 二、命令行用法

引擎本身也是完整 CLI，UI 只是外壳。

```bash
# 抖音
下载器.exe video "https://v.douyin.com/xxxxx/"
下载器.exe video "https://v.douyin.com/xxxxx/" -q 4k -o D:\videos
下载器.exe video "<url1>" "<url2>" --audio

# 音乐
下载器.exe music search "雨爱"           # 三平台对比表
下载器.exe music get "雨爱"              # 下最优
下载器.exe music get "雨爱" -p kuwo      # 指定平台
下载器.exe music preview "雨爱"          # 试听片段

# 知乎
下载器.exe zhihu "https://zhuanlan.zhihu.com/p/xxxxx"
下载器.exe zhihu "https://zhuanlan.zhihu.com/p/xxxxx" -o D:\notes --headful

# 总览
下载器.exe            # 打印所有命令
下载器.exe --version
```

---

## 三、原理

### 3.1 为什么三个功能能塞进一个 EXE

`cli.mjs` 是唯一入口，按第一个参数分派：

```js
import * as modVideo from './douyin-dl.mjs';
import * as modMusic from './music-dl.mjs';
import * as modZhihu from './zhihu-md.mjs';

const COMMANDS = { video: { mod: modVideo }, music: { mod: modMusic }, zhihu: { mod: modZhihu } };

// 剥掉子命令，让下游看到熟悉的 argv
process.argv = [argv[0], argv[1], ...rest];
await COMMANDS[cmd].mod.run();
```

**关键点：必须用静态 `import`。** 用 `await import(变量)` esbuild 不会内联，
运行时去磁盘找 `./zhihu-md.mjs`，单 EXE 里没有这个文件，必报
`Cannot find module '.../zhihu-md.mjs'`。

三个模块各自导出 `run()`，同时保留直接运行能力：

```js
export async function run() { await main(); }
if (isDirectRun()) main();   // 按 argv[1] 文件名判断，被 import 时不触发
```

### 3.2 抖音：绕 a_bogus 签名

`aweme/detail` 需要动态签名，纯 HTTP 拿不到（`yt-dlp` 报 403 就是这个原因）。
做法是**启动真 Chrome，在页面上下文里 fetch**，签名由页面 JS 自己算。

流程：
1. 短链 302 → `aweme_id`
2. 启动 Chrome（反检测 + 持久 profile）
3. 暖场养 cookie（`ttwid` / `__ac_signature` / `odin_tt` / `s_v_web_id` / `UIFID`）
4. 页面内 fetch detail 接口
5. 解析 `bit_rate[]`，优先 `format: "mp4"`（dash 是纯视频没音轨）
6. 带 Referer 下载，断流重试 3 次

### 3.3 音乐：三平台直链

| 平台 | 搜索 | 取直链 | 门槛 |
|---|---|---|---|
| 酷我 | `search.kuwo.cn/r.s` | `antiserver.kuwo.cn/anti.s` **直接返回 mp3 URL** | 零 |
| QQ音乐 | `c.y.qq.com/soso` | `vkey.GetVkeyServer` | 需一枚 `y.qq.com` cookie |
| 网易云 | `music.163.com/api/search/get/web` | `song/media/outer/url` 302 | 部分版权受限 |

**货比三家逻辑**：三平台并行搜索 → 每条解析直链 + HEAD 探大小 →
按「标题+主歌手」分组 → 组内按体积降序 → 第一个标 ★ = 该曲最高音质源。

体积≈码率≈音质，所以「最大 = 最优」是合理近似。

### 3.4 知乎：破 JS 挑战

知乎内容页返回 403 + `<meta id="zh-zse-ck">`，需要在真浏览器执行 JS 生成
`__zse_ck` cookie。纯 HTTP、完整浏览器头、清 cookie 都拿不到。

所以同样是浏览器方案：打开页面 → 等挑战通过 → 在页面上下文把
`article .RichText` 的 DOM 转 Markdown。

转换器手写，支持：标题/段落/列表/引用/代码块（带语言）/表格/图片/链接/
粗体/斜体/删除线/行内码/上下标。

---

## 四、关键坑（改代码前必读）

### ① 单 EXE 里不能有动态 import

见 3.1。`await import('./xxx.mjs')` 打包后仍是运行时求值，单 EXE 必挂。

### ② `Network.getAllCookies` 必须带 sessionId

```js
// ✗ 报 "'Network.getAllCookies' wasn't found"，返回空
cdp.send('Network.getAllCookies', {})

// ✓
cdp.send('Network.getAllCookies', {}, sessionId)
```

### ③ 无头特征会被抖音 Argus 拦

报错原文：`Blocked by ArgusSecurityPlugin Uifid Not Found`。要三管齐下：

- `--disable-blink-features=AutomationControlled`
- `--user-agent=` 覆盖（否则带 `HeadlessChrome`）
- `Page.addScriptToEvaluateOnNewDocument` 抹掉 `navigator.webdriver`

### ④ postject 前必须移除 Authenticode 签名

```bash
signtool remove /s 目标.exe     # ← 不能省
npx postject 目标.exe NODE_SEA_BLOB blob.bin --sentinel-fuse NODE_SEA_FUSE_fce6...
```

**签名损坏比完全无签名更糟**：Windows 会把进程当不可信，表现为
`EPERM mkdir` + 子进程 `exit=0x80000003`。

### ⑤ 150% DPI 下手动布局全错位

WinForms 把控件放大 1.5 倍，但代码里的坐标是物理像素。所有设计尺寸要过
`LogicalToDeviceUnits()`：

```csharp
int S(int v) { return LogicalToDeviceUnits(v); }
btnStart.Left = w - S(14) - S(132);
```

### ⑥ 模态框会卡住 SendMessage(BM_CLICK)

`BM_CLICK` 同步等待，按钮里弹 `MessageBox` 会把发送方一直阻塞到对话框关闭。
自动化测试改用 `PostMessage`。

### ⑦ .NET Framework 默认不开 TLS 1.2/1.3

`HttpClient` 报「发送请求时出错」：

```csharp
ServicePointManager.SecurityProtocol =
    (SecurityProtocolType)3072 |   // Tls12
    (SecurityProtocolType)12288;   // Tls13
```

### ⑧ 酷我不给真片段

`antiserver...&format=aac&s=30` 的 `s=30` **不生效**，返回的是低码率完整音源。
必须读 mp4 `mvhd` 算时长才能判断真假片段。

### ⑨ 知乎正文全是超长跳转链接

`zhida.zhihu.com/search?...&zd_token=<300+字符 JWT>` 塞满正文。转码时按
`indexOf('zhida.zhihu.com/search')` 判断并降级为纯文本，文件从 22.8 KB → 12.3 KB。

### ⑩ 页面内脚本里别用正则字面量

```js
// ✗ 嵌套在模板字符串里，/ 产生歧义，报 Invalid regular expression flags
/zhida\.zhihu\.com\/search/.test(url)

// ✓
url.indexOf('zhida.zhihu.com/search') >= 0
```

同理反引号要写成 `String.fromCharCode(96)`。

---

## 五、构建

### 引擎

```bash
cd src
npx esbuild cli.mjs --bundle --platform=node --format=cjs --target=node24 \
    --outfile=build/all-bundle.cjs
node --experimental-sea-config sea-all.json
copy "C:\Program Files\nodejs\node.exe" 下载器.exe
signtool remove /s 下载器.exe
npx postject 下载器.exe NODE_SEA_BLOB build\all-blob.bin \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

### 界面

```bash
cd src\gui
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe ^
  /target:winexe /out:DouyinUI.exe ^
  /reference:System.Windows.Forms.dll ^
  /reference:System.Drawing.dll ^
  /reference:System.Web.Extensions.dll ^
  /reference:System.Net.Http.dll ^
  /optimize+ Program.cs
```

依赖：Node.js 18+、.NET Framework 4.x（Windows 自带）、signtool（Windows SDK 可选）。

---

## 六、目录

```
抖音音乐下载器/
├── 下载器.exe          引擎（单文件，含三个功能）
├── 下载器UI.exe        界面
├── 使用说明.txt        给最终用户看的
├── README.md           本文件（给开发者看的）
├── 交接文档.md         项目交接：状态、坑、待办
├── downloads/
│   ├── 视频/           抖音默认
│   ├── 音乐/           音乐默认
│   └── 文章/           知乎默认
├── logs/               运行日志（ui-YYYYMMDD.log）
├── config/
└── src/
    ├── cli.mjs             统一入口（分派）
    ├── douyin-dl.mjs       抖音引擎
    ├── music-dl.mjs        音乐引擎
    ├── zhihu-md.mjs        知乎引擎
    ├── sea-all.json        SEA 配置
    ├── music-probe.py      三平台接口探测（调试用）
    ├── build*.cmd          各模块打包脚本
    └── gui/
        ├── Program.cs      WinForms 界面
        └── build-gui.cmd   界面编译脚本
```

---

## 七、已知限制

| 限制 | 说明 |
|---|---|
| 知乎 IP 风控 | 部分网络出口被知乎封（`code 40362`），换网络或 `--headful` 登录 |
| 抖音风控 | 偶发 `Uifid Not Found`，勾「显示浏览器」手动过验证 |
| 网易云受限多 | 版权原因，三平台里灰色条目最多 |
| 酷我无真片段 | 试听会下完整音源，播放器里手动停 |
| EXE 体积 88.7 MB | SEA 内嵌整个 Node 运行时，无官方瘦身手段 |

---

## 八、实测记录

| 场景 | 结果 |
|---|---|
| 抖音 4K | 2160p / 2880×2160 / 29.53 MB ✅ |
| 抖音图文 | 自动识别 `/note/`，下全部图片 + 原声 ✅ |
| 音乐三平台对比 | 「雨爱」15 条候选，10 条可用 ✅ |
| 音乐自动选优 | 网易云 3.98 MB 优于酷我 1.38 MB ✅ |
| 音乐试听 | 片段下到 `%TEMP%\music-preview\` ✅ |
| 知乎转 MD | 7793 字 / 8 图 / 12.3 KB ✅ |
| 知乎链接清理 | `zhida` 残留 0 ✅ |
| 单 EXE 分派 | video / music / zhihu 三命令全通 ✅ |
