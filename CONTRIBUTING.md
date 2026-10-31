# 参与贡献

欢迎 issue 和 PR。这个项目是纯离线的 Windows 下载工具，代码结构不复杂，但有一些坑。

---

## 开发环境

| 需要 | 说明 |
|---|---|
| Node.js 24+ | 引擎是 ESM 模块，SEA 打包需要 24 |
| Windows 10/11 | UI 用 csc.exe（系统自带 .NET Framework） |
| Git Bash | `build.sh` 是 bash 脚本 |
| ffmpeg | 可选，站点视频合并用 |

```bash
git clone <repo>
cd <repo>/src
npm install --no-audit --no-fund esbuild postject
cd ..
bash 改完就跑这个.sh     # 构建 + 打包 + 自检
```

**不要只跑 `build.sh`** —— 它只更新 `发布/bin/`，不更新发布包。跑 `改完就跑这个.sh` 会一起做掉，还带 10 项自检。

---

## 代码结构

```
src/
├── cli/cli.mjs          命令分派（COMMANDS 表）
├── engines/             各功能引擎，每个导出 run()
│   ├── douyin-dl.mjs    抖音（CDP + Chrome）
│   ├── music-dl.mjs     四平台音乐（酷我/QQ/网易云/酷狗）
│   ├── music-meta.mjs   歌词/封面/专辑
│   ├── video-dl.mjs     站点视频（yt-dlp）
│   ├── web-grab.mjs     通用抓取
│   ├── zhihu-md.mjs     知乎（含专栏批量）
│   ├── wechat-md.mjs    公众号（纯 HTTP）
│   ├── playlist.mjs     歌单批量
│   ├── novel-dl.mjs     小说
│   ├── stock.mjs        免版权素材
│   ├── kuaishou-dl.mjs  快手
│   └── doc-export.mjs   md→txt/docx
├── dev/
│   ├── gate.mjs         功能闸门（FREE_EDITION 总开关）
│   ├── license.mjs      卡密系统（开源后已停用）
│   ├── secret.mjs       ⚠ 密钥已公开，仅历史遗留
│   ├── port.mjs         端口探测（绕 Windows 保留段）
│   ├── browser.mjs      浏览器定位
│   ├── report.mjs       错误上报
│   └── obfuscate.mjs    构建期字符串混淆
└── gui/Program.cs       WinForms 界面（8 个标签页）
```

---

## 加一个新功能

1. **写引擎** `src/engines/xxx.mjs`
   - 导出 `export async function run()`，第一行 `assertFeature('xxx')`
   - 支持 `--help`（闸门对 help 永远放行）
   - 多行输入要用全文正则切 URL，**不要用 `^https?://`**（见下方坑）

2. **加白名单** `src/dev/gate.mjs` 的 `FEATURES`
   - 忘了加会返回 `unknown-feature`，报错看起来像"未授权"，很难查

3. **接 CLI** `src/cli/cli.mjs`
   - 加 `import * as modXxx`
   - 加进 `COMMANDS` 表

4. **接 UI**（可选）`src/gui/Program.cs`
   - 加 TabPage + Build 方法
   - 用 `RunEngineTask()` 起进程，别照抄抖音那套 600 行的 Start+Stop+ReadLoop
   - **标签文字要短**（8 个标签在 1280 宽下才放得下）

5. **跑** `bash 改完就跑这个.sh`

---

## 已知的坑（改代码前先看）

### 1. 模板字符串里的正则反斜杠要双写

```js
// 错误：模板解析后变成 /p/，正则会提前结束
`href.match(/zhuanlan\.zhihu\.com\/p\/(\d+)/)`

// 正确：双写才能让浏览器看到 \/ \. \d
`href.match(/zhuanlan\\.zhihu\\.com\\/p\\/(\\d+)/)`
```

症状：`SyntaxError: Invalid regular expression flags`，但错误被 try/catch 吞了，
只看到"没找到内容"。

### 2. 多行输入别用 `^https?://` 判断

UI 的输入框是多行的，粘两条链接时 C# 会把整段当一个参数传进来。
`^` 只匹配字符串开头，带换行的整串直接丢掉。

用全文正则：`String(p).match(/https?:\/\/[^\s"'<>]+/g)`

### 3. 定时器必须 unref + finally 清理

```js
const t = setTimeout(...);
t.unref?.();
try { ... } finally { clearTimeout(t); }
```

不清理的话，失败路径上进程要多空转十几秒，用户以为卡死。

### 4. Windows 有保留端口段

Hyper-V / WSL / Docker 会批量占掉一段端口，落在里面的**谁都 bind 不了**
（Chrome 也一样，报 `WSAEACCES`）。用 `dev/port.mjs` 的 `pickPort()`。

```js
port = await pickPort(9333, warn);   // 自动顺延到可用端口
```

### 5. 下载先写 `.part` 再改名

中断会留下残片，而"文件存在就跳过"会让它永远残缺。
先写 `.part`，完整了再 `rename`。

### 6. `findBrowser()` 返回对象不是字符串

```js
const r = findBrowser();
const exe = r && r.ok ? r.path : null;   // 不是 findBrowser() 直接用
```

### 7. 改完必须打包

`build.sh` 只更新 `发布/bin/`。发布包要跑 `make-test-ff.sh`。

---

## 提交 PR 前

- [ ] `bash 改完就跑这个.sh` 全绿
- [ ] 新增引擎在 `gate.mjs` 的 `FEATURES` 里
- [ ] 没有提交 `node_modules/`、`发布/`、`src/build/`
- [ ] 没有提交 `report-config.json`、`卡密生成器.exe`
- [ ] 中文注释写清「为什么」而不只是「做了什么」

---

## 不要提交的东西

`.gitignore` 已经排除了，但手工 `git add` 时要小心：

- `src/dev/keygen.mjs` —— 发卡工具
- `report-config.json` —— SMTP 凭据
- 任何 `.exe`
- `%APPDATA%` 下的激活文件

---

## 许可

提交 PR 即表示同意以 [MIT](LICENSE) 许可发布你的贡献。
