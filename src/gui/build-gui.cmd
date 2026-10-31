@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

echo ═══════════════════════════════════════
echo   编译 抖音下载器UI.exe  (WinForms)
echo ═══════════════════════════════════════
echo.

if not exist "%CSC%" (
  echo [错误] 找不到 C# 编译器：
  echo        %CSC%
  echo        需要 .NET Framework 4.x（Windows 自带）
  goto end
)

echo [1/3] 编译中...
:: System.Net.Http 必须显式引用：音乐试听/下载用了 HttpClient，
:: 少这一行会报 CS0234「System.Net 中不存在 Http」。
"%CSC%" /target:winexe /out:DouyinUI.exe ^
  /reference:System.Windows.Forms.dll ^
  /reference:System.Drawing.dll ^
  /reference:System.Net.Http.dll ^
  /reference:System.Web.Extensions.dll ^
  /optimize+ /nologo Program.cs

if errorlevel 1 (
  echo [错误] 编译失败
  goto end
)

echo [2/3] 复制到 Downloads...
copy /Y "DouyinUI.exe" "%USERPROFILE%\Downloads\抖音下载器UI.exe" >nul

echo [3/3] 完成
for %%F in ("DouyinUI.exe") do echo   输出: %%~fF  ^(%%~zF 字节^)
echo.
echo 使用前提: 同目录（Downloads）里要有 抖音下载器.exe 作为引擎
echo.

:end
pause
endlocal
