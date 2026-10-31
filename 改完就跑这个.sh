#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# 改完就跑这个.sh — 一键「检查依赖 → 构建 → 打包 → 自检」
#
# 为什么要有这个脚本：
#   以前改完源码只跑 build.sh，产物更新了但**发布包还是旧的**。
#   于是出现「明明修好了，发给测试者的包还是坏的那版」——
#   这类事故靠人记是记不住的，必须固化成一条命令。
#
# 做的事（顺序固定）：
#   0. 检查 ffmpeg / yt-dlp 在不在（缺了自动下载）
#   1. 从源码读版本号（不手写，避免和源码不一致）
#   2. bash build.sh        → 发布/bin/ 的 exe
#   3. make-test-ff.sh      → 单包（v1.2.0 开源后不再分 paid/free）
#   4. 把 exe + 依赖同步到 src/（方便源码目录直接双击跑）
#
# 用法：
#   bash 改完就跑这个.sh              # 用源码里的版本号
#   VER=1.2.1 bash 改完就跑这个.sh    # 显式指定版本
# ═══════════════════════════════════════════════════════════

set -euo pipefail
cd "$(dirname "$0")"

step() { echo ""; echo "══ $* ══"; }

# ── 1. 版本号 ──
detect_ver() {
  python - <<'PY' 2>/dev/null || echo "1.2.0"
import io, re
s = io.open('src/cli/cli.mjs', encoding='utf-8').read()
m = re.search(r":\s*'(\d+\.\d+\.\d+)'\s*;", s)
print(m.group(1) if m else '1.2.0')
PY
}
VER="${VER:-$(detect_ver)}"
export VER
export BETA_VER="${BETA_VER:-${VER}-beta1}"

echo "═══════════════════════════════════════════════════"
echo "  改完就跑 · 一键构建 + 打包"
echo "  版本: $VER   （内测 $BETA_VER）"
echo "═══════════════════════════════════════════════════"

START=$(date +%s)

# ── 0. 依赖检查 ──
# ffmpeg / yt-dlp 不在 git 里（106MB），新克隆的机器上可能缺。
# 缺了就自动下载，别让构建跑一半才发现站点视频不能用。
step "0/4 检查依赖（ffmpeg / yt-dlp）"
if ! node tools/取依赖.mjs; then
  echo ""
  echo "✗ 依赖没就绪，无法继续。"
  echo "  手动方案见 tools/取依赖.mjs 的输出提示。"
  exit 1
fi

# ── 2. 构建 ──
step "1/4 构建 exe"
bash build.sh

# ── 3. 打测试包 ──
step "2/4 打测试包"
bash make-test-ff.sh

# ── 4. 同步到 src/ ──
step "3/4 同步 exe 和依赖到 src/"
# ⚠ 这一步经常失败，而且原因很不直观：UI 窗口开着时 src\下载器UI.exe
#   会被进程锁住，cp 直接报 "being used by another process"。
#   旧写法在 `set -e` 下会**立刻退出**，导致后面的自检根本不跑 ——
#   你只会看到 exit=1，不知道是哪个文件、为什么。
#   现在逐个复制 + 失败给可操作提示，不让整个脚本静默死掉。
SYNC_FAIL=0
for f in 下载器.exe 下载器-beta.exe 下载器UI.exe ffmpeg.exe yt-dlp.exe; do
  if [ ! -f "发布/bin/$f" ]; then
    echo "  ✗ 源文件不存在：发布/bin/$f"
    SYNC_FAIL=1
    continue
  fi
  if cp "发布/bin/$f" "src/$f" 2>/dev/null; then
    echo "  src/$f"
  else
    echo "  ✗ src/$f 复制失败"
    case "$f" in
      下载器UI.exe)
        echo "     原因：UI 窗口可能还开着（文件被占用）"
        echo "     处理：关掉 下载器UI.exe 窗口，或执行"
        echo "           taskkill /IM 下载器UI.exe /F"
        ;;
      *)
        echo "     原因：该 exe 正在运行，或被杀软/索引服务占用"
        ;;
    esac
    SYNC_FAIL=1
  fi
done
if [ "$SYNC_FAIL" -eq 1 ]; then
  echo ""
  echo "  ⚠ 部分文件没同步到 src/ —— 不影响发布包，只影响源码目录调试。"
fi

# ── 5. 自检 ──
step "4/4 自检"

FAIL=0
chk() {
  local label="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    echo "  ✓ $label"
  else
    echo "  ✗ $label  （期望 $want，实际 $got）"
    FAIL=1
  fi
}

# 版本一致
V="$("发布/bin/下载器.exe" --version 2>&1 | head -1)"
chk "引擎版本 v$VER" "统一下载器 v$VER" "$V"

# 三个 exe 都在
for f in 下载器.exe 下载器-beta.exe 下载器UI.exe; do
  [ -f "发布/bin/$f" ] && echo "  ✓ $f" || { echo "  ✗ $f 缺失"; FAIL=1; }
done

# 依赖能跑
"发布/bin/ffmpeg.exe" -version >/dev/null 2>&1 \
  && echo "  ✓ ffmpeg 可运行" || { echo "  ✗ ffmpeg 跑不起来"; FAIL=1; }
YTV="$("发布/bin/yt-dlp.exe" --version 2>&1 | head -1)"
case "$YTV" in
  [0-9][0-9][0-9][0-9].*) echo "  ✓ yt-dlp $YTV" ;;
  *) echo "  ✗ yt-dlp 跑不起来"; FAIL=1 ;;
esac

# 开源版：未激活必须能跑（反向检查）
if TMPHOME="$(mktemp -d)" APPDATA="$(mktemp -d)" \
   "发布/bin/下载器.exe" music search "test" >/dev/null 2>&1; then
  echo "  ✓ 免激活可用（开源版预期）"
else
  echo "  ✗ 未激活跑不通 —— 检查 dev/gate.mjs 的 FREE_EDITION"
  FAIL=1
fi

# 包存在
ZIP=$(ls -1 发布/*v${VER}*.zip 2>/dev/null | head -1)
if [ -n "$ZIP" ]; then
  SZ=$(stat -c %s "$ZIP" | awk '{printf "%.1f MB", $1/1048576}')
  echo "  ✓ 发布包 $SZ"
else
  echo "  ✗ 没找到 v${VER} 的发布包"
  FAIL=1
fi

# ── 汇总 ──
END=$(date +%s)
echo ""
echo "═══════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  echo "  ✓ 全部通过（耗时 $((END - START)) 秒）"
  echo "═══════════════════════════════════════════════════"
  echo ""
  echo "  包：$ZIP"
  echo "  引擎：发布/bin/下载器.exe  ($V)"
  echo ""
  echo "  下一步：把 zip 发给测试者"
else
  echo "  ✗ 有检查项未通过（耗时 $((END - START)) 秒）"
  echo "═══════════════════════════════════════════════════"
  exit 1
fi
