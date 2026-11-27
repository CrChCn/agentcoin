// AgentcoinServiceHost — минимальный хост Windows-службы без внешних зависимостей.
// Служба SCM запускает этот exe, он запускает дочерний процесс (node.exe ...),
// перенаправляет его stdout/stderr в лог и гасит процесс при остановке службы.
// Собирается csc.exe из .NET Framework 4, который есть на любой Windows 10/11.
//
// Использование (binPath службы):
//   AgentcoinServiceHost.exe --name AgentcoinNode --log "C:\ProgramData\...\node.log" --cwd "C:\Program Files\AgentcoinCore" -- "C:\...\node.exe" "C:\...\app\launcher.mjs" --service
using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Text;

namespace Agentcoin
{
    public sealed class ChildService : ServiceBase
    {
        private readonly string _exe;
        private readonly string _args;
        private readonly string _cwd;
        private readonly string _logFile;
        private Process _child;
        private readonly object _lock = new object();

        public ChildService(string name, string exe, string args, string cwd, string logFile)
        {
            ServiceName = name;
            _exe = exe;
            _args = args ?? string.Empty;
            _cwd = string.IsNullOrEmpty(cwd) ? Path.GetDirectoryName(exe) : cwd;
            _logFile = logFile;
            CanStop = true;
            CanShutdown = true;
            CanPauseAndContinue = false;
            CanHandlePowerEvent = false;
            CanHandleSessionChangeEvent = false;
            AutoLog = true;
        }

        protected override void OnStart(string[] args)
        {
            Log("service start: " + _exe + " " + _args);
            StartChild();
        }

        protected override void OnStop()
        {
            Log("service stop requested");
            StopChild();
        }

        protected override void OnShutdown()
        {
            Log("system shutdown");
            StopChild();
            base.OnShutdown();
        }

        private void StartChild()
        {
            lock (_lock)
            {
                if (_child != null && !_child.HasExited) return;
                var psi = new ProcessStartInfo(_exe, _args)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = _cwd,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                var child = new Process { StartInfo = psi, EnableRaisingEvents = true };
                child.OutputDataReceived += (s, e) => { if (e.Data != null) Log(e.Data); };
                child.ErrorDataReceived += (s, e) => { if (e.Data != null) Log("ERR " + e.Data); };
                child.Exited += (s, e) =>
                {
                    int code = -1;
                    try { code = child.ExitCode; } catch { }
                    Log("child exited with " + code);
                };
                child.Start();
                child.BeginOutputReadLine();
                child.BeginErrorReadLine();
                _child = child;
                Log("child pid " + child.Id);
            }
        }

        private void StopChild()
        {
            lock (_lock)
            {
                try
                {
                    if (_child == null || _child.HasExited) return;
                    try
                    {
                        // Даём ноде закрыть сокеты и сохранить состояние.
                        _child.Kill();
                    }
                    catch (Exception e) { Log("kill failed: " + e.Message); }
                    _child.WaitForExit(20000);
                    Log("child stopped");
                }
                catch (Exception e) { Log("stop error: " + e.Message); }
            }
        }

        private void Log(string line)
        {
            if (string.IsNullOrEmpty(_logFile)) return;
            try
            {
                var dir = Path.GetDirectoryName(_logFile);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                var fi = new FileInfo(_logFile);
                if (fi.Exists && fi.Length > 8 * 1024 * 1024)
                {
                    var old = _logFile + ".1";
                    try { if (File.Exists(old)) File.Delete(old); File.Move(_logFile, old); } catch { }
                }
                File.AppendAllText(_logFile,
                    DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ") + " " + line + Environment.NewLine,
                    Encoding.UTF8);
            }
            catch { /* лог не должен ронять службу */ }
        }

        public static int Main(string[] args)
        {
            string name = null, log = null, cwd = null;
            int i = 0;
            for (; i < args.Length; i++)
            {
                if (args[i] == "--") { i++; break; }
                if (args[i] == "--name" && i + 1 < args.Length) { name = args[++i]; continue; }
                if (args[i] == "--log" && i + 1 < args.Length) { log = args[++i]; continue; }
                if (args[i] == "--cwd" && i + 1 < args.Length) { cwd = args[++i]; continue; }
                Console.Error.WriteLine("unknown argument: " + args[i]);
                return 64;
            }
            if (string.IsNullOrEmpty(name) || i >= args.Length)
            {
                Console.Error.WriteLine("usage: AgentcoinServiceHost.exe --name NAME [--log FILE] [--cwd DIR] -- EXE [ARGS...]");
                return 64;
            }
            var exe = args[i];
            var sb = new StringBuilder();
            for (int j = i + 1; j < args.Length; j++)
            {
                if (j > i + 1) sb.Append(' ');
                sb.Append(Quote(args[j]));
            }
            ServiceBase.Run(new ChildService(name, exe, sb.ToString(), cwd, log));
            return 0;
        }

        private static string Quote(string value)
        {
            if (value.Length == 0) return "\"\"";
            if (value.IndexOf(' ') < 0 && value.IndexOf('"') < 0 && value.IndexOf('\t') < 0) return value;
            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }
    }
}
