#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# make-release.sh — 生成发布包（只含二进制 + 用户文档）
#
# 铁律：发布包内绝不出现任何源码、开发文档、卡密生成器。
# 每生成一次，脚本最后会做一次「污染扫描」，发现漏网直接报错。
#
# 用法：bash make-release.sh
# 产物：发布/统一下载器-v1.2.0/  +  统一下载器-v1.2.0.zip
# ═══════════════════════════════════════════════════════════

set -euo pipefail
cd "$(dirname "$0")"

VERSION="1.0.0"
NAME="统一下载器-v${VERSION}"
OUT="发布/${NAME}"
ZIP="发布/${NAME}.zip"

echo "═══════════════════════════════════════════════════"
echo "  生成发布包 ${NAME}"
echo "═══════════════════════════════════════════════════"

# ── 0. 前置检查 ──
for f in 下载器.exe 下载器UI.exe ffmpeg.exe 使用说明.txt 免责声明.md 常见问题.md; do
  if [ ! -f "$f" ]; then
    echo "✗ 缺少必需文件：$f"
    exit 1
  fi
done

echo "  引擎      $(stat -c %s 下载器.exe) 字节  $(stat -c %y 下载器.exe | cut -d. -f1)"
echo "  界面      $(stat -c %s 下载器UI.exe) 字节  $(stat -c %y 下载器UI.exe | cut -d. -f1)"
echo "  ffmpeg    $(stat -c %s ffmpeg.exe) 字节"

# ── 1. 清理旧包 ──
rm -rf "$OUT" "$ZIP"
mkdir -p "$OUT"

# ── 2. 复制二进制（只这三个） ──
cp 下载器.exe     "$OUT/"
cp 下载器UI.exe   "$OUT/"
cp ffmpeg.exe     "$OUT/"

# ── 3. 复制用户文档（只这四个） ──
cp 使用说明.txt   "$OUT/"
cp 常见问题.md    "$OUT/"
cp 免责声明.md    "$OUT/"

# ── 4. 建空目录，用户开箱即用 ──
mkdir -p "$OUT/downloads/视频"
mkdir -p "$OUT/downloads/音乐"
mkdir -p "$OUT/downloads/文章"
mkdir -p "$OUT/downloads/抓取"
mkdir -p "$OUT/logs"

# ── 5. 生成一份简短的「开始使用.txt」 ──
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

遇到问题？先看「常见问题.md」，95% 的答案都在里面。

注意：
  · 三个 exe 必须放在同一个文件夹
  · 请勿把本软件及其激活码转售、共享、二次分发
  · 下载内容仅供个人学习备份，版权归原作者

第一次打开请先读「免责声明.md」，运行即视为同意。
═══════════════════════════════════════════════════════
TXT

# ── 6. 污染扫描：任何源码/开发文档/生成器出现即报错 ──
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
  # shellcheck disable=SC2086
  found=$(find "$OUT" -name "$pat" -print 2>/dev/null || true)
  if [ -n "$found" ]; then
    echo "✗ 发现禁止内容（$pat）："
    echo "$found" | sed 's/^/    /'
    BAD=1
  fi
done

if [ "$BAD" -eq 1 ]; then
  echo ""
  echo "✗ 发布包被污染，已中止。请检查上面的文件。"
  rm -rf "$OUT"
  exit 1
fi
echo "✓ 无源码、无开发文档、无卡密生成器"

# ── 7. 校验 exe 能跑 ──
echo ""
echo "── 冒烟测试 ──"
VER="$("$OUT/下载器.exe" --version 2>&1 | head -1)"
echo "  下载器.exe --version → ${VER}"
case "$VER" in
  *"统一下载器"*) ;;
  *) echo "✗ 引擎无法运行"; exit 1 ;;
esac

# ── 8. 打包 zip（用 Python，强制 UTF-8 文件名标志位） ──
echo ""
echo "── 打包 ──"
NAME="$NAME" OUT="$OUT" ZIP="$ZIP" python - <<'PYZIP'
import zipfile, os, sys

src_dir = os.environ['OUT']
out_zip = os.environ['ZIP']

if not os.path.isdir(src_dir):
    print('  ! dir not found:', src_dir); sys.exit(1)
if os.path.exists(out_zip):
    os.remove(out_zip)

class Utf8ZipInfo(zipfile.ZipInfo):
    """强制把文件名按 UTF-8 写入并置 bit 11。
    Windows 资源管理器只有在看到这个标志时才按 UTF-8 解码中文名。"""
    def _encodeFilenameFlags(self):
        return self.filename.encode('utf-8'), self.flag_bits | 0x800

with zipfile.ZipFile(out_zip, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, dirs, files in os.walk(src_dir):
        rel_root = os.path.relpath(root, src_dir)
        base = '' if rel_root == '.' else rel_root.replace('\\', '/') + '/'
        if base:
            zi = Utf8ZipInfo(base)
            zi.external_attr = (0o40755 << 16) | 0x10
            z.writestr(zi, b'')
        for f in sorted(files):
            full = os.path.join(root, f)
            zi = Utf8ZipInfo(base + f, date_time=__import__('time').localtime(os.path.getmtime(full))[:6])
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = (0o100644 << 16)
            with open(full, 'rb') as fh:
                z.writestr(zi, fh.read())

print('  OK  %s  (%.1f MB)' % (os.path.basename(out_zip), os.path.getsize(out_zip)/1024/1024))
PYZIP

# ── 9. 清单 ──
echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✓ 发布包就绪"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  目录：$OUT"
find "$OUT" -type f -printf '    %10s  %P\n' | sort -k2
echo ""
echo "  总计：$(find "$OUT" -type f | wc -l) 个文件，$(du -sh "$OUT" | cut -f1)"
echo ""
