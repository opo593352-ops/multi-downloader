#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# make-test-ff.sh — 打「一测版」测试包（v1.2.0 开源版起）
#
# ═══ 为什么不再分 paid / free ═══
#
#   v1.1.0 及更早要打两个包，因为「正式版要激活、免激活版不用」。
#   v1.2.0 转开源免费后，闸门已关闭（dev/gate.mjs 的 FREE_EDITION = true），
#   两个引擎功能完全一样 —— 再分两种模式只会让测试者困惑
#   （"我该下哪个？"），也容易发错。
#
#   所以现在**只打一个包**，包里放正式引擎（不带 INTERNAL_BUILD 标记）。
#
# ═══ 包里有什么 ═══
#
#   下载器.exe      88 MB   引擎（Node 24 SEA，自带运行时）
#   下载器UI.exe   0.2 MB   界面（8 个标签页）
#   ffmpeg.exe      84 MB   音视频合并
#   yt-dlp.exe      22 MB   站点视频解析（缺了站点视频不可用）
#   4 份文档 + 空的 downloads/ logs/
#
#   总计约 195 MB，解压即用，不装 Python、不装 Node、不联网激活。
#
# 用法：bash make-test-ff.sh
# ═══════════════════════════════════════════════════════════

set -euo pipefail
cd "$(dirname "$0")"

# ── 版本号：从源码读，别手写 ──
detect_ver() {
  python - <<'PY' 2>/dev/null || echo "1.2.0"
import io, re
s = io.open('src/cli/cli.mjs', encoding='utf-8').read()
m = re.search(r":\s*'(\d+\.\d+\.\d+)'\s*;", s)
print(m.group(1) if m else '1.2.0')
PY
}
VER="${VER:-$(detect_ver)}"
TAG="一测"
NOTE="免费开源·含ffmpeg+yt-dlp"
NAME="统一下载器-v${VER}-${TAG}（${NOTE}）"
OUT="发布/${NAME}"
ZIP="发布/${NAME}.zip"
BIN="发布/bin"

echo "═══════════════════════════════════════════════════"
echo "  生成 ${NAME}"
echo "═══════════════════════════════════════════════════"

# ── 0. 前置检查 ──
for f in "$BIN/下载器.exe" "$BIN/下载器UI.exe" "$BIN/ffmpeg.exe" "$BIN/yt-dlp.exe" \
         使用说明.txt 免责声明.md 常见问题.md; do
  if [ ! -f "$f" ]; then
    echo "✗ 缺少必需文件：$f"
    echo "  引擎/UI 先跑 bash build.sh"
    echo "  ffmpeg.exe / yt-dlp.exe 需放在 $BIN/ 下"
    exit 1
  fi
done

# 版本号必须对得上，否则会把旧引擎打进新包
ACTUAL="$("$BIN/下载器.exe" --version 2>&1 | head -1)"
case "$ACTUAL" in
  *"v${VER}"*) ;;
  *) echo "✗ 引擎版本不符：期望 v${VER}，实际 ${ACTUAL}"
     echo "  用 VER=${VER} bash build.sh 重新构建"; exit 1 ;;
esac
echo "  引擎版本 → ${ACTUAL}"

# ── 1. 清理 ──
rm -rf "$OUT" "$ZIP"
mkdir -p "$OUT"

# ── 2. 复制二进制 ──
cp "$BIN/下载器.exe"   "$OUT/"
cp "$BIN/下载器UI.exe" "$OUT/"
cp "$BIN/ffmpeg.exe"   "$OUT/"
cp "$BIN/yt-dlp.exe"   "$OUT/"
echo "  ffmpeg.exe   $(stat -c %s "$OUT/ffmpeg.exe" | awk '{printf "%.1f MB", $1/1048576}')"
echo "  yt-dlp.exe   $(stat -c %s "$OUT/yt-dlp.exe" | awk '{printf "%.1f MB", $1/1048576}')"

# ── 3. 用户文档 ──
cp 使用说明.txt   "$OUT/"
cp 常见问题.md    "$OUT/"
cp 免责声明.md    "$OUT/"

# ── 4. 运行时目录 ──
mkdir -p "$OUT/downloads/视频" "$OUT/downloads/音乐" "$OUT/downloads/文章" \
         "$OUT/downloads/抓取" "$OUT/downloads/小说" "$OUT/downloads/公众号" \
         "$OUT/downloads/歌单" "$OUT/downloads/素材"
mkdir -p "$OUT/logs"

# ── 5. 快速上手 ──
cat > "$OUT/开始使用.txt" <<'TXT'
═══════════════════════════════════════════════════════
  统一下载器  v__VER__  一测版
  （完全免费开源 · ffmpeg + yt-dlp 已内置）
═══════════════════════════════════════════════════════

【没有激活码，没有付费，没有功能限制】

  解压 → 双击「下载器UI.exe」→ 直接用。
  九个功能全部可用。

═══════════════════════════════════════════════════════
  本包能做什么
═══════════════════════════════════════════════════════

  ✓ 抖音视频 / 图文（最高 4K）
  ✓ 音乐四平台横评（酷我 / QQ / 网易云 / 酷狗）+ 歌词封面
  ✓ 站点视频（B站 / 优酷 / 腾讯 / 芒果，支持合集整季）
  ✓ 网页通用抓取
  ✓ 知乎文章 → Markdown / TXT / Word，支持专栏批量
  ✓ 公众号文章 → Markdown / Word
  ✓ 音乐歌单批量下载（网易云，断点续传）
  ✓ 免版权素材 B-roll（Coverr / Pixabay / Pexels，可商用）
  ✓ 小说下载（笔趣阁系）

═══════════════════════════════════════════════════════
  包里的四个 exe 分别是什么
═══════════════════════════════════════════════════════

  下载器UI.exe    界面（平时就双击这个）
  下载器.exe      引擎（界面会自动调用，也可以命令行用）
  ffmpeg.exe      音视频合并（站点视频必需）
  yt-dlp.exe      站点解析（站点视频必需）

  ⚠ 四个文件必须放在同一个文件夹，别单独搬走任何一个。
  ⚠ 前两个不能删，后两个删了站点视频就用不了。

═══════════════════════════════════════════════════════
  请重点测这几项
═══════════════════════════════════════════════════════

  □ 抖音：粘分享链接，选 4K 下一遍；再试一条 /note/ 图文
  □ 音乐：搜歌名 → 看四平台对比表 → 下载最优 → 试听
  □ 站点视频：粘 B站 链接，选 720P，看能不能下出来
  □ 站点视频：粘一个多P合集链接，勾「整季/全部分P」
  □ 知乎：专栏链接，先点「查看清单」看篇数，再下载
  □ 公众号：粘文章链接，看图片是不是本地的（断网再看）
  □ 歌单：网易云歌单链接，先下 5 首试水，再重跑看是否跳过
  □ 素材：选个场景下 3 条，看缩略图和授权说明
  □ 界面：高 DPI（125%/150%）下看控件有没有错位
  □ 菜单「帮助 → 支持作者」能正常弹出收款码

═══════════════════════════════════════════════════════
  常见问题
═══════════════════════════════════════════════════════

  Q: 站点视频报「缺少 yt-dlp」
  A: 检查 yt-dlp.exe 是否还在包内。被杀软删了的话，
     去 https://github.com/yt-dlp/yt-dlp/releases 下回来。

  Q: 站点视频突然都失败了
  A: yt-dlp 需要更新（站点改版会导致解析失效）。
     下载新版 yt-dlp.exe 覆盖包内那个即可，不用重装软件。

  Q: 抖音报「这个视频取不到」
  A: 该视频可能已删除或仅作者可见。换一条试试。

  Q: 知乎报「请求存在异常」
  A: 知乎对频繁访问有风控。等几分钟，或勾选「显示浏览器」
     手动过一下验证。

  更多见「常见问题.md」，62 条 Q&A。

═══════════════════════════════════════════════════════
  关于
═══════════════════════════════════════════════════════

  本软件完全免费开源（MIT 许可），没有任何收费项目。
  如果它帮到了你，菜单「帮助 → 支持作者」可以随意打赏，
  不打赏也完全不影响使用。

  第一次打开请读「免责声明.md」，运行即视为同意。
═══════════════════════════════════════════════════════
TXT

# heredoc 用的是 <<'TXT'（引号版），变量不展开 —— 用 sed 后补
find "$OUT" -name '*.txt' -exec sed -i "s/__VER__/${VER}/g" {} \;

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
  "license.txt" "clock.dat" "machine.txt" "used-cards.txt" ".eula-agreed"
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
echo "✓ 无源码、无开发文档、无卡密生成器、无激活残留"

# ── 7. 冒烟测试 ──
echo ""
echo "── 冒烟测试 ──"
V="$("$OUT/下载器.exe" --version 2>&1 | head -1)"
echo "  版本 → ${V}"
case "$V" in
  *"v${VER}"*) ;;
  *) echo "✗ 包内引擎版本不对"; rm -rf "$OUT"; exit 1 ;;
esac

FFV="$("$OUT/ffmpeg.exe" -version 2>&1 | head -1)"
echo "  ffmpeg → ${FFV:0:50}"
case "$FFV" in
  *"ffmpeg version"*) ;;
  *) echo "✗ ffmpeg 无法运行"; exit 1 ;;
esac

# yt-dlp 必须真能跑（站点视频没它直接不可用，测试者反馈过）
YTV="$("$OUT/yt-dlp.exe" --version 2>&1 | head -1)"
echo "  yt-dlp → ${YTV}"
case "$YTV" in
  [0-9][0-9][0-9][0-9].*) ;;
  *) echo "✗ yt-dlp 无法运行（站点视频会不可用）"; exit 1 ;;
esac

# 开源版：未激活必须能跑（反向检查）
if TMPHOME="$(mktemp -d)" APPDATA="$(mktemp -d)" "$OUT/下载器.exe" music search "test" >/dev/null 2>&1; then
  echo "  免费版检查 → 无需激活，可直接使用 ✓"
else
  echo "✗ 未激活状态下跑不通 —— 检查 dev/gate.mjs 的 FREE_EDITION 是否为 true"
  exit 1
fi

# ── 8. 打包 ──
echo ""
echo "── 打包 ──"
SRC="$OUT" DST="$ZIP" python - <<'PYZIP'
import zipfile, os, time

src_dir = os.environ['SRC']
out_zip = os.environ['DST']

class Utf8ZipInfo(zipfile.ZipInfo):
    """强制 UTF-8 文件名 + bit 11，让 Windows 资源管理器正确显示中文名。"""
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
echo "  ✓ 测试版就绪"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  目录：$OUT"
find "$OUT" -type f -printf '    %10s  %P\n' | sort -k2
echo ""
echo "  包：$(stat -c %s "$ZIP" 2>/dev/null | awk '{printf "%.1f MB", $1/1048576}')"
echo ""
echo "  发货说明："
echo "    · 单包发完，解压即用，不用装任何东西"
echo "    · 不区分「正式版/免激活版」—— 开源版功能完全一样"
echo "    · 唯一要求：四个 exe 别分开，放同一个文件夹"
echo ""
