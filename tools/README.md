# 测试工具（tools/）

两个独立的不抢焦点测试工具。用系统自带 csc 编译，无需第三方库。

## 1. FocusProbe.cs — 焦点探针

判断某个程序启动时会不会抢走你的焦点。

```cmd
"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /target:exe /out:FocusProbe.exe FocusProbe.cs

:: 对照组：默认启动方式（会抢）
FocusProbe.exe "C:\path\to\下载器UI.exe"

:: 实验组：父进程声明 SW_SHOWNOACTIVATE（不抢）
FocusProbe.exe "C:\path\to\下载器UI.exe" noact
```

输出 `RESULT=NO_FOCUS_STOLEN` 表示全程 12 秒内前台窗口一次都没变。

## 2. NoFocusRunner.cs — 不抢焦点跑 UI 自检

用 `SW_SHOWNOACTIVATE` 拉起 `下载器UI.exe --selftest`，全程监控焦点，
并汇总结果。

```cmd
"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /target:exe /out:NoFocusRunner.exe NoFocusRunner.cs
NoFocusRunner.exe "C:\path\to\下载器UI.exe"
```

预期输出：

```
fg_at_start=[DSH Tauri]
--- case=zhihu exited=True elapsed=8s focusStolenSamples=0
    RESULT=PASS
    SEQUENCE=505ms:10% 1501ms:30% ... 8007ms:100%
--- case=music exited=True elapsed=4s focusStolenSamples=0
    RESULT=PASS
TOTAL_FOCUS_STOLEN_SAMPLES=0
FOCUS_TEST=PASS
```

## 为什么关键的逻辑在父进程

子进程内部无论怎么改（覆写 `ShowWithoutActivation`、调 `ShowWindow`、
事后最小化）都会抢焦点，因为激活行为发生在窗口创建时，由父进程的
`STARTUPINFO.wShowWindow` 决定。这一点用 FocusProbe 的对照组可以复现：

| 启动方式 | 焦点被抢采样数 |
|---|---|
| `Process.Start` 默认 | 39 / 39 |
| 子进程内 `--no-activate` | 39 / 39 |
| 父进程 `SW_SHOWNOACTIVATE` | **0 / 39** |
