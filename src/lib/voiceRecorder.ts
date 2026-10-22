// Records a short voice note from the microphone and returns it as a small 16 kHz mono WAV (base64) — the format the voice-to-expense
// service reads without any trouble, on every phone and browser. Stops by itself a moment after the person stops talking, so there is
// nothing to tap when they are done.

export interface VoiceRecording {
  /** Stop now and get the clip. */
  stop: () => Promise<{ wavBase64: string; durationMs: number; heardVoice: boolean }>;
  /** Throw the recording away. */
  cancel: () => void;
}

const TARGET_RATE = 16000;
const VOICE_LEVEL = 0.018; // loudness (RMS, 0..1) that counts as someone speaking
const SILENCE_AFTER_VOICE_MS = 1400; // quiet this long after speaking = finished
const NO_VOICE_GIVE_UP_MS = 9000; // nothing said at all for this long = give up
const MAX_MS = 20000;

function downsample(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate <= TARGET_RATE) return input;
  const ratio = fromRate / TARGET_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

import { Capacitor } from '@capacitor/core';
import { SpeechRecognition } from './speech';

export async function startVoiceRecording(opts: {
  /** Called a few times a second with the current loudness (0..1) so the screen can show it. */
  onLevel?: (level: number) => void;
  /** Called when the recording stopped on its own (finished speaking, nothing said, or too long). */
  onAutoStop?: () => void;
}): Promise<VoiceRecording> {
  // The Android app records natively (the page itself may not be allowed the microphone, e.g. when opened over plain http while testing).
  if (Capacitor.getPlatform() === 'android' && SpeechRecognition.startRecording && SpeechRecognition.stopRecording) {
    const handles = await Promise.all([
      SpeechRecognition.addListener('recordingLevel', (d) => opts.onLevel?.(d.level)),
      SpeechRecognition.addListener('recordingEnded', () => opts.onAutoStop?.()),
    ]);
    const dropListeners = () => handles.forEach((h) => h.remove().catch(() => {}));
    try {
      await SpeechRecognition.startRecording({ silenceMs: SILENCE_AFTER_VOICE_MS, giveUpMs: NO_VOICE_GIVE_UP_MS, maxMs: MAX_MS });
    } catch (err) {
      dropListeners();
      throw err;
    }
    return {
      stop: async () => {
        dropListeners();
        return SpeechRecognition.stopRecording!();
      },
      cancel: () => {
        dropListeners();
        SpeechRecognition.cancelRecording?.().catch(() => {});
      },
    };
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
  const ctx = new Ctx();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  const startedAt = Date.now();
  let heardVoice = false;
  let lastVoiceAt = 0;
  let finished = false;

  const silentOut = ctx.createGain();
  silentOut.gain.value = 0; // the processor must be connected to run, but nothing is played back
  source.connect(processor);
  processor.connect(silentOut);
  silentOut.connect(ctx.destination);

  const release = () => {
    try { processor.disconnect(); source.disconnect(); silentOut.disconnect(); } catch { /* already gone */ }
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  };

  let autoStopCalled = false;
  const autoStop = () => {
    if (autoStopCalled || finished) return;
    autoStopCalled = true;
    opts.onAutoStop?.();
  };

  processor.onaudioprocess = (e) => {
    if (finished) return;
    const data = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(data));
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    opts.onLevel?.(Math.min(1, rms * 8));
    const now = Date.now();
    if (rms > VOICE_LEVEL) { heardVoice = true; lastVoiceAt = now; }
    if (heardVoice && now - lastVoiceAt > SILENCE_AFTER_VOICE_MS) autoStop();
    else if (!heardVoice && now - startedAt > NO_VOICE_GIVE_UP_MS) autoStop();
    else if (now - startedAt > MAX_MS) autoStop();
  };

  return {
    stop: async () => {
      finished = true;
      const rate = ctx.sampleRate;
      release();
      let total = 0;
      chunks.forEach((c) => { total += c.length; });
      const all = new Float32Array(total);
      let offset = 0;
      chunks.forEach((c) => { all.set(c, offset); offset += c.length; });
      const wav = encodeWav(downsample(all, rate), Math.min(rate, TARGET_RATE));
      return { wavBase64: toBase64(wav), durationMs: Date.now() - startedAt, heardVoice };
    },
    cancel: () => {
      finished = true;
      release();
    },
  };
}
