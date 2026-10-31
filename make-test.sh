#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# make-test.sh — 打「一测版」测试包（v1.0.1）
#
# 与 make-release / make-beta 的区别：
#   · 面向内部/小范围测试，不是正式发售包
#   · 目录名带括号说明（用户要求：括号里写清这版改了什么）
#   · 免授权（用 beta 引擎改名），测试者不用卡密
#   · 不含 ffmpeg（要用站点视频的自己放）
#
# 产物：
#   发布/统一下载器-v1.0.1-一测（免激活·权限加固+小说接入）/
#   发布/统一下载器-v1.0.1-一测（免激活·权限加固+小说接入）.zip
#
# 用法：bash make-test.sh
# ═══════════════════════════════════════════════════════════

set -euo pipefail
cd "$(dirname "$0")"

VER="v1.0.1"
TAG="一测"
NOTE="免激活·权限加固+小说接入"
NAME="统一下载器-${VER}-${TAG}（${NOTE}）"
OUT="发布/${NAME}"
ZIP="发布/${NAME}.zip"
BIN="发布/bin"

echo "═══════════════════════════════════════════════════"
echo "  生成 ${TAG}版 ${NAME}"
echo "═══════════════════════════════════════════════════"

# ── 0. 前置检查 ──
for f in "$BIN/下载器-beta.exe" "src/gui/DouyinUI-beta.exe" 使用说明.txt 免责声明.md 常见问题.md; do
  if [ ! -f "$f" ]; then
    echo "✗ 缺少必需文件：$f"
    echo "  先跑 bash build.sh"
    exit 1
  fi
done

# ── 1. 清理 ──
rm -rf "$OUT" "$ZIP"
mkdir -p "$OUT"

# ── 2. 复制二进制 ──
# 内测引擎改名成「下载器.exe」—— UI 按固定名找引擎，改不了。
cp "$BIN/下载器-beta.exe"        "$OUT/下载器.exe"
cp src/gui/DouyinUI-beta.exe     "$OUT/下载器UI.exe"

# ── 3. 用户文档 ──
cp 使用说明.txt   "$OUT/"
cp 常见问题.md    "$OUT/"
cp 免责声明.md    "$OUT/"

# ── 4. 运行时目录 ──
mkdir -p "$OUT/downloads/视频" "$OUT/downloads/音乐" "$OUT/downloads/文章" "$OUT/downloads/抓取" "$OUT/downloads/小说"
mkdir -p "$OUT/logs"

# ── 5. 本版说明 ──
cat > "$OUT/本版说明.txt" <<'TXT'
═══════════════════════════════════════════════════════
  统一下载器  v1.0.1  一测版
  （免激活 · 权限加固 + 小说接入）
═══════════════════════════════════════════════════════

【这一版不用激活码】

  双击「下载器UI.exe」直接就能用，五个功能全部解锁。
  小说下载走命令行（还没做界面），见下面第 3 条。

═══════════════════════════════════════════════════════
  这一版改了什么
═══════════════════════════════════════════════════════

1. 授权密钥不再"一眼可算"

   旧版把密钥拆成几段数字再 XOR 一个常量，任何人看到那段代码，
   写三行就能把密钥打印出来。拿到密钥 = 能自己造卡密 = 整条销售线报废。

   现在密钥用 AES-256-GCM 封装 + scrypt 派生，材料打散存放，
   解开后还要过摘要自检。**密钥值没变**，已经发出去的卡密继续有效。

2. 闸门从"一个 if"变成"每个功能自己验"

   旧版只在入口处有一个判断，改成 if (false) 五个功能全开。
   现在六个引擎各自独立验权，而且验的不是布尔值，是一件材料：
   校验通过才能拿到一张票，票不对任务直接开不了工。

   实测：把入口判断改成 if (false) 后，功能仍然被拦（exit=2）。

3. 小说下载接进来了（之前写了但没接线，等于白写）

   命令行用法：

     下载器.exe novel "https://www.biquge365.net/book/004552/"

     先看目录：    下载器.exe novel "<链接>" --list
     只下前 20 章： 下载器.exe novel "<链接>" --from 1 --to 20
     换输出目录：   下载器.exe novel "<链接>" -o D:\novels

   注意：整本 150+ 章连续下仍可能中途变慢（站点按 IP 限流），
   建议分段下，或把 --delay 调大（默认 800 毫秒）。

4. 修：知乎「下载图片到本地」勾选框是死的

   控件建了、位置排了，但从来没被读过 —— 勾不勾行为完全一样。
   现在真的接上了，默认勾选（和引擎默认行为一致）。

5. 修：curl 缺失时小说模块直接崩

   旧版探测了 curl 却没用这个结果，没装 curl 的系统上满屏 ENOENT。
   现在会自动降级到内置 HTTP（会慢一些，但能跑）。

6. 修：站点视频探活定时器泄漏

   探活失败时定时器没清，进程要多空转十几秒才退，界面看起来像卡死。
   这和 v1.0.0 修过的「CDP 60 秒定时器」是同一类问题，只是短一些。

7. 构建流程加固

   内测开关从"字符串替换"改成"覆写一个常量文件"，并且构建结束强制写回。
   旧做法改个标点就匹配不上，会静默产出"看着是内测版、其实带卡密闸门"的包。

═══════════════════════════════════════════════════════
  请重点测这几项
═══════════════════════════════════════════════════════

  □ 抖音：粘分享链接，选 4K 下一遍；再试一条 /note/ 图文
  □ 音乐：搜歌名 → 看三平台对比表 → 下载最优 → 试听
  □ 知乎：专栏链接 + 回答链接各一条，检查 .md 里的图片是不是本地的
          （断网再看，图片还在就是对的）
  □ 抓取：随便一个网页，看正文对不对
  □ 小说：命令行跑一条 --list，再跑 --to 5 下几章看看
  □ 界面：高 DPI（125%/150%）下看控件有没有错位

  站点视频（B站等）需要 ffmpeg.exe，本包没带。
  把 ffmpeg.exe 放到本文件夹即可启用。

═══════════════════════════════════════════════════════
  出问题怎么反馈
═══════════════════════════════════════════════════════

  菜单「授权 → 反馈问题」，或命令行：
     下载器.exe report "描述" --log logs\xxx.log

  日志会自动脱敏（路径、邮箱、卡密都抹掉）。

  第一次打开请读「免责声明.md」，运行即视为同意。
═══════════════════════════════════════════════════════
TXT

# ── 6. 污染扫描 ──
echo ""
echo "── 污染扫描 ──"
FORBIDDEN=(
  "*.mjs" "*.cjs" "*.js" "*.ts" "*.cs" "*.py"
  "*.cmd" "*.sh" "*.ps1" "*.json"
  "README.md" "交接文档.md" "发布说明.md" "卡密系统说明.md"
  "收费发布清单.md" "report-config.sample.json" "本版说明.md"
  "卡密生成器.exe" "keygen.exe" "gen-license*"
  "src" "tools" "internal" "内部工具" "build"
)
BAD=0
for pat in "${FORBIDDEN[@]}"; do
  found=$(find "$OUT" -name "$pat" -print 2>/dev/null || true)
  if [ -n "$found" ]; then
    echo "✗ 发现禁止内容（$pat）："
    echo "$found" | sed 's/^/    /'
    BAD=1
  fi
done
if [ "$BAD" -eq 1 ]; then
  echo ""; echo "✗ 包被污染，已中止。"; rm -rf "$OUT"; exit 1
fi
echo "✓ 无源码、无开发文档、无卡密生成器"

# ── 7. 冒烟测试 ──
echo ""
echo "── 冒烟测试 ──"
VER_OUT="$("$OUT/下载器.exe" --version 2>&1 | head -1)"
echo "  版本 → ${VER_OUT}"
case "$VER_OUT" in
  *"beta"*) ;;
  *) echo "✗ 版本号不是内测版，可能拿错了引擎"; exit 1 ;;
esac

# 免授权验证：清掉卡密状态后仍应能跑（这里只验证不会因未激活而 exit=2）
HELP_OUT="$("$OUT/下载器.exe" music --help 2>&1 | head -1)"
echo "  帮助 → ${HELP_OUT}"

# ── 8. 打包 ──
echo ""
echo "── 打包 ──"
SRC="$OUT" DST="$ZIP" python - <<'PYZIP'
import zipfile, os, time

src_dir = os.environ['SRC']
out_zip = os.environ['DST']

class Utf8ZipInfo(zipfile.ZipInfo):
    def _encodeFilenameFlags(self):
        return self.filename.encode('utf-8'), self.flag_bits | 0x800

if os.path.exists(out_zip):
    os.remove(out_zip)

with zipfile.ZipFile(out_zip, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for dirpath, dirs, files in os.walk(src_dir):
        rel = os.path.relpath(dirpath, src_dir)
        base = '' if rel == '.' else rel.replace('\\', '/') + '/'
        if base:
            zi = Utf8ZipInfo(base)
            zi.external_attr = (0o40755 << 16) | 0x10
            z.writestr(zi, b'')
        for f in sorted(files):
            full = os.path.join(dirpath, f)
            zi = Utf8ZipInfo(base + f,
                             date_time=time.localtime(os.path.getmtime(full))[:6])
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = (0o100644 << 16)
            with open(full, 'rb') as fh:
                z.writestr(zi, fh.read())

print('  OK  %s  %.1f MB' % (os.path.basename(out_zip), os.path.getsize(out_zip)/1024/1024))
PYZIP

# ── 9. 清单 ──
echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✓ 一测版就绪"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  目录：$OUT"
find "$OUT" -type f -printf '    %10s  %P\n' | sort -k2
echo ""
echo "  包：$(stat -c %s "$ZIP" 2>/dev/null | awk '{printf "%.1f MB", $1/1048576}')"
echo ""
