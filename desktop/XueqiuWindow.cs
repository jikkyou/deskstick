using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

/// <summary>
/// 雪球窗口：一个独立的 WebView2 浏览器窗口。
///
/// 设计要点：
///   1. 用独立的 UserDataFolder（wv2data_xueqiu），跟桌贴主窗口完全隔离，
///      登录态互不影响。
///   2. 页面就是真实的 xueqiu.com，用户在里面想怎么登录、怎么点都行，
///      对雪球来说这就是一台普通 Edge 在访问，不是爬虫。
///   3. 卡片要数据时才通过 FetchAsync 在页面上下文里调接口 ——
///      自动带上 Cookie，阿里云 WAF 的 JS 挑战也由浏览器自己过。
///      没有任何定时器，全部由用户点「刷新」触发。
/// </summary>
class XueqiuWindow : Form
{
    const string HOME = "https://xueqiu.com/";

    WebView2 web;
    bool ready = false;
    public event Action<string> LogLine;

    /// <summary>页面回传的原始 JSON（形如 {"type":"xqResult",...}）</summary>
    public event Action<string> DataFromPage;

    public XueqiuWindow()
    {
        Text = "雪球 · 桌贴";
        Width = 1180;
        Height = 820;
        MinimumSize = new Size(760, 520);
        StartPosition = FormStartPosition.CenterScreen;

        web = new WebView2();
        web.Dock = DockStyle.Fill;
        Controls.Add(web);
    }

    public bool IsReady { get { return ready && web != null && web.CoreWebView2 != null; } }

    void Log(string s)
    {
        var h = LogLine;
        if (h != null) h(s);
    }

    public async Task InitAsync()
    {
        if (IsReady) return;

        string dir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "wv2data_xueqiu");
        Log("InitAsync 开始, dataDir=" + dir);

        try
        {
            Directory.CreateDirectory(dir);
            Log("CreateAsync 环境…");
            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, dir, null);

            Log("EnsureCoreWebView2Async…");
            await web.EnsureCoreWebView2Async(env);

            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            web.CoreWebView2.Settings.AreDevToolsEnabled = true;

            // 页面 → C# 的单向数据通道
            web.CoreWebView2.WebMessageReceived += delegate (object o, CoreWebView2WebMessageReceivedEventArgs e)
            {
                string js = "";
                try { js = e.WebMessageAsJson; }
                catch (Exception ex) { Log("页面消息解析失败: " + ex.Message); return; }

                if (string.IsNullOrEmpty(js)) return;
                if (js.IndexOf("\"xqResult\"") < 0) return;
                var h = DataFromPage;
                if (h != null) { try { h(js); } catch (Exception ex) { Log("DataFromPage 异常: " + ex.Message); } }
            };

            web.CoreWebView2.NavigationCompleted += delegate (object o, CoreWebView2NavigationCompletedEventArgs ev)
            {
                Log("导航完成 ok=" + ev.IsSuccess + " url=" + (web.CoreWebView2 != null ? web.CoreWebView2.Source : "?"));
            };

            web.CoreWebView2.Navigate(HOME);

            ready = true;
            Log("雪球窗口就绪");
        }
        catch (Exception ex)
        {
            ready = false;
            Log("InitAsync 失败: " + ex.GetType().Name + " " + ex.Message);
        }
    }

    static string Escape(string s)
    {
        if (s == null) return "";
        string r = s.Replace("\\", "\\\\");
        r = r.Replace("'", "\\'");
        r = r.Replace("\r", "");
        r = r.Replace("\n", "");
        return r;
    }

    /// <summary>
    /// 在雪球页面里发起一次 fetch。**不返回结果** —— 结果通过 DataFromPage 事件回传。
    ///
    /// 为什么不用 ExecuteScriptAsync 的返回值：
    ///   它不会等待 async IIFE 返回的 Promise，实测直接得到 "{}"。
    ///   所以脚本末尾补一个 "0"，让它立刻返回，真正的数据走 postMessage。
    /// </summary>
    /// <summary>同步探测页面里有没有 chrome.webview 通道（不涉及 Promise，能直接拿到结果）</summary>
        public void StartFetch(string apiPath, string reqId, int timeoutMs)
    {
        if (!IsReady) return;

        string p = Escape(apiPath);
        string rid = Escape(reqId);

        string js =
            "(async () => {\n" +
            "  const rid = '" + rid + "';\n" +
            "  const ctrl = new AbortController();\n" +
            "  const timer = setTimeout(() => ctrl.abort(), " + timeoutMs + ");\n" +
            "  let out;\n" +
            "  try {\n" +
            "    const r = await fetch('" + p + "', { credentials:'include', signal: ctrl.signal });\n" +
            "    const t = await r.text();\n" +
            "    out = { reqId: rid, ok: r.ok, status: r.status, body: t };\n" +
            "  } catch (e) {\n" +
            "    out = { reqId: rid, ok: false, status: 0, error: String(e && e.message ? e.message : e) };\n" +
            "  } finally { clearTimeout(timer); }\n" +
            "  try { chrome.webview.postMessage(Object.assign({ type: 'xqResult' }, out)); } catch (e2) {}\n" +
            "})();\n" +
            "0";

        try { web.CoreWebView2.ExecuteScriptAsync(js); }
        catch (Exception ex) { Log("StartFetch 异常: " + ex.Message); }
    }

    /// <summary>当前页面 URL，用来判断用户是否已经进到雪球站内</summary>
    /// <summary>
    /// 抓首页关注流的 DOM（雪球自己渲染好了，20 条左右）。
    /// 比调 /v4/statuses/home_timeline.json 靠谱 —— 那个接口无论怎么带 cookie 都 403。
    /// </summary>
    public void StartGrabTimeline(string reqId, int limit)
    {
        if (!IsReady) return;
        string rid = Escape(reqId);
        string js =
            "(function(){ try {\n" +
            "  const LIMIT = " + limit + ";\n" +
            "  const items = [];\n" +
            "  const nodes = document.querySelectorAll('.timeline__item');\n" +
            "  for (let i = 0; i < nodes.length && items.length < LIMIT; i++) {\n" +
            "    const el = nodes[i];\n" +
            "    const q = function(sel){ const n = el.querySelector(sel); return n ? (n.innerText || '').trim() : ''; };\n" +
            "    const name = q('.user-name');\n" +
            "    const date = q('.date-and-source');\n" +
            "    const title = q('.timeline__item__title');\n" +
            "    const content = q('.content');\n" +
            "    let txt = (title ? title + '　' : '') + content;\n" +
            "    txt = txt.replace(/\\s+/g, ' ').trim();\n" +
            "    if (!txt) continue;\n" +
            "    items.push({ name: name, date: date, text: txt.slice(0, 3000) });\n" +
            "  }\n" +
            "  chrome.webview.postMessage({ type: 'xqResult', reqId: '" + rid + "', ok: true, status: 200,\n" +
            "    body: JSON.stringify({ items: items, total: nodes.length, url: location.href }) });\n" +
            "} catch(e) {\n" +
            "  try { chrome.webview.postMessage({ type: 'xqResult', reqId: '" + rid + "', ok: false, status: 0, error: '抓取异常: ' + e.message }); } catch(e2) {}\n" +
            "} })();\n" +
            "0";
        try { web.CoreWebView2.ExecuteScriptAsync(js); }
        catch (Exception ex) { Log("StartGrabTimeline 异常: " + ex.Message); }
    }

    /// <summary>当前页面 URL，用来判断用户是否已经进到雪球站内</summary>
    /// <summary>
    /// 抓首页关注流的 DOM（雪球自己渲染好了，20 条左右）。
    /// 比调 /v4/statuses/home_timeline.json 靠谱 —— 那个接口无论怎么带 cookie 都 403。
    /// </summary>
        /// <summary>调试用：dump 首页 DOM，看雪球自己渲染了什么（关注流在页面上）</summary>
        /// <summary>调试用：dump 一条 timeline__item 的内部结构</summary>
            /// <summary>临时探测：首页有哪些 tab / 栏目</summary>
            /// <summary>临时探测：点某个 tab 并抓内容</summary>
    public void ClickTabAndGrab(string tabName, string reqId)
    {
        if (!IsReady) return;
        string t = Escape(tabName);
        string rid = Escape(reqId);
        string js =
            "(function(){ try {\n" +
            "  const box = document.querySelector('.home-timeline-tabs');\n" +
            "  if (!box) { chrome.webview.postMessage({type:'xqResult', reqId:'" + rid + "', ok:false, status:0, error:'没找到 tab 容器'}); return; }\n" +
            "  const a = [...box.querySelectorAll('a')].find(function(x){ return (x.textContent||'').trim() === '" + t + "'; });\n" +
            "  if (!a) { chrome.webview.postMessage({type:'xqResult', reqId:'" + rid + "', ok:false, status:0, error:'没有这个 tab: " + t + "'}); return; }\n" +
            "  a.click();\n" +
            "  setTimeout(function(){\n" +
            "    try {\n" +
            "      // 先把雪球自己的「展开」全部点开，否则长文只给前几行\n" +
            "      document.querySelectorAll('.timeline__unfold__control').forEach(function(n){ try { n.click(); } catch(e){} });\n" +
            "    } catch(e) {}\n" +
            "    setTimeout(function(){\n" +
            "    try {\n" +
            "      const out = [];\n" +
            "      const nodes = document.querySelectorAll('.timeline__item');\n" +
            "      for (let i = 0; i < nodes.length && out.length < 12; i++) {\n" +
            "        const el = nodes[i];\n" +
            "        const q = function(sel){ const n = el.querySelector(sel); return n ? (n.innerText||'').trim() : ''; };\n" +
            "        let txt = q('.timeline__item__title') + ' ' + q('.content');\n" +
            "        txt = txt.replace(/\\s+/g,' ').trim();\n" +
            "        if (!txt) continue;\n" +
            "        out.push({ name: q('.user-name'), date: q('.date-and-source'), text: txt.slice(0, 3000) });\n" +
            "      }\n" +
            "      chrome.webview.postMessage({ type:'xqResult', reqId:'" + rid + "', ok:true, status:200,\n" +
            "        body: JSON.stringify({ tab: '" + t + "', items: out, total: nodes.length, url: location.href }) });\n" +
            "    } catch(e2) {\n" +
            "      chrome.webview.postMessage({type:'xqResult', reqId:'" + rid + "', ok:false, status:0, error:'抓取异常 ' + e2.message});\n" +
            "    }\n" +
            "    }, 700);\n" +
            "  }, 2500);\n" +
            "} catch(e) {\n" +
            "  try { chrome.webview.postMessage({type:'xqResult', reqId:'" + rid + "', ok:false, status:0, error:'点击异常 ' + e.message}); } catch(e3) {}\n" +
            "} })();\n" +
            "0";
        try { web.CoreWebView2.ExecuteScriptAsync(js); } catch { }
    }

    public string CurrentUrl()
    {
        if (!IsReady) return "";
        try { return web.CoreWebView2.Source ?? ""; } catch { return ""; }
    }

    public void GoHome()
    {
        if (!IsReady) return;
        web.CoreWebView2.Navigate(HOME);
    }

    public void ReloadPage()
    {
        if (!IsReady) return;
        web.CoreWebView2.Reload();
    }
}
