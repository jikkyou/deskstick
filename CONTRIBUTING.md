# 贡献指南

感谢愿意接手。这个项目不复杂，看完这页大概就知道从哪里下手了。

## 环境要求

| 用途 | 需要 |
|---|---|
| 只跑前端和服务 | Node 18+（零 npm 依赖，不用 `npm install`） |
| 改桌面宿主 | Windows + .NET Framework 4.x 自带的 `csc.exe` |
| 打包 EXE | Python 3.9+ |

## 跑起来

```bash
git clone https://github.com/jikkyou/deskstick.git
cd deskstick
node server.js
```

浏览器打开 `http://127.0.0.1:7788/`。

仓库里的 `data/` 是示例数据，直接跑不会有你的私人记录。要清空重来就删掉 `data/` 下的 JSON，服务会重新生成默认值。

## 代码分四块

```
server.js             本地服务。静态托管 + JSON 读写 + 两个代理（天气、小宇宙）
xz.js                 小宇宙 HTTP 封装，给 server.js 用
public/js/widgets/    每张卡片一个文件，导出 mount(el, ctx) 和 unmount()
public/js/main.js     布局引擎：拖动、缩放、吸附、对齐、缩放适配
desktop/*.cs          C# WebView2 宿主，用 csc.exe 直接编译，没有 csproj
```

**加一张卡片**只需要三步：

1. 在 `public/js/widgets/` 新建 `yourwidget.js`，导出 `mount(el, ctx)` 和 `unmount()`
2. 在 `public/js/registry.js` 注册类型
3. 设置面板的组件列表里加一项

`ctx` 提供 `ctx.api`（读写 JSON）、`ctx.toast()`、`ctx.save()` 等工具，看现有卡片怎么用就明白了。

## 提交前

```bash
node --check server.js
node --check public/js/main.js
node --check public/js/widgets/yourwidget.js
```

C# 改了要重新编译：

```bash
cd desktop
csc.exe /target:winexe /out:DeskHost.exe DeskHost.cs XueqiuWindow.cs \
  /r:Microsoft.Web.WebView2.Core.dll /r:Microsoft.Web.WebView2.WinForms.dll \
  /r:System.Windows.Forms.dll /r:System.Drawing.dll \
  /win32icon:xitek.ico /resource:xitek.ico,app.ico
```

（`dist/build.py` 里有完整的编译参数，包含所有引用）

## 提交 PR

- 一次 PR 做一件事，别把格式化和功能混在一起
- 说明改了什么、为什么改、怎么验证的
- 涉及 UI 的附截图

## 不要提交的东西

`.gitignore` 已经挡住了大部分，但提交前还是自查一下：

- `data/*.json` 里的真实个人数据
- `desktop/wv2data*/`（WebView2 用户目录，含 Cookie）
- `desktop/host.json`（本机屏幕配置）
- 任何 token、Cookie、密码

`data/xiaoyuzhou.json` 和雪球窗口的登录态**永远不要**提交。

## 已知的坑

改代码时可能踩到，先看一眼能省时间：

**雪球的异步桥接** —— `ExecuteScriptAsync` 不会等 Promise，返回的是 `"{}"`。结果必须走 `chrome.webview.postMessage`，C# 端在 `WebMessageReceived` 里接。改这块时别退回 `ExecuteScriptAsync`。

**雪球接口的登录判定** —— 只能用 HTTP `401/403` 判断是否需要登录。响应体里本来就带 `error_code` 字段，拿它做正则匹配会把正常数据误判成未登录。

**天气的 CORS** —— wttr.in 和 Open-Meteo 都不发 CORS 头，前端直连必被拦。所有请求走 `/api/weather`。

**布局重排的时机** —— 分辨率变化后重排必须在所有 widget `mount()` **之后**执行，否则拿不到卡片实际高度。

**月历改周数** —— 只重算 widget 内部网格，不要调 `relayout()`，否则整个桌面布局会被打乱。

## 许可

提交的代码按 [MIT](LICENSE) 授权。
