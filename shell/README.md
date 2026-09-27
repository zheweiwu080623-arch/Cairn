# PlannerShell —— Codex Planner 的桌面外壳

> 建立于 2026-09-13。作用：把 Planner 从"Edge 浏览器窗口"换成**独立窗口 + 托盘常驻 + 单实例**的桌面应用形态。
> 依赖：**系统自带的 .NET Framework 4.8（含 `csc.exe`）+ 已安装的 WebView2 运行时**。不需要装 Rust、不需要 .NET SDK、不需要 npm 包。

## 文件

| 文件 | 说明 |
| --- | --- |
| `PlannerShell.cs` | 外壳全部源码（约 300 行） |
| `build.cmd` | 编译脚本（调用系统 `csc.exe`，产物输出到 `dist\`） |
| `sdk\` | WebView2 的 3 个 DLL（Core / WinForms / Loader） |
| `app.ico` | 窗口与托盘图标 |
| `dist\PlannerShell.exe` | **编译产物（16.5 KB）**，双击即用 |
| `dist\host.log` | 运行日志（排查问题看这个） |

## 怎么用

**启动**：双击 `dist\PlannerShell.exe`（或给它建个快捷方式）。

**托盘菜单**（右键右下角图标）：

| 菜单项 | 作用 |
| --- | --- |
| 打开面板 | 打开窗口（若已关闭则重建 WebView，约 0.6 秒） |
| 立即检查 Canvas | 手动触发一次巡检 |
| 查看巡检状态 | 气泡显示 `/api/canvas-watch` 的返回 |
| 打开数据目录 | 打开 Planner 目录 |
| 查看运行日志 | 打开 `data/tray.log` |
| **退出 Planner（后台）** | 结束外壳；**只结束由外壳启动的 node**，别人启的它不动 |

双击托盘图标 = 打开面板。

**行为**：
- **关窗（✕）≠ 退出**：窗口关闭时销毁 WebView（WebView2 进程全部退出，实测 0 个 / 0 MB），程序留在托盘。
- **单实例**：重复双击 exe 不会开出第二个窗口（命名互斥体），实测有效。
- **启动后端**：先探测 `http://127.0.0.1:3210/api/state`；已在运行就复用，不会重复拉起 node。

## 重新编译

```
双击 shell\build.cmd
```

## 已知限制 / 注意

1. **窗口打开时的内存偏高**：实测 7 个 WebView2 进程合计约 1060–1080 MB。主要嫌疑是 `public/assets/wallpapers/seq03.mp4`（61 MB）在持续解码；另外沙箱里为了绕过限制强制了软件渲染（`--disable-gpu`），也会放大内存。**真机不开调试参数时应该更低，但"给页面资产瘦身"仍是最值得做的一项优化。**
2. 调试参数：仅在受限环境需要。设置环境变量 `PLANNER_SHELL_DEBUG_ARGS=1` 才会加 `--no-sandbox --disable-gpu`；**默认不启用**。
3. 自检模式：`PLANNER_SHELL_SELFTEST=1` 时窗口打开 15 秒后自动退出并写日志，供自动化验证用。

## 回滚

外壳不动任何原有文件。要回到旧形态：

1. 托盘右键「退出 Planner（后台）」
2. 双击原来的 `start-tray.vbs`（或 `启动后台.cmd`）

备份在 `data\backups\pre-shell-2026-09-13\`（含 `server.mjs.bak` / `tray.ps1.bak` / `start-tray.vbs.bak` / `launcher.mjs.bak`）。
