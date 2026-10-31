#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# make-release-lite.sh — 生成「精简主包」（不含 ffmpeg）
#
# 为什么拆：
#   ffmpeg.exe 87 MB，只在「站点视频」合并音视频时需要。
#   90% 的买家只用抖音 / 音乐 / 知乎 / 抓取，不需要它。
#   主包从 174 MB 降到 93 MB，网盘下载速度问题直接解决。
#
# 产物：
#   发布/统一下载器-v1.0.0-lite.zip          主包（无 ffmpeg）
#   发布/ffmpeg-附件.zip                     附件包（单独发给需要的人）
#
# 用法：bash make-release-lite.sh
# ═══════════════════════════════════════════════════════════

set -euo pipefail
cd "$(dirname "$0")"

VERSION="1.0.0"
NAME="统一下载器-v${VERSION}"
OUT="发布/${NAME}"
ZIP="发布/${NAME}-lite.zip"
FFZIP="发布/ffmpeg-附件.zip"

echo "═══════════════════════════════════════════════════"
echo "  生成精简主包 ${NAME}（不含 ffmpeg）"
echo "═══════════════════════════════════════════════════"

# ── 0. 前置检查 ──
for f in 下载器.exe 下载器UI.exe ffmpeg.exe 使用说明.txt 免责声明.md 常见问题.md; do
  if [ ! -f "$f" ]; then
    echo "✗ 缺少必需文件：$f"
    exit 1
  fi
done

# ── 1. 清理 ──
rm -rf "$OUT" "$ZIP" "$FFZIP"
mkdir -p "$OUT"

# ── 2. 复制二进制（不含 ffmpeg） ──
cp 下载器.exe     "$OUT/"
cp 下载器UI.exe   "$OUT/"

# ── 3. 复制用户文档 ──
cp 使用说明.txt   "$OUT/"
cp 常见问题.md    "$OUT/"
cp 免责声明.md    "$OUT/"

# ── 4. 建目录 ──
mkdir -p "$OUT/downloads/视频"
mkdir -p "$OUT/downloads/音乐"
mkdir -p "$OUT/downloads/文章"
mkdir -p "$OUT/downloads/抓取"
mkdir -p "$OUT/logs"

# ── 5. 快速上手 ──
cat > "$OUT/开始使用.txt" <<'TXT'
═══════════════════════════════════════════════════════
  统一下载器  快速上手（30 秒）
═══════════════════════════════════════════════════════

第 1 步  双击「下载器UI.exe」

第 2 步  菜单「授权」→「查看本机机器码」
         复制那 5 位大写字母数字

第 3 步  把机器码发给卖家，换取激活码

第 4 步  菜单「授权」→「输入激活码」
         粘贴整串 → 点激活

激活后状态栏会显示档位和剩余天数，例如：
    已激活 · 年卡 · 剩 366 天 · 机器码 25C2B

═══════════════════════════════════════════════════════

本包含两个 exe，能用的功能：

  ✓ 抖音视频
  ✓ 音乐三平台横评
  ✓ 知乎转 Markdown
  ✓ 网页抓取

  ⚠ 站点视频（B站/优酷/腾讯/芒果）需要 ffmpeg

═══════════════════════════════════════════════════════

需要站点视频功能？
  找卖主要「ffmpeg 附件包」，把 ffmpeg.exe
  放到本文件夹（和 下载器.exe 同级），即可启用。

遇到问题？先看「常见问题.md」，62 条 Q&A 都在里面。

注意：
  · 两个 exe 必须放在同一个文件夹
  · 请勿把本软件及其激活码转售、共享、二次分发
  · 下载内容仅供个人学习备份，版权归原作者

第一次打开请先读「免责声明.md」，运行即视为同意。
═══════════════════════════════════════════════════════
TXT

# ── 6. 污染扫描 ──
echo ""
echo "── 污染扫描 ──"
FORBIDDEN=(
  "*.mjs" "*.cjs" "*.js" "*.ts" "*.cs" "*.py"
  "*.cmd" "*.sh" "*.ps1" "*.json"
  "README.md" "交接文档.md" "发布说明.md" "卡密系统说明.md"
  "收费发布清单.md" "report-config.sample.json"
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

# ── 7. 冒烟测试 ──
echo ""
echo "── 冒烟测试 ──"
VER="$("$OUT/下载器.exe" --version 2>&1 | head -1)"
echo "  下载器.exe --version → ${VER}"
case "$VER" in
  *"统一下载器"*) ;;
  *) echo "✗ 引擎无法运行"; exit 1 ;;
esac

# ── 8. 打包（Python，UTF-8 文件名标志） ──
echo ""
echo "── 打包 ──"
SRC="$OUT" DST="$ZIP" ATTACH_FF="$FFZIP" FF="ffmpeg.exe" python - <<'PYZIP'
import zipfile, os, sys, time

src_dir   = os.environ['SRC']
out_zip   = os.environ['DST']
ff_zip    = os.environ['ATTACH_FF']
ff_file   = os.environ['FF']

class Utf8ZipInfo(zipfile.ZipInfo):
    """强制 UTF-8 文件名 + bit 11，让 Windows 资源管理器正确显示中文名。"""
    def _encodeFilenameFlags(self):
        return self.filename.encode('utf-8'), self.flag_bits | 0x800

def add_tree(z, root):
    for dirpath, dirs, files in os.walk(root):
        rel = os.path.relpath(dirpath, root)
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

# 主包
if os.path.exists(out_zip):
    os.remove(out_zip)
with zipfile.ZipFile(out_zip, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    add_tree(z, src_dir)
print('  主包  %-32s %6.1f MB' % (os.path.basename(out_zip), os.path.getsize(out_zip)/1024/1024))

# ffmpeg 附件包
if os.path.exists(ff_zip):
    os.remove(ff_zip)
with zipfile.ZipFile(ff_zip, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    # 附件包结构：解开后是 ffmpeg.exe + 说明.txt
    zi = Utf8ZipInfo('ffmpeg.exe', date_time=time.localtime(os.path.getmtime(ff_file))[:6])
    zi.compress_type = zipfile.ZIP_DEFLATED
    zi.external_attr = (0o100755 << 16)
    with open(ff_file, 'rb') as fh:
        z.writestr(zi, fh.read())

    note = (
        'ffmpeg 附件包说明\r\n'
        '════════════════════════════════\r\n'
        '\r\n'
        '把本文件解压出的 ffmpeg.exe 放到「下载器.exe」所在的同一个文件夹。\r\n'
        '\r\n'
        '放好之后，「站点视频」标签页（B站/优酷/腾讯/芒果）就能用了。\r\n'
        '不带 ffmpeg 时，站点视频下载会提示缺少合并工具，其余四个功能不受影响。\r\n'
        '\r\n'
        '为什么单独拆出来：\r\n'
        '  ffmpeg.exe 有 87 MB，只在合并音视频时需要。\r\n'
        '  抖音 / 音乐 / 知乎 / 网页抓取 都用不到它。\r\n'
        '\r\n'
        '本文件来自 FFmpeg 官方构建，许可证 GNU GPL v3。\r\n'
        '源码：https://ffmpeg.org/releases/\r\n'
        '许可证：https://www.gnu.org/licenses/gpl-3.0.html\r\n'
    )
    zi2 = Utf8ZipInfo('说明.txt')
    zi2.compress_type = zipfile.ZIP_DEFLATED
    z.writestr(zi2, note.encode('utf-8'))

print('  附件  %-32s %6.1f MB' % (os.path.basename(ff_zip), os.path.getsize(ff_zip)/1024/1024))
PYZIP

# ── 9. 清单 ──
echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✓ 精简包就绪"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  主包目录：$OUT"
find "$OUT" -type f -printf '    %10s  %P\n' | sort -k2
echo ""
echo "  主包：$(stat -c %s "$ZIP" 2>/dev/null | awk '{printf "%.1f MB", $1/1048576}')"
echo "  附件：$(stat -c %s "$FFZIP" 2>/dev/null | awk '{printf "%.1f MB", $1/1048576}')"
echo ""
echo "  发货策略："
echo "    · 先发主包（所有功能除站点视频外都能用）"
echo "    · 买家要站点视频时，再发 ffmpeg 附件包"
echo ""
