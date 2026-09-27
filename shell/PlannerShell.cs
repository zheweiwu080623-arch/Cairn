// PlannerShell —— 给 Codex Planner 用的最小桌面外壳
// 目标：独立窗口 + 托盘常驻 + 单实例 + 关窗销毁 WebView + 退出时收拾由它启动的 Node
// 编译：见同目录 build.cmd（用系统自带 csc.exe，无需安装 .NET SDK / Rust）
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class PlannerShell
{
    // 用可执行文件所在目录，而不是写死某台机器的路径
    static readonly string APP_DIR = AppContext.BaseDirectory.TrimEnd('\\');
    const string BASE_URL = "http://127.0.0.1:3210";
    const string MUTEX_NAME = @"Global\CodexPlannerShell_v1";
    const string NODE_EXE = @"C:\Program Files\nodejs\node.exe";

    static Mutex mutex;
    static NotifyIcon tray;
    static Form form;
    static WebView2 web;
    static Panel host;
    static Process nodeProc;
    static bool selfTest;
    static bool quitting;
    static string logPath;
    static System.Windows.Forms.Timer watchdog;
    static ToolStripMenuItem autoItem;
    static int watchFailCount;

    [STAThread]
    static void Main()
    {
        selfTest = Environment.GetEnvironmentVariable("PLANNER_SHELL_SELFTEST") == "1";
        logPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "host.log");
        Log("shell 启动（selfTest=" + selfTest + "）");

        bool createdNew;
        mutex = new Mutex(true, MUTEX_NAME, out createdNew);
        if (!createdNew)
        {
            Log("已有实例在运行，直接退出（单实例生效）");
            return;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        EnsureServer();
        BuildForm();
        BuildTray();
        StartWatchdog();

        if (selfTest) StartSelfTest();

        Application.Run(form);
        Log("shell 退出");
    }

    // ---------- 日志 ----------
    static void Log(string msg)
    {
        try
        {
            File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg + Environment.NewLine);
        }
        catch { }
    }

    // ---------- 后端连通性 ----------
    // 优先用轻量的 /api/health（1 KB 以内）；老版本服务没有这个接口时回退到 /api/state。
    static bool ServerUp()
    {
        if (Probe("/api/health")) return true;
        return Probe("/api/state");
    }

    static bool Probe(string path)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(BASE_URL + path);
            req.Timeout = 2500;
            req.Method = "GET";
            using (var resp = (HttpWebResponse)req.GetResponse())
                return resp.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    static void EnsureServer()
    {
        if (ServerUp()) { Log("后端已在运行，复用现有实例"); return; }
        StartNode();
    }

    // 拉起 node server.mjs，并等到 /api/health 可用（最多 10 秒）。
    static bool StartNode()
    {
        if (!File.Exists(NODE_EXE)) { Log("找不到 node.exe：" + NODE_EXE); return false; }
        try
        {
            var psi = new ProcessStartInfo(NODE_EXE, "server.mjs")
            {
                WorkingDirectory = APP_DIR,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            nodeProc = Process.Start(psi);
            Log("已启动 node，pid=" + (nodeProc != null ? nodeProc.Id.ToString() : "?"));
        }
        catch (Exception ex) { Log("启动 node 失败：" + ex.Message); return false; }

        for (int i = 0; i < 40; i++)
        {
            if (ServerUp()) { Log("后端就绪（等待 " + (i * 250) + "ms）"); return true; }
            Thread.Sleep(250);
        }
        Log("等待后端超时（10 秒）");
        return false;
    }

    // ---------- 看门狗：后台服务掉了就自动拉起来 ----------
    static void StartWatchdog()
    {
        watchdog = new System.Windows.Forms.Timer();
        watchdog.Interval = 20000; // 每 20 秒探活一次
        watchdog.Tick += delegate { WatchdogTick(); };
        watchdog.Start();
        Log("看门狗已启动（每 20 秒探活，连续 2 次失败即自动重启后端）");
    }

    static void WatchdogTick()
    {
        if (ServerUp()) { watchFailCount = 0; return; }
        watchFailCount++;
        Log("健康检查失败 " + watchFailCount + " 次（后端无响应）");
        if (watchFailCount < 2) return;
        watchFailCount = 0;
        Log("后台服务已掉线，开始自动重启");
        bool ok = StartNode();
        try
        {
            tray.ShowBalloonTip(6000, "Codex Planner · 后台服务",
                ok ? "后台服务曾中断，已自动重启（提醒与 Canvas 巡检恢复）" : "后台服务中断且自动重启失败，请查看 data/server.log",
                ok ? ToolTipIcon.Info : ToolTipIcon.Warning);
        }
        catch { }
    }

    // ---------- 窗口 ----------
    static void BuildForm()
    {
        form = new Form();
        form.Text = "空庭Coterie的Planner";
        form.Width = 1280;
        form.Height = 840;
        form.MinimumSize = new Size(900, 600);
        form.StartPosition = FormStartPosition.CenterScreen;
        try { form.Icon = new Icon(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app.ico")); } catch { }

        host = new Panel();
        host.Dock = DockStyle.Fill;
        form.Controls.Add(host);

        form.Load += async delegate { await InitWeb(); };
        form.FormClosing += OnFormClosing;
    }

    static async System.Threading.Tasks.Task InitWeb()
    {
        try
        {
            var userData = Path.Combine(APP_DIR, "data", "webview2");
            Directory.CreateDirectory(userData);
            var opts = new CoreWebView2EnvironmentOptions();
            if (Environment.GetEnvironmentVariable("PLANNER_SHELL_DEBUG_ARGS") == "1")
            {
                // 仅在 Codex 沙箱这类受限环境里需要（正常桌面环境不要开）
                opts.AdditionalBrowserArguments = "--no-sandbox --disable-gpu";
                Log("已启用调试参数: --no-sandbox --disable-gpu");
            }
            var env = await CoreWebView2Environment.CreateAsync(null, userData, opts);
            web = new WebView2();
            web.Dock = DockStyle.Fill;
            host.Controls.Add(web);
            await web.EnsureCoreWebView2Async(env);
            web.CoreWebView2.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs e)
            {
                string title = "";
                try { title = web.CoreWebView2.DocumentTitle; } catch { }
                Log("页面加载" + (e.IsSuccess ? "成功" : "失败") + "，标题=" + title);
            };
            web.CoreWebView2.ProcessFailed += delegate(object s, CoreWebView2ProcessFailedEventArgs e)
            {
                Log("WebView2 进程失败：" + e.ProcessFailedKind);
            };
            web.Source = new Uri(BASE_URL);
            Log("WebView2 初始化完成，开始导航");
        }
        catch (Exception ex)
        {
            Log("WebView2 初始化失败：" + ex.Message);
            MessageBox.Show(
                "界面初始化失败：\n" + ex.Message +
                "\n\n如果是首次运行，请确认已安装 WebView2 运行时；\n也可尝试设置环境变量 PLANNER_SHELL_DEBUG_ARGS=1 后重试。",
                "Planner 外壳", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    static void OnFormClosing(object sender, FormClosingEventArgs e)
    {
        if (quitting) return;
        // 关窗 = 销毁 WebView（让 WebView2 进程全部退出），程序缩回托盘
        e.Cancel = true;
        form.Hide();
        DisposeWeb();
        Log("窗口已隐藏，WebView 已销毁");
    }

    static void DisposeWeb()
    {
        try
        {
            if (web != null) { host.Controls.Remove(web); web.Dispose(); web = null; }
        }
        catch (Exception ex) { Log("销毁 WebView 出错：" + ex.Message); }
    }

    static void OpenPanel()
    {
        form.Show();
        if (form.WindowState == FormWindowState.Minimized) form.WindowState = FormWindowState.Normal;
        form.Activate();
        if (web == null) { var t = InitWeb(); }
    }

    // ---------- 托盘 ----------
    static void BuildTray()
    {
        tray = new NotifyIcon();
        try { tray.Icon = new Icon(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app.ico")); }
        catch { tray.Icon = SystemIcons.Application; }
        tray.Text = "Codex Planner（后台运行中 · 每 3 小时检查 Canvas）";

        var menu = new ContextMenuStrip();
        menu.Items.Add("打开面板", null, delegate { OpenPanel(); });
        menu.Items.Add("后台状态", null, delegate { ShowBgStatus(); });
        menu.Items.Add("立即检查 Canvas", null, delegate { CheckCanvasNow(); });
        menu.Items.Add("-");
        menu.Items.Add("重启后台服务", null, delegate { RestartServer(); });
        autoItem = new ToolStripMenuItem("开机自启：读取中…", null, delegate { ToggleAutostart(); });
        menu.Items.Add(autoItem);
        menu.Items.Add("-");
        menu.Items.Add("打开数据目录", null, delegate { OpenPath(APP_DIR); });
        menu.Items.Add("查看服务日志", null, delegate { OpenPath(Path.Combine(APP_DIR, "data", "server.log")); });
        menu.Items.Add("查看外壳日志", null, delegate { OpenPath(Path.Combine(APP_DIR, "shell", "dist", "host.log")); });
        menu.Items.Add("-");
        menu.Items.Add("退出 Planner（后台）", null, delegate { Quit(); });
        // 打开菜单时后台查询一次开机自启状态，避免网络卡住菜单
        menu.Opening += delegate { RefreshAutostartLabel(); };
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += delegate { OpenPanel(); };
        tray.Visible = true;
        tray.ShowBalloonTip(5000, "Codex Planner", "已在后台运行。右键托盘图标可退出。", ToolTipIcon.Info);
    }

    // ---------- 后台相关菜单动作 ----------
    static string ExtractNumber(string json, string key)
    {
        int i = json.IndexOf("\"" + key + "\":");
        if (i < 0) return "";
        int j = i + key.Length + 3;
        int k = j;
        while (k < json.Length && (char.IsDigit(json[k]) || json[k] == '-' || json[k] == '.')) k++;
        return json.Substring(j, k - j);
    }

    static string ExtractString(string json, string key)
    {
        int i = json.IndexOf("\"" + key + "\":\"");
        if (i < 0) return "";
        int j = i + key.Length + 4;
        int k = json.IndexOf('"', j);
        return k < 0 ? "" : json.Substring(j, k - j);
    }

    static string LocalTimeText(string iso)
    {
        try
        {
            if (string.IsNullOrEmpty(iso)) return "—";
            return DateTime.Parse(iso, null, System.Globalization.DateTimeStyles.RoundtripKind)
                .ToLocalTime().ToString("MM-dd HH:mm");
        }
        catch { return iso; }
    }

    static string FormatUptime(string seconds)
    {
        int s;
        if (!int.TryParse(seconds, out s) || s <= 0) return "刚刚启动";
        if (s < 3600) return (s / 60) + " 分钟";
        if (s < 86400) return (s / 3600) + " 小时 " + ((s % 3600) / 60) + " 分";
        return (s / 86400) + " 天 " + ((s % 86400) / 3600) + " 小时";
    }

    static bool AutostartEnabled()
    {
        string body = HttpGet("/api/autostart", 8000);
        return body.IndexOf("\"enabled\":true") >= 0;
    }

    static void RefreshAutostartLabel()
    {
        var t = new Thread(delegate()
        {
            try
            {
                bool on = AutostartEnabled();
                try { form.BeginInvoke(new Action(delegate { UpdateAutostartLabel(on); })); }
                catch { UpdateAutostartLabel(on); }
            }
            catch { }
        });
        t.IsBackground = true;
        t.Start();
    }

    static void UpdateAutostartLabel(bool on)
    {
        try
        {
            if (autoItem == null) return;
            autoItem.Text = on ? "开机自启：已开启（点击关闭）" : "开机自启：未开启（点击开启）";
        }
        catch { }
    }

    static void ShowBgStatus()
    {
        try
        {
            string body = HttpGet("/api/health", 10000);
            string pid = ExtractNumber(body, "pid");
            string up = ExtractNumber(body, "uptime_sec");
            string next = LocalTimeText(ExtractString(body, "next_run"));
            string last = LocalTimeText(ExtractString(body, "last_run"));
            string added = ExtractNumber(body, "added");
            string enabled = body.IndexOf("\"enabled\":true") >= 0 ? "开" : "关";
            string text = "服务：运行中（pid " + pid + "，已运行 " + FormatUptime(up) + "）\n"
                + "Canvas 巡检：" + enabled + " · 上次 " + last + " · 下次 " + next + "\n"
                + "上次新增：" + (string.IsNullOrEmpty(added) ? "0" : added) + " 条";
            tray.ShowBalloonTip(10000, "Codex Planner · 后台状态", text, ToolTipIcon.Info);
            Log("后台状态：" + text.Replace("\n", " / "));
        }
        catch (Exception ex)
        {
            tray.ShowBalloonTip(6000, "Codex Planner", "读取后台状态失败：" + ex.Message, ToolTipIcon.Warning);
        }
    }

    static void RestartServer()
    {
        try
        {
            int pid = 0;
            try { pid = int.Parse(ExtractNumber(HttpGet("/api/health", 8000), "pid")); }
            catch { }
            if (pid > 0)
            {
                try { Process.GetProcessById(pid).Kill(); Log("已结束后台 node，pid=" + pid); }
                catch (Exception ex) { Log("结束 node 失败：" + ex.Message); }
            }
            if (nodeProc != null) { try { nodeProc.Dispose(); } catch { } nodeProc = null; }
            Thread.Sleep(800);
            bool ok = StartNode();
            tray.ShowBalloonTip(6000, "Codex Planner · 后台服务",
                ok ? "后台服务已重启" : "后台服务重启失败，请查看 data/server.log",
                ok ? ToolTipIcon.Info : ToolTipIcon.Warning);
        }
        catch (Exception ex)
        {
            tray.ShowBalloonTip(6000, "Codex Planner", "重启失败：" + ex.Message, ToolTipIcon.Warning);
            Log("重启后台服务失败：" + ex.Message);
        }
    }

    static string PostJson(string path, string json)
    {
        var req = (HttpWebRequest)WebRequest.Create(BASE_URL + path);
        req.Method = "POST";
        req.ContentType = "application/json";
        req.Timeout = 15000;
        var bytes = System.Text.Encoding.UTF8.GetBytes(json);
        req.ContentLength = bytes.Length;
        using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
        using (var resp = (HttpWebResponse)req.GetResponse())
        using (var sr = new StreamReader(resp.GetResponseStream()))
            return sr.ReadToEnd();
    }

    static void ToggleAutostart()
    {
        try
        {
            bool cur = AutostartEnabled();
            string body = PostJson("/api/autostart", "{\"enabled\":" + (cur ? "false" : "true") + "}");
            bool now = body.IndexOf("\"enabled\":true") >= 0;
            UpdateAutostartLabel(now);
            bool ok = body.IndexOf("\"ok\":false") < 0;
            if (ok)
            {
                tray.ShowBalloonTip(7000, "Codex Planner · 开机自启",
                    now ? "已开启：下次开机自动在后台运行（不弹窗口）" : "已关闭：开机后不再自动运行",
                    ToolTipIcon.Info);
            }
            else
            {
                tray.ShowBalloonTip(8000, "Codex Planner · 开机自启", "设置失败：系统拒绝了写入「启动」文件夹", ToolTipIcon.Warning);
            }
            Log("开机自启 -> " + (now ? "开" : "关") + (ok ? "" : "（失败）"));
        }
        catch (Exception ex)
        {
            tray.ShowBalloonTip(6000, "Codex Planner", "切换开机自启失败：" + ex.Message, ToolTipIcon.Warning);
        }
    }

    static void OpenPath(string p)
    {
        try
        {
            if (File.Exists(p)) Process.Start("notepad.exe", "\"" + p + "\"");
            else Process.Start("explorer.exe", "\"" + p + "\"");
        }
        catch (Exception ex) { Log("打开路径失败：" + ex.Message); }
    }

    static string HttpGet(string path, int timeoutMs)
    {
        var req = (HttpWebRequest)WebRequest.Create(BASE_URL + path);
        req.Timeout = timeoutMs;
        using (var resp = (HttpWebResponse)req.GetResponse())
        using (var sr = new StreamReader(resp.GetResponseStream()))
            return sr.ReadToEnd();
    }

    static void CheckCanvasNow()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(BASE_URL + "/api/canvas-watch/run");
            req.Method = "POST";
            req.ContentLength = 0;
            req.Timeout = 90000;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream()))
            {
                string body = sr.ReadToEnd();
                string added = "?";
                int i = body.IndexOf("\"added\":");
                if (i >= 0)
                {
                    int j = i + 8, k = j;
                    while (k < body.Length && (char.IsDigit(body[k]) || body[k] == ' ')) k++;
                    added = body.Substring(j, k - j).Trim();
                }
                tray.ShowBalloonTip(6000, "Codex Planner · Canvas",
                    added == "0" ? "没有新的 Canvas 动态" : ("发现 " + added + " 条新动态，已加入通知"), ToolTipIcon.Info);
                Log("手动巡检完成，added=" + added);
            }
        }
        catch (Exception ex)
        {
            tray.ShowBalloonTip(6000, "Codex Planner", "检查失败：" + ex.Message, ToolTipIcon.Warning);
            Log("手动巡检失败：" + ex.Message);
        }
    }

    static void ShowWatchStatus()
    {
        try
        {
            string body = HttpGet("/api/canvas-watch", 10000);
            string txt = body.Length > 180 ? body.Substring(0, 180) + "…" : body;
            tray.ShowBalloonTip(8000, "Codex Planner · 巡检状态", txt, ToolTipIcon.Info);
            Log("巡检状态：" + txt);
        }
        catch (Exception ex)
        {
            tray.ShowBalloonTip(6000, "Codex Planner", "读取状态失败：" + ex.Message, ToolTipIcon.Warning);
        }
    }

    // ---------- 退出 ----------
    static void Quit()
    {
        quitting = true;
        if (nodeProc != null && !nodeProc.HasExited)
        {
            try { nodeProc.Kill(); Log("已结束由外壳启动的 node，pid=" + nodeProc.Id); }
            catch (Exception ex) { Log("结束 node 失败：" + ex.Message); }
        }
        else Log("node 不是由外壳启动的，保持不动");
        DisposeWeb();
        if (tray != null) { tray.Visible = false; tray.Dispose(); }
        Application.Exit();
    }

    // ---------- 自检模式（给自动化验证用，正常使用不会触发） ----------
    static void StartSelfTest()
    {
        var t = new System.Windows.Forms.Timer();
        t.Interval = 15000;
        t.Tick += delegate
        {
            t.Stop();
            string title = "";
            try { if (web != null && web.CoreWebView2 != null) title = web.CoreWebView2.DocumentTitle; } catch { }
            Log("SELFTEST 结果：title=" + title);
            Quit();
        };
        t.Start();
        Log("自检模式：15 秒后自动退出");
    }
}
