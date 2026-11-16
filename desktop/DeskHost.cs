using System;
using System.Drawing;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// Desktop-layer host: WinForms + WebView2, pinned below all windows and above desktop icons
class DeskHost : Form
{
    // ── Win32 ──────────────────────────────────────────────
    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string name);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr h, int idx, IntPtr v);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);

    [StructLayout(LayoutKind.Sequential)]
    struct WINDOWPOS
    {
        public IntPtr hwnd;
        public IntPtr hwndInsertAfter;
        public int x, y, cx, cy;
        public uint flags;
    }

    const int GWL_HWNDPARENT = -8;
    const int GWL_EXSTYLE = -20;
    const uint WS_EX_TOOLWINDOW = 0x00000080;
    const uint WS_EX_LAYERED = 0x00080000;
    const uint LWA_ALPHA = 0x00000002;
    const uint WS_EX_APPWINDOW = 0x00040000;
    const uint WS_EX_NOACTIVATE = 0x08000000;

    static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
    const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010;

    const int WM_WINDOWPOSCHANGING = 0x0046;
    const int WM_NCHITTEST = 0x0084;
    const int HTCLIENT = 1, HTCAPTION = 2;
    const int HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13, HTTOPRIGHT = 14;
    const int HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;

    // ── 状态 ───────────────────────────────────────────────
    WebView2 web;
    NotifyIcon tray;
    XueqiuWindow xq;          // 雪球独立窗口（懒加载）
    string startUrl;
    bool allowActivate = true;    // 默认允许激活，否则收不到键盘输入
    IntPtr defViewHandle = IntPtr.Zero;
    bool isEditing = false;      // 页面进入编辑模式后，边缘热区放大
    byte curAlpha = 232;          // 0-255，整层不透明度
    int curHeightPct = 100;       // Height as a percentage of the target screen's working area
    string curScreenDevice = "";  // 目标显示器 DeviceName，空 = 主屏
    Dictionary<string, string> cfg = new Dictionary<string, string>();
    string cfgPath = "";

    public DeskHost(string url)
    {
        startUrl = url;

        // 应用图标（编译时以 /resource 嵌入的 app.ico）
        try
        {
            System.IO.Stream icoStream = System.Reflection.Assembly.GetExecutingAssembly()
                .GetManifestResourceStream("app.ico");
            if (icoStream != null) this.Icon = new Icon(icoStream);
        }
        catch (Exception ex) { Log("icon load failed: " + ex.Message); }

        Text = "Daddy's DeskStick";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Bounds = new Rectangle(0, 0, 800, 600);   // 真正位置在 ApplyHeight 里定
        ShowInTaskbar = false;
        AutoScaleMode = AutoScaleMode.None;
        BackColor = Color.FromArgb(10, 13, 19);
        DoubleBuffered = true;

        web = new WebView2();
        web.Dock = DockStyle.Fill;
        web.DefaultBackgroundColor = Color.FromArgb(10, 13, 19);
        Controls.Add(web);

        tray = new NotifyIcon();
        tray.Icon = (this.Icon != null) ? this.Icon : SystemIcons.Application;
        tray.Text = "Daddy's DeskStick";
        tray.Visible = true;

        cfgPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "host.json");
        LoadCfg();
        if (cfg.ContainsKey("screen")) curScreenDevice = cfg["screen"];
        curAlpha = (byte)LoadAlpha();
        curHeightPct = LoadInt("height", 100);
        if (curHeightPct < 50) curHeightPct = 50;
        if (curHeightPct > 100) curHeightPct = 100;

        ContextMenuStrip menu = new ContextMenuStrip();
        // 「显示器」永远在菜单里：单屏机器也保留，避免枚举出岔子时整个选项消失。
        // 子项在每次展开时重建，插拔显示器后不用重启就能看到最新的。
        ToolStripMenuItem scMenu = new ToolStripMenuItem("显示器");
        scMenu.DropDownOpening += delegate
        {
            scMenu.DropDownItems.Clear();
            Screen[] screens = Screen.AllScreens;

            if (screens == null || screens.Length == 0)
            {
                ToolStripMenuItem none = new ToolStripMenuItem("（未检测到屏幕）");
                none.Enabled = false;
                scMenu.DropDownItems.Add(none);
                return;
            }

            // 单屏时也给一句说明，免得以为功能坏了
            if (screens.Length == 1)
            {
                ToolStripMenuItem tip = new ToolStripMenuItem("当前只有一块屏幕");
                tip.Enabled = false;
                scMenu.DropDownItems.Add(tip);
                scMenu.DropDownItems.Add(new ToolStripSeparator());
            }

            foreach (Screen sc in screens)
            {
                Screen target = sc;
                string label = (sc.Primary ? "主屏" : "副屏")
                    + "  " + sc.Bounds.Width + "x" + sc.Bounds.Height;
                ToolStripMenuItem mi = new ToolStripMenuItem(label);
                mi.Tag = sc.DeviceName;
                mi.Checked = string.IsNullOrEmpty(curScreenDevice)
                    ? sc.Primary
                    : (sc.DeviceName == curScreenDevice);
                mi.Click += delegate
                {
                    curScreenDevice = target.DeviceName;
                    cfg["screen"] = target.DeviceName;
                    SaveCfg();
                    ApplyHeight();
                    Log("screen -> " + target.DeviceName);
                };
                scMenu.DropDownItems.Add(mi);
            }

            // 兜底：配置里记的那块屏已经不在了
            if (!string.IsNullOrEmpty(curScreenDevice))
            {
                bool found = false;
                foreach (Screen sc in screens)
                {
                    if (sc.DeviceName == curScreenDevice) { found = true; break; }
                }
                if (!found)
                {
                    scMenu.DropDownItems.Add(new ToolStripSeparator());
                    ToolStripMenuItem warn = new ToolStripMenuItem("原屏幕已断开，已回退主屏");
                    warn.Enabled = false;
                    scMenu.DropDownItems.Add(warn);
                }
            }
        };
        menu.Items.Add(scMenu);

        ToolStripMenuItem hMenu = new ToolStripMenuItem("桌贴高度");
        int[] heights = new int[] { 100, 94, 88, 82, 76 };
        foreach (int hp in heights)
        {
            int hv = hp;
            ToolStripMenuItem hmi = new ToolStripMenuItem(hp + "%");
            hmi.Click += delegate { SetHeightPercent(hv); };
            hMenu.DropDownItems.Add(hmi);
        }
        hMenu.DropDownOpening += delegate
        {
            hMenu.Text = "桌贴高度  " + curHeightPct + "%";
        };
        menu.Items.Add(hMenu);

        ToolStripMenuItem opMenu = new ToolStripMenuItem("不透明度");
        ToolStripMenuItem opLess = new ToolStripMenuItem("更透明   -5%");
        opLess.Click += delegate { SetAlpha((byte)Math.Max(40, (int)curAlpha - 13)); };
        ToolStripMenuItem opMore = new ToolStripMenuItem("更不透明   +5%");
        opMore.Click += delegate { SetAlpha((byte)Math.Min(255, (int)curAlpha + 13)); };
        opMenu.DropDownItems.Add(opLess);
        opMenu.DropDownItems.Add(opMore);
        opMenu.DropDownItems.Add(new ToolStripSeparator());
        opMenu.DropDownOpening += delegate
        {
            opMenu.Text = "不透明度  " + Math.Round(curAlpha * 100.0 / 255) + "%";
        };
        int[] levels = new int[] { 100, 92, 84, 76, 68, 60, 50, 40 };
        foreach (int lv in levels)
        {
            int v = lv;
            ToolStripMenuItem mi = new ToolStripMenuItem(lv.ToString() + "%");
            mi.Click += delegate { SetAlpha((byte)Math.Round(v * 255.0 / 100.0)); };
            opMenu.DropDownItems.Add(mi);
        }
        menu.Items.Add(opMenu);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("雪球", null, delegate { OpenXueqiu(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("重新加载", null, delegate { if (web.CoreWebView2 != null) web.CoreWebView2.Reload(); });
        menu.Items.Add("打开设置面板", null, delegate
        {
            if (web.CoreWebView2 != null)
                web.CoreWebView2.ExecuteScriptAsync("window.__wsOpenSettings && window.__wsOpenSettings()");
        });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, delegate { tray.Visible = false; Close(); });
        tray.ContextMenuStrip = menu;
    }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= (int)WS_EX_TOOLWINDOW;   // 不进 Alt-Tab
            cp.ExStyle &= ~(int)WS_EX_APPWINDOW;
            if (!allowActivate) cp.ExStyle |= (int)WS_EX_NOACTIVATE;
            return cp;
        }
    }

    // 核心：拦下一切 z-order 变化，强制压到最底
    protected override void WndProc(ref Message m)
    {
        // 边缘 6px 内返回 resize 热区，让系统处理拖拽改尺寸
        if (m.Msg == WM_NCHITTEST)
        {
            base.WndProc(ref m);
            if ((int)m.Result == HTCLIENT)
            {
                int lp = m.LParam.ToInt32();
                int sxp = (short)(lp & 0xFFFF);
                int syp = (short)((lp >> 16) & 0xFFFF);
                Point cp = PointToClient(new Point(sxp, syp));
                // 编辑态关闭原生边缘热区：四角手柄由页面绘制、经 postMessage 驱动，
                // 原生热区同时存在会与页面拖拽互相抢，窗口尺寸被两边反复改写
                int b = isEditing ? 0 : 6;
                int w = ClientSize.Width, h = ClientSize.Height;
                if (b > 0)
                {
                bool left = cp.X <= b, right = cp.X >= w - b;
                bool top = cp.Y <= b, bottom = cp.Y >= h - b;

                if (top && left) { m.Result = (IntPtr)HTTOPLEFT; return; }
                if (top && right) { m.Result = (IntPtr)HTTOPRIGHT; return; }
                if (bottom && left) { m.Result = (IntPtr)HTBOTTOMLEFT; return; }
                if (bottom && right) { m.Result = (IntPtr)HTBOTTOMRIGHT; return; }
                if (top) { m.Result = (IntPtr)HTTOP; return; }
                if (bottom) { m.Result = (IntPtr)HTBOTTOM; return; }
                if (left) { m.Result = (IntPtr)HTLEFT; return; }
                if (right) { m.Result = (IntPtr)HTRIGHT; return; }
                }
            }
            return;
        }

        if (m.Msg == WM_WINDOWPOSCHANGING)
        {
            WINDOWPOS wp = (WINDOWPOS)Marshal.PtrToStructure(m.LParam, typeof(WINDOWPOS));
            // 压到「桌面图标宿主之上、所有普通窗口之下」这一格
            wp.hwndInsertAfter = defViewHandle != IntPtr.Zero ? defViewHandle : HWND_BOTTOM;
            Marshal.StructureToPtr(wp, m.LParam, false);
        }
        base.WndProc(ref m);
    }

    static IntPtr FindDefView()
    {
        IntPtr progman = FindWindow("Progman", null);
        if (progman != IntPtr.Zero)
        {
            IntPtr dv = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (dv != IntPtr.Zero) return dv;
        }
        IntPtr w = IntPtr.Zero;
        while (true)
        {
            w = FindWindowEx(IntPtr.Zero, w, "WorkerW", null);
            if (w == IntPtr.Zero) break;
            IntPtr dv = FindWindowEx(w, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (dv != IntPtr.Zero) return dv;
        }
        return IntPtr.Zero;
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);

        // 1) owner = 桌面图标宿主 → Win+D 不会被收走
        IntPtr dv = FindDefView();
        defViewHandle = dv;
        if (dv != IntPtr.Zero) SetWindowLongPtr(Handle, GWL_HWNDPARENT, dv);
        Log("DefView = 0x" + dv.ToInt64().ToString("X") + "  handle=0x" + Handle.ToInt64().ToString("X"));

        // 2) 插到图标宿主正上方（不是 HWND_BOTTOM，那会沉到壁纸下面）
        SetWindowPos(Handle, dv != IntPtr.Zero ? dv : HWND_BOTTOM, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER);
        SetWindowPos(Handle, dv != IntPtr.Zero ? dv : HWND_BOTTOM, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);

        // 2.4) 高度
        ApplyHeight();

        // 2.5) 整层不透明度
        SetAlpha(curAlpha);

        // 3) 起 WebView2
        try
        {
            string dataDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "wv2data");
            Directory.CreateDirectory(dataDir);
            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, dataDir, null);
            await web.EnsureCoreWebView2Async(env);
            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            web.CoreWebView2.WebMessageReceived += OnWebMessage;
            web.CoreWebView2.Navigate(startUrl);
            Log("WebView2 ready");


        }
        catch (Exception ex)
        {
            MessageBox.Show("WebView2 初始化失败：\n" + ex.Message, "工作台");
            Close();
        }
    }

    static void Log(string msg)
    {
        try
        {
            string lp = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "host.log");
            File.AppendAllText(lp, DateTime.Now.ToString("HH:mm:ss") + "  " + msg + Environment.NewLine);
        }
        catch { }
    }

    void LoadCfg()
    {
        try
        {
            if (!File.Exists(cfgPath)) return;
            foreach (string line in File.ReadAllLines(cfgPath))
            {
                int i = line.IndexOf('=');
                if (i > 0)
                {
                    string k = line.Substring(0, i).Trim();
                    string v = line.Substring(i + 1).Trim();
                    if (k.Length > 0) cfg[k] = v;
                }
            }
        }
        catch { }
    }

    void SaveCfg()
    {
        try
        {
            StringBuilder sb = new StringBuilder();
            foreach (KeyValuePair<string, string> kv in cfg)
                sb.AppendLine(kv.Key + "=" + kv.Value);
            File.WriteAllText(cfgPath, sb.ToString());
        }
        catch { }
    }

    Screen CurrentScreen()
    {
        if (!string.IsNullOrEmpty(curScreenDevice))
        {
            foreach (Screen s in Screen.AllScreens)
                if (s.DeviceName == curScreenDevice) return s;
        }
        return Screen.PrimaryScreen;
    }

    void ApplyHeight()
    {
        Rectangle wa = CurrentScreen().WorkingArea;
        int h = (int)Math.Round(wa.Height * curHeightPct / 100.0);
        SetWindowPos(Handle, IntPtr.Zero, wa.X, wa.Y, wa.Width, h,
            SWP_NOZORDER | SWP_NOACTIVATE);
        Log("height=" + curHeightPct + "% -> " + wa.Width + "x" + h);
    }

    void SetHeightPercent(int pct)
    {
        curHeightPct = pct;
        ApplyHeight();
        SaveInt("height", pct);
    }


    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    static string JsonStr(string json, string key)
    {
        int i = json.IndexOf("\"" + key + "\":\"");
        if (i < 0) return "";
        i += key.Length + 4;
        int j = json.IndexOf('"', i);
        if (j < 0) return "";
        return json.Substring(i, j - i);
    }

    Rectangle resizeStartRect;      // 拖角开始的窗口 rect（屏幕坐标）
    string resizeDir = "";

    static int JsonInt(string json, string key)
    {
        int i = json.IndexOf("\"" + key + "\":");
        if (i < 0) return -1;
        i += key.Length + 3;
        int j = i;
        if (j < json.Length && json[j] == '-') j++;
        while (j < json.Length && char.IsDigit(json[j])) j++;
        int v;
        if (int.TryParse(json.Substring(i, j - i), out v)) return v;
        return -1;
    }

    void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string json = "";
        try { json = e.WebMessageAsJson; } catch { return; }
        if (json == null) return;

        if (json.IndexOf("\"xueqiuOpen\"") >= 0)
        {
            OpenXueqiu();
            return;
        }

        if (json.IndexOf("\"xueqiuClickTab\"") >= 0)
        {
            string tName = JsonStr(json, "tab");
            string tReqId = JsonStr(json, "reqId");
            if (xq == null || xq.IsDisposed || !xq.IsReady) { PostNoWindow(tReqId); return; }
            Log("[xq] 切 tab=" + tName);
            xq.ClickTabAndGrab(tName, tReqId);
            return;
        }

        if (json.IndexOf("\"xueqiuGrab\"") >= 0)
        {
            string gReqId = JsonStr(json, "reqId");
            if (xq == null || xq.IsDisposed || !xq.IsReady)
            {
                PostNoWindow(gReqId);
                return;
            }
            Log("[xq] 抓关注流 reqId=" + gReqId);
            xq.StartGrabTimeline(gReqId, 30);
            return;
        }

        if (json.IndexOf("\"xueqiuFetch\"") >= 0)
        {
            string xpath = JsonStr(json, "path");
            string reqId = JsonStr(json, "reqId");
            HandleXueqiuFetch(xpath, reqId);
            return;
        }

        if (json.IndexOf("\"editing\"") >= 0)
        {
            isEditing = json.IndexOf("true") > 0;
            Log("editing=" + isEditing);
            return;
        }

        if (json.IndexOf("\"resizeStart\"") >= 0)
        {
            RECT r;
            GetWindowRect(Handle, out r);
            resizeStartRect = new Rectangle(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
            resizeDir = JsonStr(json, "dir");
            Log("resizeStart dir=" + resizeDir + " " + resizeStartRect);
            return;
        }

        if (json.IndexOf("\"resizeMove\"") >= 0)
        {
            int dx = JsonInt(json, "dx"), dy = JsonInt(json, "dy");
            if (resizeStartRect.Width <= 0) return;

            const int MINW = 760, MINH = 480;
            Rectangle wa = CurrentScreen().WorkingArea;
            int x = resizeStartRect.X, y = resizeStartRect.Y;
            int w = resizeStartRect.Width, h = resizeStartRect.Height;

            if (resizeDir.IndexOf('w') >= 0)
            {
                int nx = Math.Min(resizeStartRect.X + dx, resizeStartRect.Right - MINW);
                if (nx < wa.Left) nx = wa.Left;
                x = nx; w = resizeStartRect.Right - nx;
            }
            if (resizeDir.IndexOf('e') >= 0)
            {
                w = Math.Max(MINW, Math.Min(resizeStartRect.Width + dx, wa.Right - resizeStartRect.X));
            }
            if (resizeDir.IndexOf('n') >= 0)
            {
                int ny = Math.Min(resizeStartRect.Y + dy, resizeStartRect.Bottom - MINH);
                if (ny < wa.Top) ny = wa.Top;
                y = ny; h = resizeStartRect.Bottom - ny;
            }
            if (resizeDir.IndexOf('s') >= 0)
            {
                h = Math.Max(MINH, Math.Min(resizeStartRect.Height + dy, wa.Bottom - resizeStartRect.Y));
            }

            SetWindowPos(Handle, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
            return;
        }

        if (json.IndexOf("\"resize\"") >= 0)
        {
            int w = JsonInt(json, "w");
            int h = JsonInt(json, "h");
            if (w < 600) w = 600;
            if (h < 400) h = 400;
            Rectangle wa = CurrentScreen().WorkingArea;
            if (w > wa.Width) w = wa.Width;
            if (h > wa.Height) h = wa.Height;
            SetWindowPos(Handle, IntPtr.Zero, 0, 0, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
        }
    }

    void SetAlpha(byte a)
    {
        curAlpha = a;
        try
        {
            if (Handle == IntPtr.Zero) { Log("alpha: handle is zero"); return; }
            long ex = GetWindowLongPtr(Handle, GWL_EXSTYLE).ToInt64();
            if ((ex & (long)WS_EX_LAYERED) == 0)
            {
                SetWindowLongPtr(Handle, GWL_EXSTYLE, new IntPtr(ex | (long)WS_EX_LAYERED));
                ex = GetWindowLongPtr(Handle, GWL_EXSTYLE).ToInt64();
            }
            bool ok = SetLayeredWindowAttributes(Handle, 0, a, LWA_ALPHA);
            Log("alpha=" + a + " ex=0x" + ex.ToString("X") + " ok=" + ok + " err=" + Marshal.GetLastWin32Error());
        }
        catch (Exception e) { Log("alpha exception: " + e.Message); }
        SaveAlpha(a);
    }

    int LoadAlpha()
    {
        string v;
        if (cfg.TryGetValue("alpha", out v))
        {
            int n;
            if (int.TryParse(v, out n) && n >= 60 && n <= 255) return n;
        }
        return 232;
    }

    void SaveAlpha(byte a)
    {
        cfg["alpha"] = a.ToString();
        SaveCfg();
    }

    // ── 雪球窗口 ─────────────────────────────────────────

    void OpenXueqiu()
    {
        if (xq != null && !xq.IsDisposed)
        {
            if (xq.WindowState == FormWindowState.Minimized) xq.WindowState = FormWindowState.Normal;
            xq.Show();
            xq.Activate();
            Log("[xq] 已存在，聚焦 (ready=" + xq.IsReady + ")");
            return;
        }

        if (xq != null) { try { xq.Dispose(); } catch { } }
        xq = new XueqiuWindow();
        xq.LogLine += delegate (string m) { Log("[xq] " + m); };
        xq.DataFromPage += delegate (string raw)
        {
            // raw 形如 {"type":"xqResult","reqId":"...","ok":true,"status":200,"body":"..."}
            Log("[xq] 收到数据 " + (raw.Length > 3000 ? raw.Substring(0, 3000) + "…" : raw));
            PostToPage(raw);
        };
        xq.FormClosed += delegate
        {
            Log("[xq] 窗口已关闭");
        };
        xq.Show();
        var t = xq.InitAsync();
        Log("[xq] 新建窗口");

    }

    /// <summary>
    /// 卡片请求数据：转给雪球窗口，在页面里 fetch，结果回投给主页面。
    /// 没有任何定时器 —— 每次都是用户点刷新触发的独立请求。
    /// </summary>
    void HandleXueqiuFetch(string apiPath, string reqId)
    {
        if (reqId == null) reqId = "";

        string state = (xq == null) ? "null"
            : (xq.IsDisposed ? "disposed"
            : (xq.IsReady ? "ready" : "not-ready"));
        Log("[xq] fetch path=" + apiPath + " state=" + state);

        if (string.IsNullOrEmpty(apiPath) || !IsAllowedXqUrl(apiPath))
        {
            PostToPage("{\"type\":\"xueqiuData\",\"reqId\":\"" + reqId
                + "\",\"ok\":false,\"error\":\"path 非法\"}");
            return;
        }

        if (xq == null || xq.IsDisposed)
        {
            PostNoWindow(reqId);
            return;
        }

        // 窗口还活着但 WebView2 没就绪（可能刚打开正在初始化），等两秒再试一次
        if (!xq.IsReady)
        {
            System.Windows.Forms.Timer t2 = new System.Windows.Forms.Timer();
            t2.Interval = 2000;
            t2.Tick += delegate
            {
                t2.Stop();
                t2.Dispose();
                if (xq != null && !xq.IsDisposed && xq.IsReady) DoXueqiuFetch(apiPath, reqId);
                else PostNoWindow(reqId);
            };
            t2.Start();
            return;
        }

        DoXueqiuFetch(apiPath, reqId);
    }

    /// <summary>只允许雪球自己的域名，避免被当成任意 URL 代理</summary>
    static bool IsAllowedXqUrl(string u)
    {
        if (u.StartsWith("/")) return true;
        if (!u.StartsWith("https://")) return false;
        return u.StartsWith("https://stock.xueqiu.com/")
            || u.StartsWith("https://xueqiu.com/")
            || u.StartsWith("https://www.xueqiu.com/")
            || u.StartsWith("https://danjuanapp.com/");
    }

    void PostNoWindow(string reqId)
    {
        PostToPage("{\"type\":\"xueqiuData\",\"reqId\":\"" + reqId
            + "\",\"ok\":false,\"needOpen\":true,\"error\":\"雪球窗口还没打开\"}");
    }

    void DoXueqiuFetch(string apiPath, string reqId)
    {
        if (reqId == null) reqId = "";
        Log("[xq] 开始请求 " + apiPath + " reqId=" + reqId);
        // 结果不在返回值里，走 xq.DataFromPage 事件回传（见 OpenXueqiu 里的挂接）
        xq.StartFetch(apiPath, reqId, 25000);
    }

    void PostToPage(string json)
    {
        try
        {
            if (web != null && web.CoreWebView2 != null)
                web.CoreWebView2.PostWebMessageAsJson(json);
        }
        catch { }
    }

    int LoadInt(string key, int def)
    {
        string v;
        if (cfg.TryGetValue(key, out v))
        {
            int n;
            if (int.TryParse(v, out n)) return n;
        }
        return def;
    }

    void SaveInt(string key, int val)
    {
        cfg[key] = val.ToString();
        SaveCfg();
    }

    // 允许程序化切换“是否抢焦点”
    public void SetAllowActivate(bool on)
    {
        allowActivate = on;
        // 重建样式
        RecreateHandle();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (tray != null) tray.Visible = false;
        base.OnFormClosing(e);
    }


    static bool ServiceUp(string url)
    {
        try
        {
            System.Net.HttpWebRequest req = (System.Net.HttpWebRequest)System.Net.WebRequest.Create(url);
            req.Timeout = 1200;
            using (System.Net.WebResponse res = req.GetResponse()) { return true; }
        }
        catch { return false; }
    }

    static void EnsureService(string url)
    {
        if (ServiceUp(url)) { Log("service already up"); return; }
        Log("starting local service...");
        try
        {
            string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
            // 便携版：优先用随包携带的 node.exe，不依赖目标机器的 PATH
            string bundledNode = Path.Combine(root, "node.exe");
            string nodeExe = File.Exists(bundledNode) ? bundledNode : "node";
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = nodeExe;
            psi.Arguments = "server.js";
            psi.WorkingDirectory = root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            Process.Start(psi);
            for (int i = 0; i < 25; i++)
            {
                Thread.Sleep(300);
                if (ServiceUp(url)) { Log("service is up"); return; }
            }
            Log("service start timed out");
        }
        catch (Exception ex) { Log("service start failed: " + ex.Message); }
    }

    [STAThread]
    static void Main(string[] args)
    {
        string url = "http://127.0.0.1:7788/";
        for (int i = 0; i < args.Length; i++)
            if (args[i] == "--url" && i + 1 < args.Length) url = args[++i];

        EnsureService(url);

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new DeskHost(url));
    }
}
