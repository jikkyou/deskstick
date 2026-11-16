"""
一键打包：生成干净示例数据 → 组 stage → 压 zip → 编 launcher → 输出 桌贴.exe

用法（在 web-v1 目录下）：python dist/build.py
"""
import json
import os
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)              # web-v1
STAGE = os.path.join(HERE, "stage")
ZIP = os.path.join(HERE, "app.zip")
EXE = os.path.join(HERE, "DeskStick.exe")
CLEAN = os.path.join(HERE, "clean-data")

CSC = r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
# 图标：优先用项目内 desktop/xitek.ico，回退到上级目录（开发机布局）
ICON = os.path.join(ROOT, "desktop", "xitek.ico")
if not os.path.isfile(ICON):
    ICON = os.path.join(os.path.dirname(ROOT), "xitek.ico")
NODE = r"C:\Program Files\nodejs\node.exe"


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        print("失败:", " ".join(cmd))
        print(r.stdout, r.stderr)
        sys.exit(1)
    return r


def main():
    print("[1/5] 生成干净示例数据")
    run([sys.executable, os.path.join(HERE, "make_clean_data.py")])

    print("[2/5] 组装 stage")
    if os.path.exists(STAGE):
        shutil.rmtree(STAGE)
    os.makedirs(STAGE)

    SKIP_EXT = (".bak", ".tmp", ".orig", ".swp", ".log", ".old")
    SKIP_NAMES = {"host.json", "host.log", "deskhost.log", "deskshell.log", "thumbs.db"}

    def _ignore(dirpath, names):
        out = []
        for n in names:
            low = n.lower()
            if low.endswith(SKIP_EXT) or low in SKIP_NAMES:
                out.append(n)
            elif n.startswith(".") and n not in (".", ".."):
                out.append(n)
            elif low.startswith("wv2data"):          # WebView2 用户数据（含 cookie / 登录态）
                out.append(n)
        return out

    def copy(src, dst):
        dst = os.path.join(STAGE, dst)
        parent = os.path.dirname(dst)
        if parent:
            os.makedirs(parent, exist_ok=True)
        if os.path.isdir(src):
            shutil.copytree(src, dst, ignore=_ignore)
        else:
            shutil.copy2(src, dst)

    for f in ["server.js", "xz.js", "README.md", "Start DeskStick.bat", "Start DeskStick (Desktop).bat", "停止服务.bat"]:
        copy(os.path.join(ROOT, f), f)
    copy(os.path.join(ROOT, "public"), "public")

    os.makedirs(os.path.join(STAGE, "desktop"), exist_ok=True)
    for f in ["DeskHost.exe", "Microsoft.Web.WebView2.Core.dll",
              "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll"]:
        copy(os.path.join(ROOT, "desktop", f), os.path.join("desktop", f))
    # host.json 是「这台机器」的配置（屏幕、透明度），不发出去：
    # 缺省时宿主自己按主屏 + alpha=214 起步
    # tools/ 是本地调试工具，也不发

    # 只带干净示例数据，不带用户的真实记录
    shutil.copytree(CLEAN, os.path.join(STAGE, "data"))
    # 自启标记不能带，否则新机器不会走「首次默认开启」
    flag = os.path.join(STAGE, "data", "autostart.json")
    if os.path.exists(flag):
        os.remove(flag)

    copy(NODE, "node.exe")

    print("[3/5] 压 zip")
    if os.path.exists(ZIP):
        os.remove(ZIP)
    with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for base, dirs, files in os.walk(STAGE):
            for f in files:
                full = os.path.join(base, f)
                z.write(full, os.path.relpath(full, STAGE).replace("\\", "/"))
    print("      zip: %.1f MB" % (os.path.getsize(ZIP) / 1024 / 1024))

    print("[4/5] 编译 launcher")
    if os.path.exists(EXE):
        os.remove(EXE)
    run([CSC, "-nologo", "-platform:x64", "-target:winexe",
         "-win32icon:" + ICON,
         "-resource:" + ZIP + ",app.zip",
         "-r:System.Windows.Forms.dll", "-r:System.Drawing.dll",
         "-r:System.IO.Compression.dll", "-r:System.IO.Compression.FileSystem.dll",
         "-out:" + EXE,
         os.path.join(HERE, "launcher.cs")])

    print("[5/5] 清理 + 校验")
    shutil.rmtree(STAGE)

    # 校验：全包扫一遍，不该有真实数据 / 登录凭证 / 本机路径
    bad = []

    # 私人关键词表：默认用通用词；本机可放 dist/.private-words.txt 追加自己的
    # （每行一个，不进仓库）
    PRIVATE_KW = ["C:\\Users\\", "/Users/", "/home/"]
    _pw = os.path.join(HERE, ".private-words.txt")
    if os.path.isfile(_pw):
        with open(_pw, encoding="utf-8") as f:
            PRIVATE_KW += [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
    # 这些是 JSON 字段名，只对非 node.exe 的文本文件检查
    SECRET_KW = ['"access"', '"refresh"', "xq_a_token", "xqat", "access_token", "refresh_token",
                 "set-cookie", "Authorization"]

    with zipfile.ZipFile(ZIP) as z:
        for name in z.namelist():
            # node.exe / dll / 图片是二进制，跳过
            if name.lower().endswith((".exe", ".dll", ".png", ".jpg", ".ico", ".zip")):
                continue
            try:
                txt = z.read(name).decode("utf-8", "ignore")
            except Exception:
                continue

            for kw in PRIVATE_KW:
                if kw in txt:
                    bad.append(name + "  含私人关键词: " + kw)

            # 登录凭证只在 data/*.json 和 desktop/*.json 里查
            if name.startswith("data/") or name.startswith("desktop/"):
                for kw in SECRET_KW:
                    if kw in txt:
                        bad.append(name + "  疑似凭证字段: " + kw)

    # 必需文件检查（少一个都跑不起来）
    MUST_HAVE = ["server.js", "xz.js", "node.exe", "public/index.html",
                 "public/js/main.js", "public/js/widgets/xueqiu.js", "public/js/widgets/xyz.js",
                 "desktop/DeskHost.exe", "desktop/WebView2Loader.dll",
                 "data/layout.json", "data/settings.json"]
    with zipfile.ZipFile(ZIP) as z:
        have = set(z.namelist())
    for m in MUST_HAVE:
        if m not in have:
            bad.append("缺少必需文件: " + m)

    # 结构性检查：不该出现这些项
    MUST_NOT = ["desktop/wv2data", "desktop/wv2data_xueqiu", "desktop/host.json",
                "desktop/host.log", "desktop/tools/", "data/xiaoyuzhou.json",
                "data/xyz-progress.json", "data/xyz-queue.json"]
    with zipfile.ZipFile(ZIP) as z:
        names = z.namelist()
    for m in MUST_NOT:
        hits = [n for n in names if n.startswith(m)]
        if hits:
            bad.append("不该打包但出现了: " + m + " (" + str(len(hits)) + " 项)")

    with zipfile.ZipFile(ZIP) as z:
        n_files = len(z.namelist())
    print("\n产物：")
    print("  %s  (%.1f MB)" % (EXE, os.path.getsize(EXE) / 1024 / 1024))
    print("  包内 %d 个文件" % n_files)
    if bad:
        print("  !! 发现真实数据残留：")
        for b in bad:
            print("     " + b)
        sys.exit(1)
    print("  ✓ 包内 data 已确认不含个人数据")


if __name__ == "__main__":
    main()
