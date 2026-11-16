using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

/**
 * 桌贴 · Daddy's DeskStick —— 便携版启动器
 *
 * 把内嵌的 app.zip 解压到 exe 同目录的 DeskStick\ 下（首次或版本变化时），
 * 然后启动 desktop\DeskHost.exe。目标机器不需要装 Node，也不需要装任何运行时
 * （除系统自带的 WebView2 Runtime，Win10 装了 Edge 就有）。
 */
class Launcher
{
    const string VER = "1.0.0";

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();

        try
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string appDir = Path.Combine(baseDir, "DeskStick");
            string marker = Path.Combine(appDir, ".version");

            if (!File.Exists(marker) || File.ReadAllText(marker).Trim() != VER)
            {
                Extract(appDir, marker);
            }

            string exe = Path.Combine(appDir, "desktop", "DeskHost.exe");
            if (!File.Exists(exe))
            {
                MessageBox.Show("解压后找不到 DeskHost.exe\r\n路径：" + exe,
                    "桌贴 · 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = exe,
                WorkingDirectory = Path.Combine(appDir, "desktop"),
                UseShellExecute = true
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show("启动失败：\r\n" + ex.Message,
                "桌贴 · 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    static void Extract(string appDir, string marker)
    {
        string tmpZip = Path.Combine(Path.GetTempPath(),
            "deskstick_" + Guid.NewGuid().ToString("N") + ".zip");

        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.zip"))
        {
            if (s == null) throw new Exception("内置资源 app.zip 丢失");
            using (FileStream fs = File.Create(tmpZip)) { s.CopyTo(fs); }
        }

        Directory.CreateDirectory(appDir);

        using (ZipArchive za = ZipFile.OpenRead(tmpZip))
        {
            foreach (ZipArchiveEntry e in za.Entries)
            {
                string dest = Path.Combine(appDir, e.FullName.Replace('/', '\\'));
                if (e.Name == "")
                {
                    Directory.CreateDirectory(dest);
                    continue;
                }
                string dir = Path.GetDirectoryName(dest);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                e.ExtractToFile(dest, true);
            }
        }

        try { File.Delete(tmpZip); } catch { }

        File.WriteAllText(marker, VER);
    }
}
