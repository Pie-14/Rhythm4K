using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

/// <summary>
/// Rhythm4K 启动器：用 Edge（或 Chrome）的 app 模式打开 www/index.html。
/// 任何一步失败都会写进 exe 旁边的 launch.log，方便排查"双击没反应"。
/// </summary>
static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        bool checkOnly = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (string.Equals(args[i], "--check", StringComparison.OrdinalIgnoreCase)) checkOnly = true;
        }

        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string logPath = Path.Combine(baseDir, "launch.log");

        try
        {
            Log(logPath, "=== start === exe=" + Application.ExecutablePath);
            Log(logPath, "baseDir=" + baseDir);

            string html = Path.Combine(Path.Combine(baseDir, "www"), "index.html");
            if (!File.Exists(html))
            {
                string alt = Path.Combine(baseDir, "index.html");
                if (File.Exists(alt)) html = alt;
                else
                {
                    Log(logPath, "ERROR 找不到 index.html");
                }
            }
            Log(logPath, "html=" + html + " exists=" + File.Exists(html));

            string browser = FindBrowser();
            Log(logPath, "browser=" + (browser == null ? "(none)" : browser));

            if (checkOnly)
            {
                WriteCheck(baseDir, html, browser, logPath);
                return;
            }

            if (!File.Exists(html))
            {
                MessageBox.Show(
                    "找不到游戏文件。\n\n请把 Rhythm4K.exe 和 www 文件夹放在同一个目录里。",
                    "Rhythm4K", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string uri = new Uri(html).AbsoluteUri;

            if (browser != null)
            {
                // 关键：用独立配置目录。不要碰用户平时的 Edge 配置，
                // 否则单实例锁（SingletonLock）一冲突，Edge 会直接 abort、不弹窗。
                string profile = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Rhythm4K", "profile");
                Directory.CreateDirectory(profile);
                Log(logPath, "profile=" + profile);

                string arguments =
                    "--app=\"" + uri + "\"" +
                    " --user-data-dir=\"" + profile + "\"" +
                    " --window-size=1920,1080" +
                    " --start-fullscreen" +
                    " --no-first-run" +
                    " --no-default-browser-check" +
                    " --disable-background-mode" +
                    " --allow-file-access-from-files";

                Log(logPath, "args=" + arguments);

                ProcessStartInfo psi = new ProcessStartInfo(browser, arguments);
                psi.UseShellExecute = false;
                Process p = Process.Start(psi);
                Log(logPath, "spawned pid=" + (p == null ? -1 : p.Id));
            }
            else
            {
                Log(logPath, "no browser found, use shell default");
                Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
            }

            Log(logPath, "=== done ===");
        }
        catch (Exception ex)
        {
            Log(logPath, "EXCEPTION " + ex.ToString());
            MessageBox.Show(
                "启动失败：" + ex.Message + "\n\n详细信息已写入：\n" + logPath,
                "Rhythm4K", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    static void Log(string path, string line)
    {
        try
        {
            File.AppendAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss  ") + line + "\r\n");
        }
        catch { }
    }

    /// <summary>--check：只把解析结果写进 launch.log，不打开浏览器</summary>
    static void WriteCheck(string baseDir, string html, string browser, string logPath)
    {
        Log(logPath, "htmlExists=" + File.Exists(html));
        Log(logPath, "browserOk=" + (browser != null && File.Exists(browser)));
        Log(logPath, "www=" + (Directory.Exists(Path.Combine(baseDir, "www"))
            ? string.Join(" | ", Directory.GetFileSystemEntries(Path.Combine(baseDir, "www")))
            : "(missing)"));
    }

    static string FindBrowser()
    {
        string[] candidates = new string[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe"),
        };

        for (int i = 0; i < candidates.Length; i++)
        {
            if (File.Exists(candidates[i])) return candidates[i];
        }

        try
        {
            object v = Microsoft.Win32.Registry.GetValue(
                @"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe", "", null);
            if (v is string && File.Exists((string)v)) return (string)v;
        }
        catch { }

        try
        {
            object v2 = Microsoft.Win32.Registry.GetValue(
                @"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe", "", null);
            if (v2 is string && File.Exists((string)v2)) return (string)v2;
        }
        catch { }

        return null;
    }
}
