using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.Json;
using System.Threading;
using Interop.UIAutomationClient;
using ReadBridge.Companion.Infrastructure;
using ReadBridge.Companion.Models;
using ReadBridge.Companion.Overlay;
using ReadBridge.Companion.Uia;

namespace ReadBridge.Companion
{
    public class Program
    {
        [STAThread]
        public static int Main(string[] args)
        {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            string command = args.Length > 0 ? args[0].ToLowerInvariant() : "inspect";

            switch (command)
            {
                case "inspect":
                    return RunInspect(args);

                case "inspect-proc":
                    return RunInspectProc(args);

                case "highlight-test":
                    return RunHighlightTest(args);

                case "matrix-scan":
                    return RunMatrixScan(args);

                case "ipc":
                    return RunIpcLoop(args);

                default:
                    Console.WriteLine($"Unknown command: {command}");
                    Console.WriteLine("Usage: ReadBridge.Companion [inspect|inspect-proc <name>|highlight-test|matrix-scan|ipc [--parent-pid|-p <pid>]]");
                    return 1;
            }
        }

        private static int RunInspect(string[] args)
        {
            int delayMs = 0;
            if (args.Length > 1 && int.TryParse(args[1], out int parsedDelay))
            {
                delayMs = parsedDelay;
            }

            if (delayMs > 0)
            {
                Console.WriteLine($"Waiting {delayMs}ms for you to focus the target window...");
                Thread.Sleep(delayMs);
            }

            var result = UiaEngine.InspectForegroundWindow();
            return PrintInspection(result);
        }

        private static int RunInspectProc(string[] args)
        {
            if (args.Length < 2)
            {
                Console.WriteLine("Usage: ReadBridge.Companion inspect-proc <ProcessNameOrPid>");
                return 1;
            }

            string target = args[1];
            var candidateHwnds = new List<IntPtr>();
            var targetPids = new HashSet<uint>();

            if (int.TryParse(target, out int pid))
            {
                targetPids.Add((uint)pid);
            }
            else
            {
                string cleanName = target.Replace(".exe", "");
                var procs = Process.GetProcessesByName(cleanName);
                foreach (var p in procs)
                {
                    targetPids.Add((uint)p.Id);
                }
            }

            NativeMethods.EnumWindows((hwnd, lParam) =>
            {
                if (NativeMethods.IsWindowVisible(hwnd))
                {
                    NativeMethods.GetWindowThreadProcessId(hwnd, out uint wPid);
                    if (targetPids.Contains(wPid))
                    {
                        if (NativeMethods.GetWindowRect(hwnd, out var r) && r.Width > 150 && r.Height > 150)
                        {
                            string cls = NativeMethods.GetClassName(hwnd);
                            if (cls != "#32770" && !cls.Contains("Overlay") && !cls.Contains("Indicator"))
                            {
                                candidateHwnds.Add(hwnd);
                            }
                        }
                    }
                }
                return true;
            }, IntPtr.Zero);

            if (candidateHwnds.Count == 0)
            {
                Console.WriteLine($"Could not find any visible top-level windows for target '{target}'.");
                return 1;
            }

            // Pick candidate with largest window area
            candidateHwnds.Sort((a, b) =>
            {
                NativeMethods.GetWindowRect(a, out var ra);
                NativeMethods.GetWindowRect(b, out var rb);
                long areaA = (long)ra.Width * ra.Height;
                long areaB = (long)rb.Width * rb.Height;
                return areaB.CompareTo(areaA);
            });

            IntPtr targetHwnd = candidateHwnds[0];
            var result = UiaEngine.InspectWindow(targetHwnd);
            return PrintInspection(result);
        }

        private static int PrintInspection(WindowInspectionResult result)
        {
            var json = JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true });
            Console.WriteLine(json);

            var compat = UiaEngine.EvaluateCompatibility(result);
            Console.WriteLine("\n=== EVALUATED COMPATIBILITY ===");
            Console.WriteLine($"Application: {compat.Application} ({compat.ProcessName})");
            Console.WriteLine($"UIA Provider: {compat.UiaProviderDiscovered}");
            Console.WriteLine($"TextPattern: {compat.TextPattern} | TextPattern2: {compat.TextPattern2}");
            Console.WriteLine($"Selection Capture: {compat.SelectionCapture}");
            Console.WriteLine($"Document Text: {compat.DocumentVisibleText}");
            Console.WriteLine($"Character Navigation: {compat.CharacterNavigation}");
            Console.WriteLine($"Word Navigation: {compat.WordNavigation}");
            Console.WriteLine($"Bounding Rect Precision: {compat.BoundingRectangles}");
            Console.WriteLine($"Window Move Tracking: {compat.WindowMoveTracking}");
            Console.WriteLine($"DPI Behavior: {compat.DpiBehavior}");
            Console.WriteLine($"Observed Failures: {compat.ObservedFailures}");
            Console.WriteLine($"Recommended Capability: {compat.RecommendedCapabilityLevel}");

            return 0;
        }

        private static int RunHighlightTest(string[] args)
        {
            int delayMs = 1500;
            IntPtr hwnd = IntPtr.Zero;

            if (args.Length > 1)
            {
                string arg = args[1];
                if (int.TryParse(arg, out int parsedVal))
                {
                    if (parsedVal > 100)
                    {
                        delayMs = parsedVal;
                    }
                    else
                    {
                        try { hwnd = Process.GetProcessById(parsedVal).MainWindowHandle; } catch { }
                    }
                }
                else
                {
                    var procs = Process.GetProcessesByName(arg.Replace(".exe", ""));
                    foreach (var pr in procs)
                    {
                        if (pr.MainWindowHandle != IntPtr.Zero) { hwnd = pr.MainWindowHandle; break; }
                    }
                }
            }

            if (hwnd == IntPtr.Zero)
            {
                if (delayMs > 0)
                {
                    Console.WriteLine($"[ReadBridge] Waiting {delayMs}ms... Switch focus to target window.");
                    Thread.Sleep(delayMs);
                }
                hwnd = NativeMethods.GetForegroundWindow();
            }

            var inspection = UiaEngine.InspectWindow(hwnd);
            Console.WriteLine($"\n[Target Window] '{inspection.WindowTitle}' (Process: {inspection.ProcessName}, PID: {inspection.ProcessId})");

            if (inspection.PrimaryProvider == null)
            {
                Console.WriteLine("[Error] No UIA TextPattern provider found in target window.");
                return 1;
            }

            var p = inspection.PrimaryProvider;
            Console.WriteLine($"[Provider] {p.Name} (Class: {p.ClassName}, Framework: {p.FrameworkId})");
            Console.WriteLine($"[TextPattern2] {p.SupportsTextPattern2} | [Selection] {p.HasActiveSelection}");

            IUIAutomationElement rootElem = UiaEngine.Automation.ElementFromHandle(hwnd);
            if (rootElem == null) return 1;

            var patternObj = rootElem.GetCurrentPattern(UIA_PatternIds.UIA_TextPatternId);
            if (patternObj == null)
            {
                var walker = UiaEngine.Automation.ControlViewWalker;
                var child = walker.GetFirstChildElement(rootElem);
                while (child != null && patternObj == null)
                {
                    try { patternObj = child.GetCurrentPattern(UIA_PatternIds.UIA_TextPatternId); } catch { }
                    if (patternObj == null) child = walker.GetNextSiblingElement(child);
                }
            }

            if (patternObj == null)
            {
                Console.WriteLine("[Error] Could not obtain COM IUIAutomationTextPattern interface.");
                return 1;
            }

            var tp = (IUIAutomationTextPattern)patternObj;
            var docRange = tp.DocumentRange;
            if (docRange == null)
            {
                Console.WriteLine("[Error] DocumentRange is null.");
                return 1;
            }

            tagRECT? containerRect = null;
            try { containerRect = rootElem.CurrentBoundingRectangle; } catch { }

            var words = TextRangeNavigator.EnumerateWords(docRange, containerRect, maxWords: 20);
            Console.WriteLine($"[Enumerated Words] Found {words.Count} words with bounding geometry.");

            using var overlay = new OverlayController();
            using var tracker = new WindowTracker(hwnd, () =>
            {
                Console.WriteLine("[WindowTracker] Target window moved/resized.");
            });

            Console.WriteLine("\n[Highlighting Demo] Starting word stepping across screen...");
            for (int i = 0; i < words.Count; i++)
            {
                var (word, range, bounds) = words[i];
                Console.WriteLine($" -> Word [{i + 1}/{words.Count}]: '{word}' | Bounds: {string.Join(", ", bounds)}");
                overlay.ShowHighlights(null, bounds);
                Thread.Sleep(250);
            }

            Console.WriteLine("[Highlighting Demo] Stepping complete. Clearing overlay.");
            overlay.Clear();
            Thread.Sleep(300);

            return 0;
        }

        private static int RunMatrixScan(string[] args)
        {
            var targetProcessNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "notepad", "code", "chrome", "brave", "msedge", "winword", "discord", "slack"
            };

            var records = new List<ApplicationCompatibilityRecord>();
            var scannedHwnds = new HashSet<IntPtr>();

            NativeMethods.EnumWindows((hwnd, lParam) =>
            {
                if (NativeMethods.IsWindowVisible(hwnd))
                {
                    if (NativeMethods.GetWindowRect(hwnd, out var r) && r.Width > 150 && r.Height > 150)
                    {
                        string cls = NativeMethods.GetClassName(hwnd);
                        if (cls != "#32770" && !cls.Contains("Overlay") && !cls.Contains("Indicator") && !cls.Contains("ToolTip"))
                        {
                            NativeMethods.GetWindowThreadProcessId(hwnd, out uint pid);
                            try
                            {
                                var proc = Process.GetProcessById((int)pid);
                                if (targetProcessNames.Contains(proc.ProcessName) && scannedHwnds.Add(hwnd))
                                {
                                    Console.WriteLine($"\n[Scanning] {proc.ProcessName} (HWND: 0x{hwnd.ToInt64():X}, Title: '{NativeMethods.GetWindowTitle(hwnd)}')");
                                    var inspection = UiaEngine.InspectWindow(hwnd);
                                    var compat = UiaEngine.EvaluateCompatibility(inspection);
                                    records.Add(compat);
                                }
                            }
                            catch { }
                        }
                    }
                }
                return true;
            }, IntPtr.Zero);

            var json = JsonSerializer.Serialize(records, new JsonSerializerOptions { WriteIndented = true });
            Console.WriteLine("\n=== FULL COMPATIBILITY MATRIX JSON ===");
            Console.WriteLine(json);

            return 0;
        }

        private const int ParentPollIntervalMs = 500;
        private const int OverlayTeardownTimeoutMs = 2000;

        /// <summary>
        /// Completes only once the parent process is actually observed to be gone.
        /// A direct exit-wait handle is preferred, but if one cannot be obtained (for example a
        /// cross-session or higher-integrity host denies SYNCHRONIZE access) this degrades to
        /// polling instead of treating "cannot observe" as "has exited" - otherwise a companion
        /// whose parent is still very much alive would terminate itself moments after launch.
        /// </summary>
        private static async Task WaitForParentExitAsync(int parentPid)
        {
            try
            {
                using var parent = Process.GetProcessById(parentPid);
                await parent.WaitForExitAsync();
                return;
            }
            catch (ArgumentException)
            {
                // No process carries this id: the parent is already gone.
                return;
            }
            catch
            {
                // The parent exists but cannot be waited on directly; fall through to polling.
            }

            while (true)
            {
                try
                {
                    using var probe = Process.GetProcessById(parentPid);
                    if (probe.HasExited) return;
                }
                catch (ArgumentException)
                {
                    return;
                }
                catch
                {
                    // Transient query failure - keep watching rather than exiting on a guess.
                }

                await Task.Delay(ParentPollIntervalMs);
            }
        }

        /// <summary>
        /// Tears the overlay down and terminates the companion. Teardown is both time-bounded and
        /// exception-proof: a wedged or already-disposed overlay must never be able to keep an
        /// orphaned companion (and its topmost click-through window) alive after its host is gone.
        /// </summary>
        private static void ExitAfterParentLoss(OverlayController overlay)
        {
            try
            {
                Task.Run(() => overlay.Dispose()).Wait(OverlayTeardownTimeoutMs);
            }
            catch
            {
                // Deliberately swallowed - the Exit below is the guarantee that matters.
            }

            Environment.Exit(0);
        }

        private static int RunIpcLoop(string[] args)
        {
            int parentPid = 0;
            for (int i = 1; i < args.Length; i++)
            {
                if ((args[i] == "--parent-pid" || args[i] == "-p") && i + 1 < args.Length)
                {
                    int.TryParse(args[i + 1], out parentPid);
                }
            }

            using var overlay = new OverlayController();

            if (parentPid > 0)
            {
                _ = Task.Run(async () =>
                {
                    await WaitForParentExitAsync(parentPid);
                    ExitAfterParentLoss(overlay);
                });
            }

            string? line;

            while ((line = Console.ReadLine()) != null)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;

                try
                {
                    using var doc = JsonDocument.Parse(line);
                    var root = doc.RootElement;
                    string method = root.GetProperty("method").GetString() ?? string.Empty;
                    string id = root.TryGetProperty("id", out var idProp) ? idProp.GetString() ?? "" : "";

                    switch (method)
                    {
                        case "inspectForeground":
                        {
                            var inspection = UiaEngine.InspectForegroundWindow();
                            var compat = UiaEngine.EvaluateCompatibility(inspection);
                            var resp = new { id, result = new { inspection, compatibility = compat } };
                            Console.WriteLine(JsonSerializer.Serialize(resp));
                            break;
                        }
                        case "showHighlight":
                        {
                            var wordBounds = new List<ScreenRectModel>();
                            if (root.TryGetProperty("params", out var p) && p.TryGetProperty("wordRects", out var wRects))
                            {
                                foreach (var r in wRects.EnumerateArray())
                                {
                                    wordBounds.Add(new ScreenRectModel(
                                        r.GetProperty("x").GetDouble(),
                                        r.GetProperty("y").GetDouble(),
                                        r.GetProperty("width").GetDouble(),
                                        r.GetProperty("height").GetDouble()
                                    ));
                                }
                            }
                            overlay.ShowHighlights(null, wordBounds);
                            Console.WriteLine(JsonSerializer.Serialize(new { id, result = "ok" }));
                            break;
                        }
                        case "clearHighlight":
                        {
                            overlay.Clear();
                            Console.WriteLine(JsonSerializer.Serialize(new { id, result = "ok" }));
                            break;
                        }
                        case "ping":
                        {
                            Console.WriteLine(JsonSerializer.Serialize(new { id, result = "pong" }));
                            break;
                        }
                        default:
                            Console.WriteLine(JsonSerializer.Serialize(new { id, error = $"Unknown method {method}" }));
                            break;
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine(JsonSerializer.Serialize(new { error = ex.Message }));
                }
            }

            return 0;
        }
    }
}
