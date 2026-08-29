# TTS Provider Architecture & Protocol Specifications

## 1. Provider Comparison Matrix (2026 Official Documentation)

| Feature / Dimension | Cartesia Sonic-3.5 | ElevenLabs (Flash v2.5 / Turbo v2.5) | OpenAI Audio Speech (`tts-1`) |
| :--- | :--- | :--- | :--- |
| **Model Family** | `sonic-3.5`, `sonic-3.6` | `eleven_flash_v2_5`, `eleven_turbo_v2_5` | `tts-1`, `tts-1-hd` |
| **Protocol** | Bidirectional WebSocket (`/tts/websocket`) | Bidirectional WebSocket (`/stream-input`) | HTTP POST (`/v1/audio/speech`) |
| **Word Alignment Timestamps** | **Native first-class `word_timestamps` array** | Character alignment arrays (`charStartTimesMs`, `charsDurationsMs`) | **None** (Opaque binary audio body) |
| **Context Multiplexing** | Unlimited streams via `context_id` | Up to 5 concurrent streams | None (1 HTTP request = 1 stream) |
| **Cancellation** | Send `{"context_id": "...", "cancel": true}` | Send `close_context` message | Abort TCP connection |
| **Client Token Security** | API Key / Ephemeral token proxy | `POST /v1/single-use-token` ephemeral tokens | API Key |
| **ReadBridge Compatibility** | **Recommended Primary Provider (Level A & B)** | **Recommended Secondary / High-Emotion (Level A & B)** | **Fallback (Level C Only)** |

---

## 2. Cartesia WebSocket Specification

* **Endpoint**: `wss://api.cartesia.ai/tts/websocket`
* **Version Header**: `Cartesia-Version: 2024-06-10`

### Input Payload:
```json
{
  "model_id": "sonic-3.5",
  "transcript": "Hello, world! ",
  "voice": {
    "mode": "id",
    "id": "a0e99841-438c-4a64-b679-ae501e7d6091"
  },
  "output_format": {
    "container": "raw",
    "encoding": "pcm_s16le",
    "sample_rate": 24000
  },
  "context_id": "7b8f9e60-6421-4cf1-b65a-04b78a9c3d12",
  "continue": true,
  "add_timestamps": true
}
```

### Word Timestamps Response:
```json
{
  "type": "timestamps",
  "context_id": "7b8f9e60-6421-4cf1-b65a-04b78a9c3d12",
  "word_timestamps": {
    "words": ["Hello,", "world!"],
    "start": [0.00, 0.45],
    "end": [0.42, 0.91]
  }
}
```

---

## 3. ElevenLabs WebSocket Specification

* **Endpoint**: `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input`

### Alignment Response Payload:
```json
{
  "audio": "UklGRiQAAABXQVZFZm10IBAAAA...",
  "isFinal": false,
  "alignment": {
    "chars": ["H", "e", "l", "l", "o", " "],
    "charStartTimesMs": [0, 25, 52, 78, 104, 130],
    "charsDurationsMs": [25, 27, 26, 26, 26, 35]
  }
}
```

---

## 4. Implementation Plan for Slice 2 (Streaming Audio & Live TTS)

In Slice 2:
1. Implement live `CartesiaWebSocketClient` with Web Audio API PCM streaming worklet.
2. Implement live `ElevenLabsWebSocketClient` with single-use ephemeral token auth.
3. Measure live empirical round-trip latencies, buffer continuity, and audio/highlight synchronization under network jitter.
