using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using ReadBridge.Companion.Infrastructure;

namespace ReadBridge.Companion.Audio
{
    public enum PlaybackSessionState
    {
        Created,
        Playing,
        Paused,
        Completed,
        Stopped,
    }

    public sealed record PlaybackWriteResult(
        bool Accepted,
        string? Reason,
        PlaybackSessionState State,
        long PositionMs,
        int QueuedBytes,
        int MaxQueuedBytes);

    public sealed record PlaybackCommandResult(
        bool Ok,
        string? Reason,
        PlaybackSessionState State,
        long PositionMs,
        int QueuedBytes);

    /// <summary>
    /// One resumable audio playback session over a single WinMM waveOut device handle.
    ///
    /// The device handle is the session identity: <see cref="Pause"/> and <see cref="Resume"/>
    /// suspend and restart THAT handle, so the device's own sample cursor is what survives a pause.
    /// Nothing is reopened, requeued, or replayed on resume, which is why the cursor continues
    /// instead of restarting.
    ///
    /// Lifecycle: Created -> Playing -> (Paused &lt;-&gt; Playing)* -> Completed | Stopped.
    /// Completed and Stopped are terminal; every operation on a terminal session fails closed.
    /// The session becomes Playing on its first ACCEPTED write, never merely on construction -
    /// so a caller can never truthfully claim playback before the device has taken audio.
    /// </summary>
    public sealed class WaveOutPlaybackSession : IDisposable
    {
        /// <summary>
        /// Bounded paused-buffering policy. Audio already generated upstream keeps being accepted
        /// while paused, up to this much un-drained audio; beyond it a write is REJECTED rather
        /// than dropped or truncated, so a long pause cannot grow memory without bound and cannot
        /// silently lose speech. Upstream flow control (suspending synthesis while paused) is a
        /// later slice; this bound is the interim guarantee.
        /// </summary>
        public const int DefaultMaxQueuedSeconds = 32;

        private readonly object _gate = new();
        private readonly List<(IntPtr Header, IntPtr Data, int Length)> _pending = new();
        private readonly int _headerSize = Marshal.SizeOf<NativeMethods.WAVEHDR>();

        private readonly int _bytesPerSecond;
        private readonly int _blockAlign;
        private NativeMethods.WAVEFORMATEX _format;

        private IntPtr _hWaveOut = IntPtr.Zero;
        private PlaybackSessionState _state = PlaybackSessionState.Created;
        private bool _inputComplete;
        private bool _disposed;
        private int _queuedBytes;
        private long _finalPositionMs;
        private Thread? _monitor;

        public string SessionId { get; }
        public int MaxQueuedBytes { get; }

        /// <summary>Raised once, off the caller's thread, when the session drains naturally.</summary>
        public event Action<string, long>? Completed;

        public WaveOutPlaybackSession(string sessionId, int sampleRate, int channels, int bitDepth)
        {
            if (string.IsNullOrWhiteSpace(sessionId)) throw new ArgumentException("sessionId is required", nameof(sessionId));
            if (sampleRate <= 0) throw new ArgumentOutOfRangeException(nameof(sampleRate));
            if (channels <= 0) throw new ArgumentOutOfRangeException(nameof(channels));
            if (bitDepth != 8 && bitDepth != 16 && bitDepth != 24 && bitDepth != 32)
                throw new ArgumentOutOfRangeException(nameof(bitDepth), $"unsupported PCM bit depth {bitDepth}");

            SessionId = sessionId;
            _blockAlign = channels * (bitDepth / 8);
            _bytesPerSecond = sampleRate * _blockAlign;
            MaxQueuedBytes = _bytesPerSecond * DefaultMaxQueuedSeconds;

            _format = new NativeMethods.WAVEFORMATEX
            {
                wFormatTag = (ushort)NativeMethods.WAVE_FORMAT_PCM,
                nChannels = (ushort)channels,
                nSamplesPerSec = (uint)sampleRate,
                nAvgBytesPerSec = (uint)_bytesPerSecond,
                nBlockAlign = (ushort)_blockAlign,
                wBitsPerSample = (ushort)bitDepth,
                cbSize = 0,
            };
        }

        public PlaybackSessionState State { get { lock (_gate) { return _state; } } }

        public long PositionMs { get { lock (_gate) { return ReadPositionMsLocked(); } } }

        public int QueuedBytes { get { lock (_gate) { return _queuedBytes; } } }

        public PlaybackCommandResult Status()
        {
            lock (_gate)
            {
                return new PlaybackCommandResult(true, null, _state, ReadPositionMsLocked(), _queuedBytes);
            }
        }

        public PlaybackWriteResult Write(byte[] pcm)
        {
            if (pcm is null) throw new ArgumentNullException(nameof(pcm));

            lock (_gate)
            {
                if (IsTerminalLocked())
                {
                    return new PlaybackWriteResult(false, "terminalState", _state, ReadPositionMsLocked(), _queuedBytes, MaxQueuedBytes);
                }
                if (_inputComplete)
                {
                    return new PlaybackWriteResult(false, "inputComplete", _state, ReadPositionMsLocked(), _queuedBytes, MaxQueuedBytes);
                }
                if (pcm.Length == 0)
                {
                    // An empty chunk is not an error and is not audio; it must not start playback.
                    return new PlaybackWriteResult(true, "empty", _state, ReadPositionMsLocked(), _queuedBytes, MaxQueuedBytes);
                }
                if (pcm.Length % _blockAlign != 0)
                {
                    return new PlaybackWriteResult(false, "misalignedFrame", _state, ReadPositionMsLocked(), _queuedBytes, MaxQueuedBytes);
                }
                if (_queuedBytes + pcm.Length > MaxQueuedBytes)
                {
                    return new PlaybackWriteResult(false, "queueFull", _state, ReadPositionMsLocked(), _queuedBytes, MaxQueuedBytes);
                }

                if (_hWaveOut == IntPtr.Zero)
                {
                    uint opened = NativeMethods.waveOutOpen(
                        out _hWaveOut, NativeMethods.WAVE_MAPPER, ref _format,
                        IntPtr.Zero, IntPtr.Zero, NativeMethods.CALLBACK_NULL);
                    if (opened != NativeMethods.MMSYSERR_NOERROR)
                    {
                        _hWaveOut = IntPtr.Zero;
                        return new PlaybackWriteResult(false, $"deviceOpenFailed:{opened}", _state, 0, _queuedBytes, MaxQueuedBytes);
                    }
                }

                IntPtr data = Marshal.AllocHGlobal(pcm.Length);
                Marshal.Copy(pcm, 0, data, pcm.Length);
                IntPtr header = Marshal.AllocHGlobal(_headerSize);
                Marshal.StructureToPtr(
                    new NativeMethods.WAVEHDR { lpData = data, dwBufferLength = (uint)pcm.Length },
                    header, false);

                uint prepared = NativeMethods.waveOutPrepareHeader(_hWaveOut, header, (uint)_headerSize);
                if (prepared != NativeMethods.MMSYSERR_NOERROR)
                {
                    Marshal.FreeHGlobal(header);
                    Marshal.FreeHGlobal(data);
                    return new PlaybackWriteResult(false, $"prepareFailed:{prepared}", _state, ReadPositionMsLocked(), _queuedBytes, MaxQueuedBytes);
                }

                uint written = NativeMethods.waveOutWrite(_hWaveOut, header, (uint)_headerSize);
                if (written != NativeMethods.MMSYSERR_NOERROR)
                {
                    NativeMethods.waveOutUnprepareHeader(_hWaveOut, header, (uint)_headerSize);
                    Marshal.FreeHGlobal(header);
                    Marshal.FreeHGlobal(data);
                    return new PlaybackWriteResult(false, $"writeFailed:{written}", _state, ReadPositionMsLocked(), _queuedBytes, MaxQueuedBytes);
                }

                _pending.Add((header, data, pcm.Length));
                _queuedBytes += pcm.Length;

                // A write while Paused queues into the device but must NOT resume it; only an
                // explicit Resume may un-pause a paused session.
                if (_state == PlaybackSessionState.Created)
                {
                    _state = PlaybackSessionState.Playing;
                }

                StartMonitorLocked();
                return new PlaybackWriteResult(true, null, _state, ReadPositionMsLocked(), _queuedBytes, MaxQueuedBytes);
            }
        }

        public PlaybackCommandResult CompleteInput()
        {
            lock (_gate)
            {
                if (IsTerminalLocked())
                {
                    return new PlaybackCommandResult(false, "terminalState", _state, ReadPositionMsLocked(), _queuedBytes);
                }
                _inputComplete = true;
                StartMonitorLocked();
                return new PlaybackCommandResult(true, null, _state, ReadPositionMsLocked(), _queuedBytes);
            }
        }

        public PlaybackCommandResult Pause()
        {
            lock (_gate)
            {
                if (IsTerminalLocked())
                {
                    return new PlaybackCommandResult(false, "terminalState", _state, ReadPositionMsLocked(), _queuedBytes);
                }
                if (_state == PlaybackSessionState.Paused)
                {
                    return new PlaybackCommandResult(true, "alreadyPaused", _state, ReadPositionMsLocked(), _queuedBytes);
                }
                if (_state == PlaybackSessionState.Created)
                {
                    // Nothing has been handed to the device yet, so there is nothing to suspend.
                    // Reporting success here would let a caller claim a pause that never happened.
                    return new PlaybackCommandResult(false, "notStarted", _state, ReadPositionMsLocked(), _queuedBytes);
                }

                uint r = NativeMethods.waveOutPause(_hWaveOut);
                if (r != NativeMethods.MMSYSERR_NOERROR)
                {
                    return new PlaybackCommandResult(false, $"deviceError:{r}", _state, ReadPositionMsLocked(), _queuedBytes);
                }

                _state = PlaybackSessionState.Paused;
                return new PlaybackCommandResult(true, null, _state, ReadPositionMsLocked(), _queuedBytes);
            }
        }

        public PlaybackCommandResult Resume()
        {
            lock (_gate)
            {
                if (IsTerminalLocked())
                {
                    return new PlaybackCommandResult(false, "terminalState", _state, ReadPositionMsLocked(), _queuedBytes);
                }
                if (_state == PlaybackSessionState.Playing)
                {
                    return new PlaybackCommandResult(true, "alreadyPlaying", _state, ReadPositionMsLocked(), _queuedBytes);
                }
                if (_state != PlaybackSessionState.Paused)
                {
                    return new PlaybackCommandResult(false, "notPaused", _state, ReadPositionMsLocked(), _queuedBytes);
                }

                uint r = NativeMethods.waveOutRestart(_hWaveOut);
                if (r != NativeMethods.MMSYSERR_NOERROR)
                {
                    return new PlaybackCommandResult(false, $"deviceError:{r}", _state, ReadPositionMsLocked(), _queuedBytes);
                }

                _state = PlaybackSessionState.Playing;
                return new PlaybackCommandResult(true, null, _state, ReadPositionMsLocked(), _queuedBytes);
            }
        }

        /// <summary>Terminal. Abandons queued audio and releases the device.</summary>
        public PlaybackCommandResult Stop()
        {
            lock (_gate)
            {
                if (_state == PlaybackSessionState.Stopped)
                {
                    return new PlaybackCommandResult(true, "alreadyStopped", _state, _finalPositionMs, 0);
                }
                if (_state == PlaybackSessionState.Completed)
                {
                    return new PlaybackCommandResult(false, "terminalState", _state, _finalPositionMs, 0);
                }

                _finalPositionMs = ReadPositionMsLocked();
                ReleaseDeviceLocked();
                _state = PlaybackSessionState.Stopped;
                return new PlaybackCommandResult(true, null, _state, _finalPositionMs, 0);
            }
        }

        public void Dispose()
        {
            Thread? monitor;
            lock (_gate)
            {
                if (_disposed) return;
                _disposed = true;
                if (!IsTerminalLocked())
                {
                    _finalPositionMs = ReadPositionMsLocked();
                    _state = PlaybackSessionState.Stopped;
                }
                ReleaseDeviceLocked();
                monitor = _monitor;
                _monitor = null;
            }

            // Bounded: the monitor loop polls at MonitorIntervalMs and exits on _disposed. Joining
            // is skipped when Dispose was reached FROM the monitor thread (a Completed handler that
            // disposes its own session), where Join would throw rather than wait.
            if (monitor != null && monitor != Thread.CurrentThread)
            {
                monitor.Join(2000);
            }
            Completed = null;
        }

        // ---- internals -------------------------------------------------------------------

        private const int MonitorIntervalMs = 20;

        private bool IsTerminalLocked() =>
            _state == PlaybackSessionState.Completed || _state == PlaybackSessionState.Stopped;

        private long ReadPositionMsLocked()
        {
            if (_hWaveOut == IntPtr.Zero) return _finalPositionMs;

            var mmt = new NativeMethods.MMTIME { wType = NativeMethods.TIME_BYTES };
            uint r = NativeMethods.waveOutGetPosition(_hWaveOut, ref mmt, (uint)Marshal.SizeOf<NativeMethods.MMTIME>());
            if (r != NativeMethods.MMSYSERR_NOERROR || mmt.wType != NativeMethods.TIME_BYTES)
            {
                // Never invent a cursor: report the last value we could actually observe.
                return _finalPositionMs;
            }

            _finalPositionMs = (long)(mmt.payload0 * 1000.0 / _bytesPerSecond);
            return _finalPositionMs;
        }

        private void StartMonitorLocked()
        {
            if (_monitor != null || _disposed) return;
            _monitor = new Thread(MonitorLoop)
            {
                IsBackground = true,
                Name = $"readbridge-playback-{SessionId}",
            };
            _monitor.Start();
        }

        private void MonitorLoop()
        {
            while (true)
            {
                bool completedNow = false;
                long completedAt = 0;

                lock (_gate)
                {
                    if (_disposed || IsTerminalLocked()) return;

                    ReclaimDoneBuffersLocked();
                    ReadPositionMsLocked();

                    if (_inputComplete && _pending.Count == 0)
                    {
                        completedAt = ReadPositionMsLocked();
                        _finalPositionMs = completedAt;
                        ReleaseDeviceLocked();
                        _state = PlaybackSessionState.Completed;
                        completedNow = true;
                    }
                }

                if (completedNow)
                {
                    // Raised outside the lock: a handler that calls back into this session (or
                    // writes to a serialized transport) must not be able to deadlock the device.
                    Completed?.Invoke(SessionId, completedAt);
                    return;
                }

                Thread.Sleep(MonitorIntervalMs);
            }
        }

        private void ReclaimDoneBuffersLocked()
        {
            if (_hWaveOut == IntPtr.Zero) return;

            for (int i = _pending.Count - 1; i >= 0; i--)
            {
                var (header, data, length) = _pending[i];
                var hdr = Marshal.PtrToStructure<NativeMethods.WAVEHDR>(header);
                if ((hdr.dwFlags & NativeMethods.WHDR_DONE) == 0) continue;

                NativeMethods.waveOutUnprepareHeader(_hWaveOut, header, (uint)_headerSize);
                Marshal.FreeHGlobal(header);
                Marshal.FreeHGlobal(data);
                _pending.RemoveAt(i);
                _queuedBytes -= length;
            }

            if (_queuedBytes < 0) _queuedBytes = 0;
        }

        /// <summary>
        /// Idempotent. waveOutReset marks every queued buffer done so it can be unprepared, which
        /// waveOutClose requires - otherwise close fails and the device handle leaks.
        /// </summary>
        private void ReleaseDeviceLocked()
        {
            if (_hWaveOut == IntPtr.Zero)
            {
                FreePendingLocked();
                return;
            }

            NativeMethods.waveOutReset(_hWaveOut);

            foreach (var (header, data, _) in _pending)
            {
                NativeMethods.waveOutUnprepareHeader(_hWaveOut, header, (uint)_headerSize);
                Marshal.FreeHGlobal(header);
                Marshal.FreeHGlobal(data);
            }
            _pending.Clear();
            _queuedBytes = 0;

            NativeMethods.waveOutClose(_hWaveOut);
            _hWaveOut = IntPtr.Zero;
        }

        private void FreePendingLocked()
        {
            foreach (var (header, data, _) in _pending)
            {
                Marshal.FreeHGlobal(header);
                Marshal.FreeHGlobal(data);
            }
            _pending.Clear();
            _queuedBytes = 0;
        }
    }
}
