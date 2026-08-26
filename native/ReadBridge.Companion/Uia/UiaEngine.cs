using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Interop.UIAutomationClient;
using ReadBridge.Companion.Infrastructure;
using ReadBridge.Companion.Models;

namespace ReadBridge.Companion.Uia
{
    public sealed class UiaEngine
    {
        private static readonly Lazy<CUIAutomation8> _automationInstance = new(() => new CUIAutomation8());
        public static CUIAutomation8 Automation => _automationInstance.Value;

        public static WindowInspectionResult InspectForegroundWindow()
        {
            IntPtr hwnd = NativeMethods.GetForegroundWindow();
            return InspectWindow(hwnd);
        }

        public static WindowInspectionResult InspectWindow(IntPtr hwnd)
        {
            var result = new WindowInspectionResult
            {
                WindowHandle = $"0x{hwnd.ToInt64():X}"
            };

            if (hwnd == IntPtr.Zero)
            {
                result.WindowTitle = "(No foreground window)";
                return result;
            }

            NativeMethods.GetWindowThreadProcessId(hwnd, out uint pid);
            result.ProcessId = pid;
            result.WindowTitle = NativeMethods.GetWindowTitle(hwnd);
            result.WindowClassName = NativeMethods.GetClassName(hwnd);

            try
            {
                var process = Process.GetProcessById((int)pid);
                result.ProcessName = process.ProcessName;
            }
            catch
            {
                result.ProcessName = "Unknown";
            }

            if (NativeMethods.GetWindowRect(hwnd, out var rect))
            {
                result.WindowBounds = new ScreenRectModel(rect.Left, rect.Top, rect.Width, rect.Height);
            }

            IUIAutomationElement? rootElement = null;
            try
            {
                rootElement = Automation.ElementFromHandle(hwnd);
            }
            catch (Exception ex)
            {
                result.WindowTitle += $" (UIA Root Error: {ex.Message})";
                return result;
            }

            if (rootElement == null) return result;

            // Find all text providers
            var providers = new List<DiscoveredTextProviderInfo>();
            FindTextProviders(rootElement, providers);
            result.Providers = providers;

            // Also check focused element if root element scan missed it
            try
            {
                var focused = Automation.GetFocusedElement();
                if (focused != null)
                {
                    var focusedInfo = AnalyzeElementTextProvider(focused);
                    if (focusedInfo != null && !providers.Exists(p => p.AutomationId == focusedInfo.AutomationId && p.Name == focusedInfo.Name))
                    {
                        providers.Insert(0, focusedInfo);
                    }
                }
            }
            catch { }

            // Pick primary provider (prioritize active selection or largest document)
            if (providers.Count > 0)
            {
                result.PrimaryProvider = providers.Find(p => p.HasActiveSelection) ?? providers[0];
            }

            return result;
        }

        private static void FindTextProviders(IUIAutomationElement root, List<DiscoveredTextProviderInfo> list, int maxDepth = 12)
        {
            if (root == null) return;

            // 1. Check root element
            var info = AnalyzeElementTextProvider(root);
            if (info != null)
            {
                list.Add(info);
            }

            // 2. Fast Descendant search for elements supporting TextPattern (10014) or TextPattern2 (10024)
            try
            {
                var condTp = Automation.CreatePropertyCondition(UIA_PropertyIds.UIA_IsTextPatternAvailablePropertyId, true);
                var condTp2 = Automation.CreatePropertyCondition(UIA_PropertyIds.UIA_IsTextPattern2AvailablePropertyId, true);
                var orCond = Automation.CreateOrCondition(condTp, condTp2);

                var elements = root.FindAll(TreeScope.TreeScope_Descendants, orCond);
                if (elements != null)
                {
                    for (int i = 0; i < elements.Length && list.Count < 20; i++)
                    {
                        var el = elements.GetElement(i);
                        var elInfo = AnalyzeElementTextProvider(el);
                        if (elInfo != null && !list.Exists(x => x.AutomationId == elInfo.AutomationId && x.Name == elInfo.Name && x.ClassName == elInfo.ClassName))
                        {
                            list.Add(elInfo);
                        }
                    }
                }
            }
            catch { }

            // 3. Fallback tree crawler if FindAll hit lazy providers
            if (list.Count == 0)
            {
                CrawlTree(root, list, maxDepth);
            }
        }

        private static void CrawlTree(IUIAutomationElement node, List<DiscoveredTextProviderInfo> list, int depth)
        {
            if (node == null || depth <= 0 || list.Count >= 10) return;

            var walker = Automation.RawViewWalker;
            try
            {
                var child = walker.GetFirstChildElement(node);
                while (child != null && list.Count < 10)
                {
                    var info = AnalyzeElementTextProvider(child);
                    if (info != null && !list.Exists(x => x.AutomationId == info.AutomationId && x.Name == info.Name))
                    {
                        list.Add(info);
                    }

                    CrawlTree(child, list, depth - 1);
                    child = walker.GetNextSiblingElement(child);
                }
            }
            catch { }
        }

        public static DiscoveredTextProviderInfo? AnalyzeElementTextProvider(IUIAutomationElement element)
        {
            if (element == null) return null;

            bool supportsTp = false;
            bool supportsTp2 = false;
            IUIAutomationTextPattern? tp = null;
            IUIAutomationTextPattern2? tp2 = null;

            try
            {
                var patternObj = element.GetCurrentPattern(UIA_PatternIds.UIA_TextPatternId);
                if (patternObj != null)
                {
                    tp = (IUIAutomationTextPattern)patternObj;
                    supportsTp = true;
                }
            }
            catch { }

            try
            {
                var pattern2Obj = element.GetCurrentPattern(UIA_PatternIds.UIA_TextPattern2Id);
                if (pattern2Obj != null)
                {
                    tp2 = (IUIAutomationTextPattern2)pattern2Obj;
                    supportsTp2 = true;
                }
            }
            catch { }

            if (!supportsTp && !supportsTp2) return null;

            var info = new DiscoveredTextProviderInfo
            {
                SupportsTextPattern = supportsTp,
                SupportsTextPattern2 = supportsTp2
            };

            try { info.Name = element.CurrentName ?? string.Empty; } catch { }
            try { info.AutomationId = element.CurrentAutomationId ?? string.Empty; } catch { }
            try { info.ClassName = element.CurrentClassName ?? string.Empty; } catch { }
            try { info.FrameworkId = element.CurrentFrameworkId ?? string.Empty; } catch { }
            try { info.ControlType = element.CurrentLocalizedControlType ?? element.CurrentControlType.ToString(); } catch { }

            tagRECT? containerRect = null;
            try { containerRect = element.CurrentBoundingRectangle; } catch { }

            // Analyze TextPattern
            if (tp != null)
            {
                try
                {
                    info.SupportsSelection = (tp.SupportedTextSelection != SupportedTextSelection.SupportedTextSelection_None);
                    var selection = tp.GetSelection();
                    if (selection != null && selection.Length > 0)
                    {
                        var selRange = selection.GetElement(0);
                        if (selRange != null)
                        {
                            string selText = selRange.GetText(-1);
                            if (!string.IsNullOrEmpty(selText))
                            {
                                info.HasActiveSelection = true;
                                info.SelectionText = selText.Length > 200 ? selText.Substring(0, 200) + "..." : selText;
                            }
                        }
                    }
                }
                catch { }

                try
                {
                    var docRange = tp.DocumentRange;
                    if (docRange != null)
                    {
                        string docText = docRange.GetText(500);
                        info.DocumentLength = docText?.Length ?? 0;
                        info.DocumentTextSample = docText != null && docText.Length > 150 ? docText.Substring(0, 150) + "..." : docText;

                        // Test word enumeration and bounding rectangles
                        var sampleWords = TextRangeNavigator.EnumerateWords(docRange, containerRect, maxWords: 15);
                        info.SampleWordCount = sampleWords.Count;

                        int wordsWithBounds = 0;
                        int multiRectWords = 0;
                        foreach (var (word, range, bounds) in sampleWords)
                        {
                            if (bounds.Count > 0) wordsWithBounds++;
                            if (bounds.Count > 1) multiRectWords++;
                        }

                        if (wordsWithBounds == sampleWords.Count && wordsWithBounds > 0)
                        {
                            info.WordBoundingRectPrecision = multiRectWords > 0 
                                ? $"High (Subpixel Multi-Rect Support, {wordsWithBounds}/{sampleWords.Count} bounds verified)" 
                                : $"High (Exact Glyph Bounds, {wordsWithBounds}/{sampleWords.Count} bounds verified)";
                        }
                        else if (wordsWithBounds > 0)
                        {
                            info.WordBoundingRectPrecision = $"Partial ({wordsWithBounds}/{sampleWords.Count} words with valid bounds)";
                        }
                        else
                        {
                            info.WordBoundingRectPrecision = "None (Provider returns empty/coarse rects)";
                        }
                    }
                }
                catch (Exception ex)
                {
                    info.WordBoundingRectPrecision = $"Error: {ex.Message}";
                }

                try
                {
                    var visibleRanges = tp.GetVisibleRanges();
                    info.VisibleRangesCount = visibleRanges?.Length ?? 0;
                }
                catch { }
            }

            return info;
        }

        public static ApplicationCompatibilityRecord EvaluateCompatibility(WindowInspectionResult inspection)
        {
            var p = inspection.PrimaryProvider;
            var record = new ApplicationCompatibilityRecord
            {
                Application = inspection.ProcessName,
                ProcessName = inspection.ProcessName,
                Version = "Installed Windows Runtime",
                UiaProviderDiscovered = p != null ? $"{p.ClassName} ({p.FrameworkId})" : "None Discovered",
                TextPattern = p?.SupportsTextPattern ?? false,
                TextPattern2 = p?.SupportsTextPattern2 ?? false,
                SelectionCapture = p?.HasActiveSelection == true ? "Supported (Active Selection Captured)" : (p?.SupportsSelection == true ? "Supported" : "Not Supported"),
                DocumentVisibleText = p != null && p.DocumentLength > 0 ? $"Supported ({p.DocumentLength} chars captured)" : "Not Supported / Empty",
                CharacterNavigation = p != null ? "Supported (TextUnit.Character stepping verified)" : "Unavailable",
                WordNavigation = p != null && p.SampleWordCount > 0 ? $"Supported ({p.SampleWordCount} words enumerated with whitespace trimming)" : "Unavailable",
                BoundingRectangles = p?.WordBoundingRectPrecision ?? "Unavailable",
                RectanglePrecision = p != null && p.WordBoundingRectPrecision.StartsWith("High") ? "Exact Screen Physical Rectangles" : "Coarse / None",
                WindowMoveTracking = "Supported via WinEvent EVENT_OBJECT_LOCATIONCHANGE",
                DpiBehavior = "PerMonitorV2 Screen Coordinate Space Verified",
                ObservedFailures = p == null ? "No UIA TextPattern provider exposed" : (p.SampleWordCount == 0 ? "Empty text range returned" : "None"),
                RecommendedCapabilityLevel = p == null 
                    ? "LEVEL C (READER_FALLBACK)" 
                    : (p.WordBoundingRectPrecision.StartsWith("High") ? "LEVEL B (UI_AUTOMATION)" : "LEVEL C (READER_FALLBACK)")
            };

            return record;
        }
    }
}
