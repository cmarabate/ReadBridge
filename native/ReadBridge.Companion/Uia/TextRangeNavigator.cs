using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Interop.UIAutomationClient;
using ReadBridge.Companion.Models;

namespace ReadBridge.Companion.Uia
{
    public static class TextRangeNavigator
    {
        public static List<ScreenRectModel> GetValidBoundingRectangles(
            IUIAutomationTextRange? range,
            tagRECT? containerRect = null)
        {
            var result = new List<ScreenRectModel>();
            if (range == null) return result;

            Array? rawRects = null;
            try
            {
                rawRects = range.GetBoundingRectangles();
            }
            catch (COMException)
            {
                return result;
            }
            catch (Exception)
            {
                return result;
            }

            if (rawRects == null || rawRects.Length == 0) return result;

            int count = rawRects.Length;
            for (int i = 0; i + 3 < count; i += 4)
            {
                double x = Convert.ToDouble(rawRects.GetValue(i));
                double y = Convert.ToDouble(rawRects.GetValue(i + 1));
                double w = Convert.ToDouble(rawRects.GetValue(i + 2));
                double h = Convert.ToDouble(rawRects.GetValue(i + 3));

                if (w <= 0.5 || h <= 0.5) continue;

                // Clip against container if provided
                if (containerRect.HasValue)
                {
                    var c = containerRect.Value;
                    double x1 = Math.Max(x, c.left);
                    double y1 = Math.Max(y, c.top);
                    double x2 = Math.Min(x + w, c.right);
                    double y2 = Math.Min(y + h, c.bottom);

                    if (x2 <= x1 || y2 <= y1) continue; // Completely out of viewport

                    x = x1;
                    y = y1;
                    w = x2 - x1;
                    h = y2 - y1;
                }

                result.Add(new ScreenRectModel(x, y, w, h));
            }

            return result;
        }

        public static IUIAutomationTextRange? TrimTrailingWhitespace(IUIAutomationTextRange? wordRange)
        {
            if (wordRange == null) return null;

            IUIAutomationTextRange trimmed;
            try
            {
                trimmed = wordRange.Clone();
            }
            catch
            {
                return wordRange;
            }

            string text = string.Empty;
            try
            {
                text = trimmed.GetText(-1);
            }
            catch
            {
                return trimmed;
            }

            if (string.IsNullOrEmpty(text)) return trimmed;

            int trailingWhitespaceCount = 0;
            for (int i = text.Length - 1; i >= 0; i--)
            {
                if (char.IsWhiteSpace(text[i]))
                {
                    trailingWhitespaceCount++;
                }
                else
                {
                    break;
                }
            }

            if (trailingWhitespaceCount > 0 && trailingWhitespaceCount < text.Length)
            {
                try
                {
                    trimmed.MoveEndpointByUnit(
                        TextPatternRangeEndpoint.TextPatternRangeEndpoint_End,
                        TextUnit.TextUnit_Character,
                        -trailingWhitespaceCount
                    );
                }
                catch
                {
                    // Fallback to original range if endpoint movement fails on legacy providers
                }
            }

            return trimmed;
        }

        public static List<(string Text, IUIAutomationTextRange Range, List<ScreenRectModel> Bounds)> EnumerateWords(
            IUIAutomationTextRange rootRange,
            tagRECT? containerBounds = null,
            int maxWords = 100)
        {
            var words = new List<(string Text, IUIAutomationTextRange Range, List<ScreenRectModel> Bounds)>();
            if (rootRange == null) return words;

            IUIAutomationTextRange current;
            try
            {
                current = rootRange.Clone();
                current.MoveEndpointByRange(
                    TextPatternRangeEndpoint.TextPatternRangeEndpoint_End,
                    current,
                    TextPatternRangeEndpoint.TextPatternRangeEndpoint_Start
                );
            }
            catch
            {
                return words;
            }

            int safetyCounter = 0;
            while (safetyCounter++ < maxWords)
            {
                try
                {
                    current.ExpandToEnclosingUnit(TextUnit.TextUnit_Word);
                    string rawText = current.GetText(-1);
                    if (string.IsNullOrEmpty(rawText)) break;

                    var trimmed = TrimTrailingWhitespace(current);
                    if (trimmed == null) break;
                    string wordText = trimmed.GetText(-1);
                    var bounds = GetValidBoundingRectangles(trimmed, containerBounds);

                    if (!string.IsNullOrWhiteSpace(wordText))
                    {
                        words.Add((wordText, trimmed, bounds));
                    }

                    int moved = current.Move(TextUnit.TextUnit_Word, 1);
                    if (moved == 0) break;
                }
                catch
                {
                    break;
                }
            }

            return words;
        }
    }
}
