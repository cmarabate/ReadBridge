using System;
using System.Collections.Generic;
using System.Threading;
using System.Windows;
using System.Windows.Threading;
using ReadBridge.Companion.Infrastructure;
using ReadBridge.Companion.Models;

namespace ReadBridge.Companion.Overlay
{
    public sealed class OverlayController : IDisposable
    {
        private Thread? _overlayThread;
        private HighlightOverlayWindow? _window;
        private Dispatcher? _dispatcher;
        private readonly ManualResetEventSlim _initEvent = new(false);
        private readonly object _disposeLock = new();
        private volatile bool _disposed;

        public OverlayController()
        {
            _overlayThread = new Thread(RunOverlayMessagePump)
            {
                IsBackground = true,
                Name = "ReadBridge.OverlayThread"
            };
            _overlayThread.SetApartmentState(ApartmentState.STA);
            _overlayThread.Start();

            _initEvent.Wait(3000);
        }

        private void RunOverlayMessagePump()
        {
            _dispatcher = Dispatcher.CurrentDispatcher;
            _window = new HighlightOverlayWindow();
            _window.Show();

            _initEvent.Set();
            Dispatcher.Run();
        }

        public void ShowHighlights(List<ScreenRectModel>? sentenceBounds, List<ScreenRectModel>? wordBounds)
        {
            if (_disposed || _dispatcher == null || _window == null) return;

            _dispatcher.BeginInvoke(DispatcherPriority.Render, () =>
            {
                _window.UpdateHighlights(sentenceBounds, wordBounds);
            });
        }

        public void Clear()
        {
            if (_disposed || _dispatcher == null || _window == null) return;

            _dispatcher.BeginInvoke(DispatcherPriority.Render, () =>
            {
                _window.ClearHighlights();
            });
        }

        /// <summary>
        /// Idempotent and safe to call concurrently. The companion disposes the overlay from two
        /// places that can race when the host dies: the parent watchdog thread and the main stdio
        /// loop unwinding its <c>using</c>. Without the lock both could pass the guard together and
        /// double-shutdown the dispatcher or the init event.
        /// </summary>
        public void Dispose()
        {
            lock (_disposeLock)
            {
                if (_disposed) return;

                // Set first so ShowHighlights/Clear stop queueing work onto a dying dispatcher.
                _disposed = true;

                try
                {
                    if (_dispatcher != null && !_dispatcher.HasShutdownStarted)
                    {
                        _dispatcher.InvokeShutdown();
                    }
                }
                catch (InvalidOperationException)
                {
                    // Dispatcher already shutting down on its own thread.
                }

                _initEvent.Dispose();
            }
        }
    }
}
