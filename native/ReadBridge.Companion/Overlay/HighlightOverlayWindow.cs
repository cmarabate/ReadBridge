using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using ReadBridge.Companion.Infrastructure;
using ReadBridge.Companion.Models;

namespace ReadBridge.Companion.Overlay
{
    public class HighlightOverlayWindow : Window
    {
        private readonly Canvas _rootCanvas;
        private readonly List<Rectangle> _sentenceRects = new();
        private readonly List<Rectangle> _wordRects = new();

        public HighlightOverlayWindow()
        {
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            Topmost = true;
            ShowInTaskbar = false;
            ShowActivated = false;
            IsHitTestVisible = false;

            // Cover full virtual screen spanning all monitors
            Left = SystemParameters.VirtualScreenLeft;
            Top = SystemParameters.VirtualScreenTop;
            Width = SystemParameters.VirtualScreenWidth;
            Height = SystemParameters.VirtualScreenHeight;

            _rootCanvas = new Canvas();
            Content = _rootCanvas;
        }

        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            var hwnd = new WindowInteropHelper(this).Handle;

            int exStyle = NativeMethods.GetWindowLongW(hwnd, NativeMethods.GWL_EXSTYLE);
            NativeMethods.SetWindowLongW(
                hwnd,
                NativeMethods.GWL_EXSTYLE,
                exStyle | NativeMethods.WS_EX_LAYERED
                        | NativeMethods.WS_EX_TRANSPARENT
                        | NativeMethods.WS_EX_TOOLWINDOW
                        | NativeMethods.WS_EX_NOACTIVATE
                        | NativeMethods.WS_EX_TOPMOST
            );

            // Exclude from OCR / screen captures
            try
            {
                NativeMethods.SetWindowDisplayAffinity(hwnd, NativeMethods.WDA_EXCLUDEFROMCAPTURE);
            }
            catch { }

            var source = HwndSource.FromHwnd(hwnd);
            source?.AddHook(WndProc);
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == NativeMethods.WM_MOUSEACTIVATE)
            {
                handled = true;
                return (IntPtr)NativeMethods.MA_NOACTIVATE;
            }
            if (msg == NativeMethods.WM_NCHITTEST)
            {
                handled = true;
                return (IntPtr)NativeMethods.HTTRANSPARENT;
            }
            return IntPtr.Zero;
        }

        public void UpdateHighlights(List<ScreenRectModel>? sentenceBounds, List<ScreenRectModel>? wordBounds)
        {
            if (!Dispatcher.CheckAccess())
            {
                Dispatcher.Invoke(() => UpdateHighlights(sentenceBounds, wordBounds));
                return;
            }

            var dpi = VisualTreeHelper.GetDpi(this);
            double dpiX = dpi.DpiScaleX > 0 ? dpi.DpiScaleX : 1.0;
            double dpiY = dpi.DpiScaleY > 0 ? dpi.DpiScaleY : 1.0;

            // Render Sentence Highlights (soft blue tinted boxes)
            RenderRectangles(
                _sentenceRects,
                sentenceBounds,
                dpiX,
                dpiY,
                fillColor: Color.FromArgb(45, 66, 133, 244),
                strokeColor: Color.FromArgb(110, 66, 133, 244),
                radius: 4,
                padding: 2.0
            );

            // Render Word Highlights (vibrant amber rounded box)
            RenderRectangles(
                _wordRects,
                wordBounds,
                dpiX,
                dpiY,
                fillColor: Color.FromArgb(180, 255, 193, 7),
                strokeColor: Color.FromArgb(220, 255, 160, 0),
                radius: 3,
                padding: 1.0
            );
        }

        private void RenderRectangles(
            List<Rectangle> pool,
            List<ScreenRectModel>? bounds,
            double dpiX,
            double dpiY,
            Color fillColor,
            Color strokeColor,
            double radius,
            double padding)
        {
            int requiredCount = bounds?.Count ?? 0;

            // Grow pool if needed
            while (pool.Count < requiredCount)
            {
                var r = new Rectangle
                {
                    RadiusX = radius,
                    RadiusY = radius,
                    StrokeThickness = 1.0
                };
                pool.Add(r);
                _rootCanvas.Children.Add(r);
            }

            // Update active rectangles
            for (int i = 0; i < pool.Count; i++)
            {
                var r = pool[i];
                if (i < requiredCount && bounds != null)
                {
                    var b = bounds[i];
                    double left = (b.X - Left * dpiX) / dpiX - padding;
                    double top = (b.Y - Top * dpiY) / dpiY - padding;
                    double width = b.Width / dpiX + (padding * 2);
                    double height = b.Height / dpiY + (padding * 2);

                    r.Fill = new SolidColorBrush(fillColor);
                    r.Stroke = new SolidColorBrush(strokeColor);
                    Canvas.SetLeft(r, left);
                    Canvas.SetTop(r, top);
                    r.Width = Math.Max(0, width);
                    r.Height = Math.Max(0, height);
                    r.Visibility = Visibility.Visible;
                }
                else
                {
                    r.Visibility = Visibility.Collapsed;
                }
            }
        }

        public void ClearHighlights()
        {
            UpdateHighlights(null, null);
        }
    }
}
