/* Setup.cs — Agentcoin Core setup.exe (self-extracting, собирается csc.exe).
   payload.zip и install.ps1 встроены ресурсами. При запуске распаковываются
   во временный каталог, install.ps1 выполняется с правами администратора
   (манифест setup.manifest), после завершения временный каталог удаляется.
   Никаких внешних утилит (iexpress/makecab) не требуется. */
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;

namespace Agentcoin.Setup
{
    internal static class Program
    {
        private const string Banner = "Agentcoin Core setup";

        private static void Extract(string resourceName, string target)
        {
            Assembly self = Assembly.GetExecutingAssembly();
            using (Stream stream = self.GetManifestResourceStream(resourceName))
            {
                if (stream == null)
                {
                    throw new InvalidOperationException("setup is incomplete: no embedded " + resourceName);
                }
                using (FileStream file = File.Create(target))
                {
                    stream.CopyTo(file);
                }
            }
        }

        private static void Cleanup(string dir)
        {
            try
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, true);
            }
            catch
            {
                // временный каталог не критичен: его заберёт очистка %TEMP%
            }
        }

        [STAThread]
        private static int Main(string[] args)
        {
            string temp = Path.Combine(Path.GetTempPath(), "AgentcoinCore-setup-" + Process.GetCurrentProcess().Id);
            int code = 1;
            try
            {
                Directory.CreateDirectory(temp);
                string zip = Path.Combine(temp, "payload.zip");
                string ps1 = Path.Combine(temp, "install.ps1");
                Extract("payload.zip", zip);
                Extract("install.ps1", ps1);

                Console.WriteLine(Banner + " 0.2.0");
                Console.WriteLine("staging: " + temp);

                var psi = new ProcessStartInfo();
                psi.FileName = "powershell.exe";
                psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + ps1 + "\" -Source \"" + temp + "\"";
                psi.WorkingDirectory = temp;
                psi.UseShellExecute = false;

                using (Process child = Process.Start(psi))
                {
                    child.WaitForExit();
                    code = child.ExitCode;
                }

                Console.WriteLine();
                Console.WriteLine(code == 0
                    ? "Agentcoin Core installed. GUI: http://127.0.0.1:9333/gui  P2P: 0.0.0.0:19444"
                    : "Installer exited with code " + code);
            }
            catch (Exception e)
            {
                Console.WriteLine("setup failed: " + e.Message);
                code = 1;
            }
            finally
            {
                Cleanup(temp);
            }

            if (!Console.IsInputRedirected)
            {
                Console.WriteLine("Press Enter to close...");
                try { Console.ReadLine(); } catch { }
            }
            return code;
        }
    }
}
