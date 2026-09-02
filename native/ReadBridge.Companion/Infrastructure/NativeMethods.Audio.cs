using System;
using System.Runtime.InteropServices;

namespace ReadBridge.Companion.Infrastructure
{
    /// <summary>
    /// WinMM waveOut interop. This is the audio-output half of <see cref="NativeMethods"/>.
    ///
    /// waveOut is used rather than a third-party audio library because it is the smallest platform
    /// API that satisfies the playback contract ReadBridge actually needs: waveOutPause /
    /// waveOutRestart suspend and resume the SAME open device handle, and waveOutGetPosition
    /// reports a cursor that is frozen for the whole duration of a pause and then continues -
    /// rather than restarting - on resume. No managed audio dependency is required.
    /// </summary>
    internal static partial class NativeMethods
    {
        public const uint WAVE_MAPPER = 0xFFFFFFFF;
        public const uint CALLBACK_NULL = 0x00000000;
        public const uint WAVE_FORMAT_PCM = 0x0001;

        public const uint WHDR_DONE = 0x00000001;

        public const uint TIME_BYTES = 0x0004;

        public const uint MMSYSERR_NOERROR = 0;

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        public struct WAVEFORMATEX
        {
            public ushort wFormatTag;
            public ushort nChannels;
            public uint nSamplesPerSec;
            public uint nAvgBytesPerSec;
            public ushort nBlockAlign;
            public ushort wBitsPerSample;
            public ushort cbSize;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct WAVEHDR
        {
            public IntPtr lpData;
            public uint dwBufferLength;
            public uint dwBytesRecorded;
            public IntPtr dwUser;
            public uint dwFlags;
            public uint dwLoops;
            public IntPtr lpNext;
            public IntPtr reserved;
        }

        /// <summary>
        /// MMTIME's payload is a union; only the first member is read here, and only after
        /// confirming the device honoured the requested <c>wType</c>.
        /// </summary>
        [StructLayout(LayoutKind.Sequential)]
        public struct MMTIME
        {
            public uint wType;
            public uint payload0;
            public uint payload1;
        }

        [DllImport("winmm.dll")]
        public static extern uint waveOutGetNumDevs();

        [DllImport("winmm.dll")]
        public static extern uint waveOutOpen(
            out IntPtr phwo, uint uDeviceID, ref WAVEFORMATEX pwfx,
            IntPtr dwCallback, IntPtr dwInstance, uint fdwOpen);

        [DllImport("winmm.dll")]
        public static extern uint waveOutPrepareHeader(IntPtr hwo, IntPtr pwh, uint cbwh);

        [DllImport("winmm.dll")]
        public static extern uint waveOutUnprepareHeader(IntPtr hwo, IntPtr pwh, uint cbwh);

        [DllImport("winmm.dll")]
        public static extern uint waveOutWrite(IntPtr hwo, IntPtr pwh, uint cbwh);

        [DllImport("winmm.dll")]
        public static extern uint waveOutPause(IntPtr hwo);

        [DllImport("winmm.dll")]
        public static extern uint waveOutRestart(IntPtr hwo);

        [DllImport("winmm.dll")]
        public static extern uint waveOutReset(IntPtr hwo);

        [DllImport("winmm.dll")]
        public static extern uint waveOutClose(IntPtr hwo);

        [DllImport("winmm.dll")]
        public static extern uint waveOutGetPosition(IntPtr hwo, ref MMTIME pmmt, uint cbmmt);
    }
}
