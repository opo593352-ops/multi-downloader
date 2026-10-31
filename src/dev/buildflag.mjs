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
