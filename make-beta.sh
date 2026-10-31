#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# make-beta.sh — 生成内测版（免授权，带 beta 标记）
#
# 与发行版的区别：
#   · 无需激活卡密，打开即用
#   · 版本号 v1.0.0-beta1
#   · 首次启动弹一次「内测说明」
#   · 状态栏显示「内测版 · 无需激活」
#
# 产物：
#   发布/统一下载器-v1.0.0-beta1/
#   发布/统一下载器-v1.0.0-beta1.zip        主包（无 ffmpeg）
#   发布/ffmpeg-附件.zip                      附件（复用）
#
# 用法：bash make-beta.sh
# ═══════════════════════════════════════════════════════════

set -euo pipefail
cd "$(dirname "$0")"

VER_TAG="v1.0.0-beta1"
NAME="统一下载器-${VER_TAG}"
OUT="发布/${NAME}"
ZIP="发布/${NAME}.zip"
FFZIP="发布/ffmpeg-附件.zip"

echo "═══════════════════════════════════════════════════"
echo "  生成内测版 ${NAME}"
echo "═══════════════════════════════════════════════════"

# ── 0. 前置检查 ──
for f in 下载器-beta.exe src/gui/DouyinUI-beta.exe 使用说明.txt 免责声明.md 常见问题.md; do
  if [ ! -f "$f" ]; then
    echo "✗ 缺少必需文件：$f"
    exit 1
  fi
done

# ── 1. 清理 ──
rm -rf "$OUT" "$ZIP"
mkdir -p "$OUT"

# ── 2. 复制（改名为正式名，UI 按固定名找引擎） ──
cp 下载器-beta.exe            "$OUT/下载器.exe"
cp src/gui/DouyinUI-beta.exe  "$OUT/下载器UI.exe"

# ── 3. 文档 ──
cp 使用说明.txt   "$OUT/"
cp 常见问题.md    "$OUT/"
cp 免责声明.md    "$OUT/"

# ── 4. 目录 ──
mkdir -p "$OUT/downloads/视频" "$OUT/downloads/音乐" "$OUT/downloads/文章" "$OUT/downloads/抓取" "$OUT/logs"

# ── 5. 内测专用说明 ──
cat > "$OUT/内测说明.txt" <<'TXT'
═══════════════════════════════════════════════════════
  统一下载器  v1.0.0-beta1  ·  内测版说明
═══════════════════════════════════════════════════════

【这一版是内测版，不需要激活码】

  双击「下载器UI.exe」直接打开就能用，
  五个功能全部解锁，不用找我要卡密。

  正式版会加激活机制，这版不会。

═══════════════════════════════════════════════════════

【请帮忙测这几件事】

  □ 抖音视频
      粘一条分享链接，选 4K，看能不能下出来
      再试一条 /note/ 图文链接，看图片是否全下

  □ 音乐
      搜一个歌名，看三平台对比表出不出来
      点「下载最优」，看文件有没有真下下来
      点「试听」，看有没有声音

  □ 站点视频（B站）
      粘个视频链接，选 1080P，看能不能下
      勾「下载字幕」，看 .srt 有没有生成
      ⚠ 这一项需要 ffmpeg，找我要附件

  □ 知乎
      粘一条专栏链接，看 .md 有没有生成
      粘一条回答链接（question/xxx），同样测
      打开生成的 .md，检查图片是不是本地的
      （断网再看，图片还在就是对的）

  □ 网页抓取
      随便粘个网页，看正文抓得对不对

  □ 界面
      如果你用高 DPI 缩放（125% / 150%），
      看控件有没有错位

═══════════════════════════════════════════════════════

【出问题怎么反馈】

  菜单「帮助」→「反馈问题」
  写清楚：你做了什么 → 报什么错 → 什么时候开始的
  勾上「附带日志」，点发送

  日志会自动脱敏（路径、邮箱都抹掉），放心发。

═══════════════════════════════════════════════════════

【请勿外传】

  这版只给你测，别发给别人。
  正式版发布后我会通知你。

═══════════════════════════════════════════════════════

包里有「常见问题.md」，62 条 Q&A，
遇到问题先看看，95% 能自己解决。

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
  "收费发布清单.md" "report-config.sample.json" "内测说明.md"
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
  echo ""; echo "✗ 发布包被污染，已中止。"; rm -rf "$OUT"; exit 1
fi
echo "✓ 无源码、无开发文档、无卡密生成器"

# ── 7. 冒烟测试（含免授权验证） ──
echo ""
echo "── 冒烟测试 ──"
VER="$("$OUT/下载器.exe" --version 2>&1 | head -1)"
echo "  版本 → ${VER}"
case "$VER" in
  *"beta"*) ;;
  *) echo "✗ 版本号不对，应为 beta"; exit 1 ;;
esac

# 免授权：不带任何卡密直接跑一个搜索
LIC_OUT="$("$OUT/下载器.exe" license status 2>&1)"
if echo "$LIC_OUT" | grep -q "未激活"; then
  echo "  卡密状态 → 未激活（正常，这版免授权）"
fi

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
echo "  ✓ 内测版就绪"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  目录：$OUT"
find "$OUT" -type f -printf '    %10s  %P\n' | sort -k2
echo ""
echo "  包：$(stat -c %s "$ZIP" 2>/dev/null | awk '{printf "%.1f MB", $1/1048576}')"
echo ""
echo "  发给测试者的三样东西："
echo "    1. 这个 zip（$ZIP）"
echo "    2. ffmpeg-附件.zip（只有要测 B站的才需要）"
echo "    3. 一句话：解压双击 UI，不用激活，出问题点帮助→反馈"
echo ""
