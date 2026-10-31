# 统一下载器

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-lightgrey.svg)](#)
[![Version](https://img.shields.io/badge/version-v1.2.0-brightgreen.svg)](../../releases)
[![Free](https://img.shields.io/badge/price-free-%23e91e63.svg)](#支持作者)

一个纯离线的 Windows 下载工具。九个功能，一个 exe，不需要装 Python、不需要装 Node、不需要登录。

> **完全免费开源，没有任何功能限制。** 如果它帮到了你，可以[请作者喝杯咖啡](#支持作者)，不打赏也完全不影响使用。

---

## 能做什么

| 功能 | 命令 | 说明 |
|---|---|---|
| 抖音 | `video` | 视频 / 图文，最高 4K |
| 音乐 | `music` | 酷我 / QQ / 网易云 / **酷狗** 四平台横评，货比三家 |
| 站点视频 | `sites` | B站 / 优酷 / 腾讯 / 芒果，支持**合集整季** |
| 网页抓取 | `grab` | 正文 / 图片 / 链接 |
| 知乎 | `zhihu` | 文章 → Markdown / TXT / Word，支持**专栏批量** |
| 公众号 | `wechat` | 纯 HTTP 抓取，图片无防盗链 |
| 歌单 | `playlist` | 网易云歌单批量，**断点续传** |
| 小说 | `novel` | 笔趣阁系 |
| 免版权素材 | `stock` | Coverr / Pixabay / Pexels，**可商用** B-roll |
| 快手 | `kuaishou` | 视频 / 图集（需登录态） |

---

## 快速开始

### 方式一：下载发布包（推荐）

去 [Releases](../../releases) 下载最新 zip，解压双击 `下载器UI.exe`。

**不需要激活码，不需要注册，打开就能用。**

### 方式二：从源码构建

需要 Node.js 24+ 和 Windows（csc.exe 是系统自带的 .NET Framework 编译器）。

```bash
cd src
npm install --no-audit --no-fund esbuild postject
cd ..

node tools/取依赖.mjs    # 下载 ffmpeg + yt-dlp（106MB，不在仓库里）
bash build.sh            # 构建，产物进 发布/bin/
bash make-test-ff.sh     # 打测试包
```

**关于 `tools/取依赖.mjs`**

`ffmpeg.exe`(84MB) 和 `yt-dlp.exe`(22MB) 是二进制，没进 git 仓库：

- clone 会变得极慢
- ffmpeg 接近 GitHub 单文件 100MB 红线
- 每次升级都要重新提交 106MB，历史迅速膨胀

脚本会自动下载到 `src/`，已存在的会跳过：

```bash
node tools/取依赖.mjs          # 缺什么补什么
node tools/取依赖.mjs --force  # 全部重下
node tools/取依赖.mjs --check  # 只检查不下载
```

**这些是运行时依赖，不是构建依赖** —— 引擎会在 exe 同目录找它们。
手动方案：从 [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) 取 `bin/ffmpeg.exe`，
从 [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases/latest) 取 `yt-dlp.exe`，
两个都丢进 `src/`。

---

## 命令行用法

```bash
下载器.exe --help                    # 看所有命令
下载器.exe music search "雨爱"        # 四平台横评
下载器.exe music get "雨爱" --meta    # 下载 + 歌词封面
下载器.exe sites "<B站链接>" --all-parts   # 整季
下载器.exe zhihu "<专栏链接>" --list   # 先看有多少篇
下载器.exe wechat "<公众号链接>" -f md,docx
下载器.exe playlist 3778678 -n 10 --meta
下载器.exe stock --scene 城市夜景 -n 8
```

每个命令都支持 `--help`，参数写得很清楚。

---

## 为什么是离线单文件

- **不联网验证**：不需要服务器，不怕跑路
- **不收集数据**：没有账号系统，没有埋点
- **不依赖运行时**：Node 被打进 exe（SEA），下载即用
- **源码可审计**：所有网络请求都在源码里，欢迎 review

---

## 支持作者

本软件**完全免费**，没有付费版、没有功能锁、没有广告。

如果它节省了你的时间，可以微信扫码随意打赏：

<p align="center">
  <img src="src/gui/donate.png" width="320" alt="微信打赏">
</p>

程序里也有入口：菜单 → **帮助 → 支持作者（打赏）**。

**不打赏完全不影响使用**，所有功能一直可用。

---

## 关于旧版卡密

v1.1.0 及更早的版本有卡密激活系统。**v1.2.0 起已完全移除限制**，所有功能免费。

源码里仍保留卡密相关代码（`src/dev/license.mjs` 等），但总开关 `FREE_EDITION = true` 让它们不生效。想自己 fork 做收费版的可以把它改成 `false`——**但必须重新生成密钥**，因为原密钥已随源码公开。

---

## 免责声明

- 本工具仅供**个人学习与技术研究**使用
- 下载内容的著作权归原作者/原平台所有，**下载不等于获得授权**
- 请勿将下载内容二次分发、上传、或用于商业用途
- 请遵守各平台的服务条款和当地法律法规
- 使用本工具产生的一切后果由使用者自行承担

**如果某平台明确反对此类工具，请停止使用对应功能。**

---

## 许可

本项目代码以 [MIT](LICENSE) 发布。

### 第三方组件

| 组件 | 许可 | 说明 |
|---|---|---|
| [ffmpeg](https://ffmpeg.org/) | **GPLv3** | 发布包内置的是 `essentials_build`，属 GPL 构建。按 GPL 要求，源码见 [ffmpeg.org/releases](https://ffmpeg.org/releases/) |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense | 站点视频解析引擎 |
| [esbuild](https://esbuild.github.io/) | MIT | 打包 |
| [postject](https://github.com/nodejs/postject) | MIT | SEA 注入 |

> 如果 fork 后要对外分发，内置的 ffmpeg 需遵守 GPLv3 的源码提供义务。
> 也可以选择不内置，让用户从 [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) 自取。

---

## 致谢

- [esbuild](https://esbuild.github.io/) — 打包
- [postject](https://github.com/nodejs/postject) — SEA 注入
- [ffmpeg](https://ffmpeg.org/) — 音视频合并
- [LinkSwift](https://github.com/hmjz100/LinkSwift) — 网盘直链思路参考（未包含其代码）
