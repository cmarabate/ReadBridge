using System;
using ReadBridge.Companion.Infrastructure;

namespace ReadBridge.Companion.Audio
{
    /// <summary>
    /// Owns at most ONE current playback session and fences every command by session id.
    ///
    /// The companion is a shared device surface reached over a single IPC channel, so a late
    /// command from an abandoned read - a pause that raced a stop, a completion from a session the
    /// host already replaced - must never reach whatever is playing now. Every operation names the
    /// session it believes it is addressing, and anything that is not the current session is
    /// refused with <c>staleSession</c> rather than being applied to the current one.
    /// </summary>
    public sealed class AudioPlaybackHost : IDisposable
    {
        private readonly object _gate = new();
        private WaveOutPlaybackSession? _current;
        private bool _disposed;

        /// <summary>Fired when a session drains naturally. Carries the id so callers can fence it.</summary>
        public event Action<string, long>? SessionCompleted;

        public string? CurrentSessionId { get { lock (_gate) { return _current?.SessionId; } } }

        public bool HasOutputDevice => NativeMethods.waveOutGetNumDevs() > 0;

        /// <summary>
        /// Opens a session, replacing (and stopping) any existing one. Reopening the same id is
        /// refused: a caller that believes it is starting a fresh read must get a fresh session.
        /// </summary>
        public PlaybackCommandResult Open(string sessionId, int sampleRate, int channels, int bitDepth)
        {
            WaveOutPlaybackSession? replaced = null;
            WaveOutPlaybackSession created;

            lock (_gate)
            {
                if (_disposed)
                {
                    return new PlaybackCommandResult(false, "hostDisposed", PlaybackSessionState.Stopped, 0, 0);
                }
                if (_current != null && _current.SessionId == sessionId)
                {
                    return new PlaybackCommandResult(false, "sessionIdInUse", _current.State, _current.PositionMs, _current.QueuedBytes);
                }

                replaced = _current;
                _current = null;

                try
                {
                    created = new WaveOutPlaybackSession(sessionId, sampleRate, channels, bitDepth);
                }
                catch (ArgumentException ex)
                {
                    // Dispose the replaced session anyway: it is no longer reachable by any caller.
                    replaced?.Dispose();
                    return new PlaybackCommandResult(false, $"invalidFormat:{ex.ParamName}", PlaybackSessionState.Stopped, 0, 0);
                }

                created.Completed += OnSessionCompleted;
                _current = created;
            }

            // Outside the lock: disposing a session joins its monitor thread.
            replaced?.Dispose();

            return new PlaybackCommandResult(true, null, created.State, 0, 0);
        }

        public PlaybackWriteResult Write(string sessionId, byte[] pcm)
        {
            var session = Resolve(sessionId);
            if (session == null)
            {
                return new PlaybackWriteResult(false, "staleSession", PlaybackSessionState.Stopped, 0, 0, 0);
            }
            return session.Write(pcm);
        }

        public PlaybackCommandResult CompleteInput(string sessionId) => Command(sessionId, s => s.CompleteInput());

        public PlaybackCommandResult Pause(string sessionId) => Command(sessionId, s => s.Pause());

        public PlaybackCommandResult Resume(string sessionId) => Command(sessionId, s => s.Resume());

        public PlaybackCommandResult Status(string sessionId) => Command(sessionId, s => s.Status());

        /// <summary>Stops and releases the named session, clearing current ownership.</summary>
        public PlaybackCommandResult Stop(string sessionId)
        {
            WaveOutPlaybackSession? session;
            lock (_gate)
            {
                if (_current == null || _current.SessionId != sessionId)
                {
                    return new PlaybackCommandResult(false, "staleSession", PlaybackSessionState.Stopped, 0, 0);
                }
                session = _current;
                _current = null;
            }

            var result = session.Stop();
            session.Completed -= OnSessionCompleted;
            session.Dispose();
            return result;
        }

        public void Dispose()
        {
            WaveOutPlaybackSession? session;
            lock (_gate)
            {
                if (_disposed) return;
                _disposed = true;
                session = _current;
                _current = null;
            }

            if (session != null)
            {
                session.Completed -= OnSessionCompleted;
                session.Dispose();
            }
            SessionCompleted = null;
        }

        private WaveOutPlaybackSession? Resolve(string sessionId)
        {
            lock (_gate)
            {
                return _current != null && _current.SessionId == sessionId ? _current : null;
            }
        }

        private PlaybackCommandResult Command(string sessionId, Func<WaveOutPlaybackSession, PlaybackCommandResult> op)
        {
            var session = Resolve(sessionId);
            if (session == null)
            {
                return new PlaybackCommandResult(false, "staleSession", PlaybackSessionState.Stopped, 0, 0);
            }
            return op(session);
        }

        private void OnSessionCompleted(string sessionId, long positionMs)
        {
            lock (_gate)
            {
                // A session that is no longer current completed after being replaced. Its audio is
                // already released; announcing it would let a stale completion end a live read.
                if (_current == null || _current.SessionId != sessionId) return;
            }

            // The completed session stays current until it is stopped or replaced, so a later
            // status or resume gets the honest `completed` terminal answer rather than a
            // `staleSession` answer that cannot be told apart from addressing the wrong read.
            SessionCompleted?.Invoke(sessionId, positionMs);
        }
    }
}
