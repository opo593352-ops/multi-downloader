#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# build.sh — 一键构建全部产物（v1.0.1 起）
#
# ── 目录约定（本次归类后）──
#   源码：src/cli  src/engines  src/dev  src/gui  src/tools  src/build
#   产物：发布/bin/            ← 所有 exe 都进这里，根目录不再散放
#
# ── 这次的改动 ──
#   1. BUILD_INTERNAL 不再是字符串替换
#      旧做法是 Python 去 cli.mjs 里 replace 一行带中文注释的代码：
#        "const BUILD_INTERNAL = false;   // ← build-internal.cmd 会替换成 true"
#      改个标点就匹配不上，而 `set -e` 只管退出码 —— 替换没命中会静默产出
#      一个「看着是内测版、其实带卡密闸门」的包。
#      现在直接覆写 src/dev/buildflag.mjs，构建结束用 trap 写回 false。
#   2. 闸门分散到 6 个引擎，所以 BUILD_INTERNAL 必须是**全局一份**，
#      否则内测版会被自己的引擎拦住（这就是必须提到 buildflag.mjs 的原因）。
#   3. 产物统一进 发布/bin/，根目录只留文档和脚本。
#
# 用法：bash build.sh                 （默认版本 1.0.1）
#       VER=1.0.0 bash build.sh       （覆盖版本号，产物同样进 发布/bin/）
#
# ⚠ 版本号覆盖只改产物，不改源码字面量 —— 用 sed 直接改源码再改回来，
#   中途失败就会留下错误版本号（和 BUILD_INTERNAL 是同一类事故）。
# ═══════════════════════════════════════════════════════════

set -euo pipefail
cd "$(dirname "$0")"

SIGNTOOL="/c/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64/signtool.exe"
CSC="/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
NODEEXE="/c/Program Files/nodejs/node.exe"
FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

OUT="发布/bin"
FLAG="src/dev/buildflag.mjs"
VER="${VER:-1.0.1}"          # 发行版版本号
BETA_VER="${BETA_VER:-${VER}-beta1}"

step() { echo ""; echo "── $* ──"; }

mkdir -p "$OUT"

echo "  版本: $VER   （内测版 $BETA_VER）"

# ── 收尾：无论成败都把 BUILD_INTERNAL 写回 false ──
# 不加这个 trap，一旦中途失败就会留下 BUILD_INTERNAL=true 的源码，
# 下一次打"正式版"直接产出免授权包 —— 这是最难发现的事故。
restore_flag() {
  cat > "$FLAG" <<'EOF'
/**
 * buildflag.mjs — 构建期开关（**唯一**的免授权开关）
 *
 * 为什么单独一个文件：
 *
 *   旧做法是 build.sh 用 Python 去 cli.mjs 里做字符串替换：
 *     "const BUILD_INTERNAL = false;   // ← build-internal.cmd 会替换成 true"
 *   这有两个毛病：
 *     1. 注释里含中文和箭头，改一个字就匹配不上，构建静默失败
 *        （build.sh 里 set -e 只管退出码，替换没命中不会报错）
 *     2. 闸门分散在 6 个引擎里，光改 cli.mjs 已经不够 ——
 *        必须让所有模块看到同一个值，否则内测版会被自己的闸门拦住
 *
 * 现在：构建脚本直接覆写本文件，esbuild --minify 会把
 * `BUILD_INTERNAL && x` 折叠成常量，发布版里连分支字节都不剩。
 *
 * ⚠ 发布构建结束时必须把它写回 false。build.sh 的 trap 会保证这点。
 */
export const BUILD_INTERNAL = false;
EOF
}
trap 'restore_flag' EXIT

# ── 0. 前置检查 ──
step "0. 环境检查"
for f in "$SIGNTOOL" "$CSC" "$NODEEXE"; do
  [ -e "$f" ] || { echo "✗ 缺少: $f"; exit 1; }
done
[ -d src/node_modules ] || { echo "! 安装依赖..."; (cd src && npm install --no-audit --no-fund esbuild postject); }
echo "  OK"

# ═══════════════════════════════════════════════════════════
# 1. 发行版引擎（BUILD_INTERNAL = false）
# ═══════════════════════════════════════════════════════════
step "1. 发行版引擎"
restore_flag
cd src
# 版本号用 esbuild --define 注入，不改源码字面量。
# 这样 VER=1.0.0 打出来的产物就是 v1.0.0，源码里仍是 1.0.1 —— 不会留下"改错的版本号"。
npx esbuild cli/cli.mjs --bundle --platform=node --format=cjs --target=node24 \
  --minify --define:__VER__="'$VER'" --outfile=build/all-bundle.raw.cjs
node dev/obfuscate.mjs build/all-bundle.raw.cjs build/all-bundle.cjs
node --experimental-sea-config sea-all.json
cd ..
cp "$NODEEXE" "$OUT/下载器.exe"
"$SIGNTOOL" remove //s "$OUT/下载器.exe" >/dev/null 2>&1 || true
npx --prefix src postject "$OUT/下载器.exe" NODE_SEA_BLOB src/build/all-blob.bin --sentinel-fuse "$FUSE" >/dev/null
echo "  下载器.exe  $(./"$OUT/下载器.exe" --version 2>&1 | head -1)"

# ═══════════════════════════════════════════════════════════
# 2. 内测版引擎（BUILD_INTERNAL = true）
# ═══════════════════════════════════════════════════════════
step "2. 内测版引擎"
cat > "$FLAG" <<'EOF'
/**
 * buildflag.mjs — 构建期开关（**唯一**的免授权开关）
 *
 * ⚠ 当前是**内测版构建**：BUILD_INTERNAL = true。
 *    这个文件由 build.sh 在构建内测版时覆写，构建结束会写回 false。
 *    如果不小心把它提交进发布构建，产物就是"免授权版"——绝不能发出去。
 */
export const BUILD_INTERNAL = true;
EOF

cd src
# 内测入口：只改版本号，逻辑完全一致（不再替换 BUILD_INTERNAL，那件事交给 buildflag.mjs）
# 这里同时把源码里的默认版本换成 VER，再用 esbuild 注入 -beta1 后缀。
BETA_VER="$BETA_VER" VER="$VER" python - <<'PY'
import io, os, re
s = io.open('cli/cli.mjs', encoding='utf-8').read()
ver = os.environ['VER']
beta = os.environ['BETA_VER']
# 版本号现在写成 `const VERSION = typeof __VER__ !== 'undefined' ? __VER__ : '1.0.1';`
# 内测入口直接去掉默认值、固定成 beta 版本 —— 比再插一层 define 更直观。
pat = re.compile(r"const VERSION = .*?;", re.S)
if not pat.search(s):
    raise SystemExit('FATAL: cli.mjs 里找不到 VERSION 定义，无法生成内测入口')
s = pat.sub("const VERSION = '%s';" % beta, s, count=1)
io.open('cli/cli-beta.mjs', 'w', encoding='utf-8').write(s)
print("  cli-beta.mjs 已生成（版本号 %s）" % beta)
PY
npx esbuild cli/cli-beta.mjs --bundle --platform=node --format=cjs --target=node24 \
  --minify --outfile=build/beta-bundle.raw.cjs
node dev/obfuscate.mjs build/beta-bundle.raw.cjs build/beta-bundle.cjs
node --experimental-sea-config sea-beta.json
cd ..
cp "$NODEEXE" "$OUT/下载器-beta.exe"
"$SIGNTOOL" remove //s "$OUT/下载器-beta.exe" >/dev/null 2>&1 || true
npx --prefix src postject "$OUT/下载器-beta.exe" NODE_SEA_BLOB src/build/beta-blob.bin --sentinel-fuse "$FUSE" >/dev/null
echo "  下载器-beta.exe  $(./"$OUT/下载器-beta.exe" --version 2>&1 | head -1)"

# 内测版造完立刻把开关写回 false，避免后面几步被污染
restore_flag

# ═══════════════════════════════════════════════════════════
# 3. 界面
# ═══════════════════════════════════════════════════════════
step "3. 界面"
cd src/gui
# 版本号写进一个生成文件一起编译 —— csc 的 /define 只吃标识符，塞不进字符串。
# 这样换版本只改 build.sh 里的 VER，不用满 Program.cs 找 "v1.0.1"。
cat > _version.gen.cs <<EOF
// 自动生成，勿手改（build.sh 每次构建覆写）
static class AppBuild
{
    public const string Version = "v${VER}";
    public const string VersionBeta = "v${BETA_VER}";
}
EOF
# donate.png 是打赏收款码，必须作为嵌入资源打进去 ——
# 放外部文件的话用户删了/搬走了，菜单里的「支持作者」就是空白。
"$CSC" -target:winexe -out:DouyinUI.exe \
  -resource:donate.png,donate.png \
  -reference:System.Windows.Forms.dll -reference:System.Drawing.dll \
  -reference:System.Net.Http.dll -reference:System.Web.Extensions.dll \
  -optimize+ -nologo Program.cs _version.gen.cs
"$CSC" -target:winexe -out:DouyinUI-beta.exe -define:INTERNAL_BUILD \
  -resource:donate.png,donate.png \
  -reference:System.Windows.Forms.dll -reference:System.Drawing.dll \
  -reference:System.Net.Http.dll -reference:System.Web.Extensions.dll \
  -optimize+ -nologo Program.cs _version.gen.cs
cd ../..
cp src/gui/DouyinUI.exe "$OUT/下载器UI.exe"
echo "  下载器UI.exe  $(stat -c %s "$OUT/下载器UI.exe") 字节  (v${VER})"

# ═══════════════════════════════════════════════════════════
# 4. 卡密生成器
# ═══════════════════════════════════════════════════════════
step "4. 卡密生成器"
cd src
npx esbuild dev/keygen.mjs --bundle --platform=node --format=cjs --target=node24 \
  --minify --outfile=build/keygen-bundle.raw.cjs
# 卡密生成器虽然是内部工具，但一样要过混淆 ——
# 它里面含镜像域名和资源派生前缀（res|v1|），两者都是"看一眼就能抄"的方案泄漏。
node dev/obfuscate.mjs build/keygen-bundle.raw.cjs build/keygen-bundle.cjs
node --experimental-sea-config keygen-sea.json
cd ..
cp "$NODEEXE" "$OUT/卡密生成器.exe"
"$SIGNTOOL" remove //s "$OUT/卡密生成器.exe" >/dev/null 2>&1 || true
npx --prefix src postject "$OUT/卡密生成器.exe" NODE_SEA_BLOB src/build/keygen-blob.bin --sentinel-fuse "$FUSE" >/dev/null
cp "$OUT/卡密生成器.exe" 内部工具/卡密生成器.exe
echo "  卡密生成器.exe  $(./"$OUT/卡密生成器.exe" --tiers 2>&1 | grep -c '卡')  档位"

# ═══════════════════════════════════════════════════════════
# 5. 汇总
# ═══════════════════════════════════════════════════════════
step "5. 产物"
printf "  %-24s %12s  %s\n" "文件" "大小" "时间"
for f in 下载器.exe 下载器-beta.exe 下载器UI.exe 卡密生成器.exe; do
  printf "  %-24s %12s  %s\n" "$f" "$(stat -c %s "$OUT/$f")" "$(stat -c %y "$OUT/$f" | cut -d. -f1)"
done
echo ""
echo "  下一步："
echo "    bash make-release-lite.sh    打发行包（带卡密）"
echo "    bash make-beta.sh            打内测包（免授权）"
echo ""
