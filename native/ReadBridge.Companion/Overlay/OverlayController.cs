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
            try
            {
                _dispatcher = Dispatcher.CurrentDispatcher;
                _window = new HighlightOverlayWindow();
                _window.Show();
            }
            catch (Exception ex)
            {
                // Creating a layered, click-through, full-virtual-screen window can legitimately
                // fail (no interactive window station, composition unavailable, session 0). An
                // unhandled exception on this background thread would terminate the entire
                // companion; degrade to a no-overlay companion instead, which still serves IPC -
                // ShowHighlights/Clear already no-op while _window is null.
                _window = null;
                Console.Error.WriteLine($"[ReadBridge] Overlay unavailable; continuing without it: {ex.Message}");
                return;
            }
            finally
            {
                // Always release the constructor, on both the success and failure paths, so a
                // failed overlay cannot stall startup for the full timeout.
                _initEvent.Set();
            }

            lock (_disposeLock)
            {
                // Dispose can land between the _dispatcher assignment above and this point - for
                // instance when the host dies during a slow WPF cold start. Running a dispatcher
                // that has already been told to shut down throws.
                if (_disposed) return;
            }

            try
            {
                Dispatcher.Run();
            }
            catch (Exception ex)
            {
                // Same rule as above: this thread must never take the process down with it.
                Console.Error.WriteLine($"[ReadBridge] Overlay message pump ended: {ex.Message}");
            }
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

                // _initEvent is deliberately NOT disposed. If overlay startup overran the
                // constructor's timeout, the overlay thread is still on its way to Set() it;
                // disposing here would raise ObjectDisposedException on that thread and kill the
                // process. A ManualResetEventSlim whose WaitHandle was never taken holds no OS
                // handle, so leaving it is free.
            }
        }
    }
}
