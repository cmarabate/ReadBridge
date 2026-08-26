using System;
using System.Runtime.InteropServices;
using ReadBridge.Companion.Infrastructure;

namespace ReadBridge.Companion.Uia
{
    public sealed class WindowTracker : IDisposable
    {
        private readonly IntPtr _targetHwnd;
        private readonly uint _targetProcessId;
        private readonly Action _onMovedOrResized;
        private readonly NativeMethods.WinEventDelegate _procDelegate;
        private IntPtr _hookLocationChange = IntPtr.Zero;
        private bool _disposed;

        public WindowTracker(IntPtr targetHwnd, Action onMovedOrResized)
        {
            _targetHwnd = targetHwnd;
            _onMovedOrResized = onMovedOrResized;
            _procDelegate = new NativeMethods.WinEventDelegate(WinEventProc);

            NativeMethods.GetWindowThreadProcessId(targetHwnd, out _targetProcessId);

            if (_targetProcessId != 0)
            {
                _hookLocationChange = NativeMethods.SetWinEventHook(
                    NativeMethods.EVENT_OBJECT_LOCATIONCHANGE,
                    NativeMethods.EVENT_OBJECT_LOCATIONCHANGE,
                    IntPtr.Zero,
                    _procDelegate,
                    _targetProcessId,
                    0,
                    NativeMethods.WINEVENT_OUTOFCONTEXT
                );
            }
        }

        private void WinEventProc(
            IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
            int idObject, int idChild, uint dwEventThread, uint dwmsEventTime)
        {
            if (hwnd == _targetHwnd || (hwnd != IntPtr.Zero && NativeMethods.IsChild(_targetHwnd, hwnd)))
            {
                _onMovedOrResized?.Invoke();
            }
        }

        public void Dispose()
        {
            if (!_disposed)
            {
                if (_hookLocationChange != IntPtr.Zero)
                {
                    NativeMethods.UnhookWinEvent(_hookLocationChange);
                    _hookLocationChange = IntPtr.Zero;
                }
                _disposed = true;
            }
        }
    }
}
