using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace ReadBridge.Companion.Models
{
    public sealed class ScreenRectModel
    {
        [JsonPropertyName("x")]
        public double X { get; set; }

        [JsonPropertyName("y")]
        public double Y { get; set; }

        [JsonPropertyName("width")]
        public double Width { get; set; }

        [JsonPropertyName("height")]
        public double Height { get; set; }

        public ScreenRectModel() { }

        public ScreenRectModel(double x, double y, double width, double height)
        {
            X = x;
            Y = y;
            Width = width;
            Height = height;
        }

        public override string ToString() => $"[X={X:F1}, Y={Y:F1}, W={Width:F1}, H={Height:F1}]";
    }

    public sealed class TextRangeGeometryModel
    {
        [JsonPropertyName("rects")]
        public List<ScreenRectModel> Rects { get; set; } = new();

        [JsonPropertyName("isClipped")]
        public bool IsClipped { get; set; }

        [JsonPropertyName("text")]
        public string Text { get; set; } = string.Empty;
    }

    public sealed class DiscoveredTextProviderInfo
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = string.Empty;

        [JsonPropertyName("automationId")]
        public string AutomationId { get; set; } = string.Empty;

        [JsonPropertyName("className")]
        public string ClassName { get; set; } = string.Empty;

        [JsonPropertyName("controlType")]
        public string ControlType { get; set; } = string.Empty;

        [JsonPropertyName("frameworkId")]
        public string FrameworkId { get; set; } = string.Empty;

        [JsonPropertyName("supportsTextPattern")]
        public bool SupportsTextPattern { get; set; }

        [JsonPropertyName("supportsTextPattern2")]
        public bool SupportsTextPattern2 { get; set; }

        [JsonPropertyName("supportsSelection")]
        public bool SupportsSelection { get; set; }

        [JsonPropertyName("hasActiveSelection")]
        public bool HasActiveSelection { get; set; }

        [JsonPropertyName("selectionText")]
        public string? SelectionText { get; set; }

        [JsonPropertyName("documentTextSample")]
        public string? DocumentTextSample { get; set; }

        [JsonPropertyName("documentLength")]
        public int DocumentLength { get; set; }

        [JsonPropertyName("visibleRangesCount")]
        public int VisibleRangesCount { get; set; }

        [JsonPropertyName("sampleWordCount")]
        public int SampleWordCount { get; set; }

        [JsonPropertyName("wordBoundingRectPrecision")]
        public string WordBoundingRectPrecision { get; set; } = "Unknown";
    }

    public sealed class WindowInspectionResult
    {
        [JsonPropertyName("windowHandle")]
        public string WindowHandle { get; set; } = string.Empty;

        [JsonPropertyName("processId")]
        public uint ProcessId { get; set; }

        [JsonPropertyName("processName")]
        public string ProcessName { get; set; } = string.Empty;

        [JsonPropertyName("windowTitle")]
        public string WindowTitle { get; set; } = string.Empty;

        [JsonPropertyName("windowClassName")]
        public string WindowClassName { get; set; } = string.Empty;

        [JsonPropertyName("windowBounds")]
        public ScreenRectModel? WindowBounds { get; set; }

        [JsonPropertyName("providers")]
        public List<DiscoveredTextProviderInfo> Providers { get; set; } = new();

        [JsonPropertyName("primaryProvider")]
        public DiscoveredTextProviderInfo? PrimaryProvider { get; set; }
    }

    public sealed class ApplicationCompatibilityRecord
    {
        [JsonPropertyName("application")]
        public string Application { get; set; } = string.Empty;

        [JsonPropertyName("version")]
        public string Version { get; set; } = string.Empty;

        [JsonPropertyName("processName")]
        public string ProcessName { get; set; } = string.Empty;

        [JsonPropertyName("uiaProviderDiscovered")]
        public string UiaProviderDiscovered { get; set; } = string.Empty;

        [JsonPropertyName("textPattern")]
        public bool TextPattern { get; set; }

        [JsonPropertyName("textPattern2")]
        public bool TextPattern2 { get; set; }

        [JsonPropertyName("selectionCapture")]
        public string SelectionCapture { get; set; } = string.Empty;

        [JsonPropertyName("documentVisibleText")]
        public string DocumentVisibleText { get; set; } = string.Empty;

        [JsonPropertyName("characterNavigation")]
        public string CharacterNavigation { get; set; } = string.Empty;

        [JsonPropertyName("wordNavigation")]
        public string WordNavigation { get; set; } = string.Empty;

        [JsonPropertyName("boundingRectangles")]
        public string BoundingRectangles { get; set; } = string.Empty;

        [JsonPropertyName("rectanglePrecision")]
        public string RectanglePrecision { get; set; } = string.Empty;

        [JsonPropertyName("windowMoveTracking")]
        public string WindowMoveTracking { get; set; } = string.Empty;

        [JsonPropertyName("dpiBehavior")]
        public string DpiBehavior { get; set; } = string.Empty;

        [JsonPropertyName("observedFailures")]
        public string ObservedFailures { get; set; } = string.Empty;

        [JsonPropertyName("recommendedCapabilityLevel")]
        public string RecommendedCapabilityLevel { get; set; } = string.Empty;
    }
}
