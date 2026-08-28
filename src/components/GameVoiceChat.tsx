import React, { useEffect, useMemo, useRef, useState } from 'react';
import { arrayUnion, collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';

// In-game voice chat — a WebRTC MESH (every pair of players who are both "in voice" holds a
// direct peer connection to each other), signaled entirely through Firestore rather than a
// dedicated WebSocket server, mirroring how every other piece of real-time state in this app
// (game moves, chat) already flows through Firestore listeners. No TURN server is configured —
// only public STUN — so a direct peer-to-peer path can't always be found behind certain
// restrictive/symmetric NATs (e.g. some corporate or carrier networks); this is a deliberate
// trade-off for zero ongoing audio-hosting cost, acceptable for the small (2-12) player counts
// these games already cap at. Falls back gracefully: that one connection just never connects,
// everyone else still works.

interface Player {
  uid: string;
  displayName: string;
  photoURL?: string;
}

interface PresenceDoc {
  uid: string;
  inVoice: boolean;
  micMuted: boolean;
  updatedAt: string;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

function pairKey(a: string, b: string): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

const VOLUME_STORAGE_KEY = 'familyledger_voice_volumes';

function readStoredVolumes(): { master: number; perPeer: Record<string, number> } {
  try {
    const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
    if (!raw) return { master: 1, perPeer: {} };
    const parsed = JSON.parse(raw);
    return { master: typeof parsed.master === 'number' ? parsed.master : 1, perPeer: parsed.perPeer || {} };
  } catch {
    return { master: 1, perPeer: {} };
  }
}

export interface GameVoiceState {
  supported: boolean;
  unsupportedReason: string | null;
  joined: boolean;
  joining: boolean;
  micMuted: boolean;
  error: string | null;
  peersInVoice: string[]; // other players currently in the voice room
  remoteMicMuted: Record<string, boolean>;
  speakingUids: Set<string>;
  masterVolume: number;
  peerVolumes: Record<string, number>;
  players: Player[];
  join: () => void;
  leave: () => void;
  toggleMic: () => void;
  setMasterVolume: (v: number) => void;
  setPeerVolume: (uid: string, v: number) => void;
  togglePeerMuted: (uid: string) => void;
  mutedPeers: Set<string>;
  muteAllPeers: () => void;
  unmuteAllPeers: () => void;
}

export function useGameVoice(collectionName: string, gameId: string | undefined, players: Player[]): GameVoiceState {
  const { user } = useAuth();
  const myUid = user?.uid;
  // Broken into individually-named checks (rather than one combined boolean) purely so
  // `unsupportedReason` below can report exactly which one failed — WebRTC/getUserMedia support
  // inside a native WKWebView (iOS) vs. Chrome's WebView (Android) has enough platform-specific
  // gaps that "not supported" alone isn't enough to debug from a user's screenshot.
  const hasNavigator = typeof navigator !== 'undefined';
  const hasMediaDevices = hasNavigator && !!navigator.mediaDevices;
  const hasGetUserMedia = hasMediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function';
  const hasRTCPeerConnection = typeof RTCPeerConnection !== 'undefined';
  const supported = hasGetUserMedia && hasRTCPeerConnection;
  const unsupportedReason = supported
    ? null
    : !hasNavigator
      ? 'navigator is undefined'
      : !hasMediaDevices
        ? 'navigator.mediaDevices is undefined (not a secure context, or this WebView has no media capture support)'
        : !hasGetUserMedia
          ? 'navigator.mediaDevices.getUserMedia is undefined'
          : 'RTCPeerConnection is undefined (no WebRTC support in this WebView)';

  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speakingUids, setSpeakingUids] = useState<Set<string>>(new Set());
  const [mutedPeers, setMutedPeers] = useState<Set<string>>(new Set());
  const [volumes, setVolumes] = useState(() => readStoredVolumes());

  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const signalUnsubsRef = useRef<Map<string, () => void>>(new Map());
  const appliedIceCountRef = useRef<Map<string, { local: number; remote: number }>>(new Map());
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analysersRef = useRef<Map<string, AnalyserNode>>(new Map());
  const speakingPollRef = useRef<number | null>(null);

  const otherPlayers = useMemo(() => players.filter((p) => p.uid !== myUid), [players, myUid]);

  const [presenceValue] = useCollection(gameId ? collection(db, collectionName, gameId, 'voicePresence') : null);
  const presenceByUid = useMemo(() => {
    const map = new Map<string, PresenceDoc>();
    presenceValue?.docs.forEach((d) => map.set(d.id, d.data() as PresenceDoc));
    return map;
  }, [presenceValue]);

  const peersInVoice = useMemo(
    () => otherPlayers.filter((p) => presenceByUid.get(p.uid)?.inVoice).map((p) => p.uid),
    [otherPlayers, presenceByUid],
  );
  const remoteMicMuted = useMemo(() => {
    const out: Record<string, boolean> = {};
    otherPlayers.forEach((p) => { out[p.uid] = !!presenceByUid.get(p.uid)?.micMuted; });
    return out;
  }, [otherPlayers, presenceByUid]);

  const ensureAudioContext = () => {
    if (!audioCtxRef.current) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      audioCtxRef.current = new Ctor();
    }
    return audioCtxRef.current;
  };

  const attachAnalyser = (uid: string, stream: MediaStream) => {
    try {
      const ctx = ensureAudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analysersRef.current.set(uid, analyser);
    } catch (err) {
      console.error('Failed to attach voice analyser:', err);
    }
  };

  // Polls every active analyser (mine + each connected peer) at a modest interval — cheap enough
  // to run continuously, frequent enough for a "who's talking right now" indicator to feel live.
  useEffect(() => {
    if (!joined) {
      if (speakingPollRef.current) window.clearInterval(speakingPollRef.current);
      speakingPollRef.current = null;
      setSpeakingUids(new Set());
      return;
    }
    const buffer = new Uint8Array(128);
    speakingPollRef.current = window.setInterval(() => {
      const next = new Set<string>();
      analysersRef.current.forEach((analyser, uid) => {
        analyser.getByteTimeDomainData(buffer);
        let sumSquares = 0;
        for (let i = 0; i < buffer.length; i++) {
          const v = (buffer[i] - 128) / 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / buffer.length);
        if (rms > 0.04) next.add(uid === 'self' ? myUid! : uid);
      });
      setSpeakingUids(next);
    }, 200);
    return () => {
      if (speakingPollRef.current) window.clearInterval(speakingPollRef.current);
      speakingPollRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, myUid]);

  const writePresence = (fields: Partial<Pick<PresenceDoc, 'inVoice' | 'micMuted'>>) => {
    if (!myUid || !gameId) return;
    setDoc(
      doc(db, collectionName, gameId, 'voicePresence', myUid),
      { uid: myUid, inVoice: false, micMuted: false, ...fields, updatedAt: new Date().toISOString() },
      { merge: true },
    ).catch((err) => console.error('Failed to write voice presence:', err));
  };

  const tryAddIce = (pc: RTCPeerConnection, raw: string) => {
    try {
      pc.addIceCandidate(new RTCIceCandidate(JSON.parse(raw)));
    } catch (err) {
      // Benign — candidates can legitimately fail to apply (e.g. arriving before the remote
      // description is set); the connection still completes via whichever candidates DO land.
      console.warn('Voice ICE candidate not applied:', err);
    }
  };

  const teardownPeer = (peerUid: string) => {
    peerConnectionsRef.current.get(peerUid)?.close();
    peerConnectionsRef.current.delete(peerUid);
    signalUnsubsRef.current.get(peerUid)?.();
    signalUnsubsRef.current.delete(peerUid);
    appliedIceCountRef.current.delete(peerUid);
    analysersRef.current.delete(peerUid);
    const el = audioElsRef.current.get(peerUid);
    if (el) { el.srcObject = null; el.remove(); }
    audioElsRef.current.delete(peerUid);
  };

  const connectToPeer = (peerUid: string) => {
    if (!myUid || !gameId || peerConnectionsRef.current.has(peerUid)) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peerConnectionsRef.current.set(peerUid, pc);
    localStreamRef.current?.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current!));

    const isA = myUid < peerUid;
    const key = pairKey(myUid, peerUid);
    const sigRef = doc(db, collectionName, gameId, 'voiceSignals', key);
    const localIceField = isA ? 'iceFromA' : 'iceFromB';
    appliedIceCountRef.current.set(peerUid, { local: 0, remote: 0 });

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      attachAnalyser(peerUid, stream);
      let el = audioElsRef.current.get(peerUid);
      if (!el) {
        el = new Audio();
        el.autoplay = true;
        audioElsRef.current.set(peerUid, el);
        const storedVol = volumes.perPeer[peerUid];
        el.volume = Math.min(1, (storedVol ?? 1) * volumes.master);
        el.muted = mutedPeers.has(peerUid);
      }
      el.srcObject = stream;
    };

    // Firestore's `arrayUnion` means the doc's ICE array only ever grows — track how many of MY
    // own outgoing candidates have already been written so a later snapshot (from the peer's own
    // writes to the other half of the doc) doesn't cause them to be re-appended.
    const pendingLocalIce: string[] = [];
    let flushed = 0;
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      pendingLocalIce.push(JSON.stringify(event.candidate));
    };
    const flushIce = window.setInterval(() => {
      if (flushed >= pendingLocalIce.length) return;
      const toWrite = pendingLocalIce.slice(flushed);
      flushed = pendingLocalIce.length;
      updateDoc(sigRef, { [localIceField]: arrayUnion(...toWrite), updatedAt: new Date().toISOString() }).catch(() =>
        setDoc(sigRef, { [localIceField]: toWrite, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {}),
      );
    }, 500);
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        window.clearInterval(flushIce);
      }
    });

    const unsub = onSnapshot(sigRef, async (snap) => {
      const data = snap.data() as any;
      if (!data) return;
      const applied = appliedIceCountRef.current.get(peerUid) || { local: 0, remote: 0 };
      try {
        if (isA) {
          if (data.answerFromB && !pc.currentRemoteDescription) {
            await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(data.answerFromB)));
          }
          const remoteIce: string[] = data.iceFromB || [];
          remoteIce.slice(applied.remote).forEach((c) => tryAddIce(pc, c));
          applied.remote = remoteIce.length;
        } else {
          if (data.offerFromA && !pc.currentRemoteDescription) {
            await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(data.offerFromA)));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await setDoc(sigRef, { answerFromB: JSON.stringify(answer), updatedAt: new Date().toISOString() }, { merge: true });
          }
          const remoteIce: string[] = data.iceFromA || [];
          remoteIce.slice(applied.remote).forEach((c) => tryAddIce(pc, c));
          applied.remote = remoteIce.length;
        }
      } catch (err) {
        console.error('Voice signaling error with peer', peerUid, err);
      }
      appliedIceCountRef.current.set(peerUid, applied);
    });
    signalUnsubsRef.current.set(peerUid, unsub);

    if (isA) {
      (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await setDoc(sigRef, { offerFromA: JSON.stringify(offer), updatedAt: new Date().toISOString() }, { merge: true });
        } catch (err) {
          console.error('Failed to create voice offer:', err);
        }
      })();
    }
  };

  const join = async () => {
    if (!supported || !myUid || !gameId || joined || joining) return;
    setJoining(true);
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      localStreamRef.current = stream;
      attachAnalyser('self', stream);
      setJoined(true);
      writePresence({ inVoice: true, micMuted: false });
      peersInVoice.forEach((uid) => connectToPeer(uid));
    } catch (err) {
      console.error('Failed to join voice chat:', err);
      setError('Could not access your microphone — check app permissions.');
    } finally {
      setJoining(false);
    }
  };

  const leave = () => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    Array.from(peerConnectionsRef.current.keys()).forEach(teardownPeer);
    if (myUid && gameId) {
      otherPlayers.forEach((p) => {
        deleteDoc(doc(db, collectionName, gameId, 'voiceSignals', pairKey(myUid, p.uid))).catch(() => {});
      });
    }
    writePresence({ inVoice: false, micMuted: false });
    setJoined(false);
    setMicMuted(false);
    analysersRef.current.delete('self');
  };

  const toggleMic = () => {
    const next = !micMuted;
    setMicMuted(next);
    localStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = !next; });
    writePresence({ inVoice: true, micMuted: next });
  };

  // Reconcile active peer connections against who's actually in the voice room — connect to
  // newcomers, tear down anyone who left, while I'm joined myself.
  useEffect(() => {
    if (!joined) return;
    peersInVoice.forEach((uid) => connectToPeer(uid));
    Array.from(peerConnectionsRef.current.keys()).forEach((uid: string) => {
      if (!peersInVoice.includes(uid)) teardownPeer(uid);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, peersInVoice.join(',')]);

  // Leaving the screen entirely (navigating away, unmount) must tear everything down — an open
  // mic left running in the background would be a real privacy problem, not just a bug.
  useEffect(() => {
    return () => {
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      Array.from(peerConnectionsRef.current.keys()).forEach(teardownPeer);
      if (myUid && gameId) writePresence({ inVoice: false, micMuted: false });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  const persistVolumes = (next: { master: number; perPeer: Record<string, number> }) => {
    setVolumes(next);
    try { localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify(next)); } catch {}
  };

  const setMasterVolume = (v: number) => {
    const next = { ...volumes, master: v };
    persistVolumes(next);
    audioElsRef.current.forEach((el, uid) => {
      const peerVol = next.perPeer[uid] ?? 1;
      el.volume = Math.min(1, peerVol * v);
    });
  };

  const setPeerVolume = (uid: string, v: number) => {
    const next = { ...volumes, perPeer: { ...volumes.perPeer, [uid]: v } };
    persistVolumes(next);
    const el = audioElsRef.current.get(uid);
    if (el) el.volume = Math.min(1, v * volumes.master);
  };

  const togglePeerMuted = (uid: string) => {
    setMutedPeers((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      const el = audioElsRef.current.get(uid);
      if (el) el.muted = next.has(uid);
      return next;
    });
  };

  const muteAllPeers = () => {
    const all = new Set(otherPlayers.map((p) => p.uid));
    setMutedPeers(all);
    audioElsRef.current.forEach((el) => { el.muted = true; });
  };
  const unmuteAllPeers = () => {
    setMutedPeers(new Set());
    audioElsRef.current.forEach((el) => { el.muted = false; });
  };

  return {
    supported,
    unsupportedReason,
    joined,
    joining,
    micMuted,
    error,
    peersInVoice,
    remoteMicMuted,
    speakingUids,
    masterVolume: volumes.master,
    peerVolumes: volumes.perPeer,
    players: otherPlayers,
    join,
    leave,
    toggleMic,
    setMasterVolume,
    setPeerVolume,
    togglePeerMuted,
    mutedPeers,
    muteAllPeers,
    unmuteAllPeers,
  };
}

// Self-contained: owns its own popover open/close state so wiring it into a game screen is just
// `const voice = useGameVoice(...)` + `<VoiceChatButton voice={voice} />` — no extra state needed
// in the parent, unlike Chat's separate Button/Panel pair (which needs a parent-held `showChat`).
export const VoiceChatButton: React.FC<{ voice: GameVoiceState; className?: string }> = ({ voice, className }) => {
  const [open, setOpen] = useState(false);
  // Shown instead of silently hiding — "the button just isn't there" was undebuggable from a
  // screenshot alone. Tapping it surfaces exactly which browser API is missing, so a real gap
  // (old iOS, no WebRTC in this WebView) is distinguishable from a stale cached bundle that
  // predates this feature entirely (which wouldn't show this diagnostic at all — a build that
  // old has no GameVoiceChat.tsx to run).
  if (!voice.supported) {
    return (
      <button
        onClick={() => alert(`Voice chat isn't available on this device/browser: ${voice.unsupportedReason}`)}
        className={`relative p-2 shrink-0 opacity-40 ${className || ''}`}
        aria-label="Voice chat unavailable"
      >
        <span className="material-symbols-outlined text-[20px] block">mic_off</span>
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`relative p-2 shrink-0 ${className || ''}`}
        aria-label="Voice chat"
      >
        <span className="material-symbols-outlined text-[20px] block" style={voice.joined ? { color: 'var(--color-primary)' } : undefined}>
          {voice.joined ? (voice.micMuted ? 'mic_off' : 'mic') : 'mic_off'}
        </span>
        {voice.peersInVoice.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-success text-white text-[8px] font-bold flex items-center justify-center">
            {voice.peersInVoice.length}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-10 z-50 w-72 bg-white rounded-2xl border border-border-subtle shadow-xl p-3 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-black text-primary uppercase tracking-wider">Voice Chat</h3>
              <button onClick={() => setOpen(false)} className="text-text-muted">
                <span className="material-symbols-outlined text-[16px] block">close</span>
              </button>
            </div>

            {voice.error && <p className="text-[11px] font-bold text-error">{voice.error}</p>}

            <button
              onClick={voice.joined ? voice.leave : voice.join}
              disabled={voice.joining}
              className={`w-full py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all disabled:opacity-50 ${
                voice.joined ? 'bg-error/10 text-error' : 'bg-primary text-white'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">{voice.joined ? 'call_end' : 'call'}</span>
              {voice.joining ? 'Joining…' : voice.joined ? 'Leave Voice Chat' : 'Join Voice Chat'}
            </button>

            {voice.joined && (
              <button
                onClick={voice.toggleMic}
                className={`w-full py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-2 border ${
                  voice.micMuted ? 'bg-error/5 text-error border-error/20' : 'bg-surface text-on-surface border-border-subtle'
                }`}
              >
                <span className="material-symbols-outlined text-[16px]">{voice.micMuted ? 'mic_off' : 'mic'}</span>
                {voice.micMuted ? 'Unmute My Mic' : 'Mute My Mic'}
              </button>
            )}

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">My Volume</label>
                <span className="text-[10px] font-bold text-text-muted">{Math.round(voice.masterVolume * 100)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={voice.masterVolume}
                onChange={(e) => voice.setMasterVolume(Number(e.target.value))}
                className="w-full accent-primary"
              />
            </div>

            {voice.players.length > 0 && (
              <div className="space-y-1.5 pt-1 border-t border-border-subtle">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Players</label>
                  {voice.mutedPeers.size > 0 ? (
                    <button onClick={voice.unmuteAllPeers} className="text-[10px] font-bold text-primary">Unmute all</button>
                  ) : (
                    <button onClick={voice.muteAllPeers} className="text-[10px] font-bold text-primary">Mute all</button>
                  )}
                </div>
                <div className="space-y-2 max-h-52 overflow-y-auto">
                  {voice.players.map((p) => {
                    const inVoice = voice.peersInVoice.includes(p.uid);
                    const speaking = voice.speakingUids.has(p.uid);
                    const remoteMuted = voice.remoteMicMuted[p.uid];
                    const iMuted = voice.mutedPeers.has(p.uid);
                    return (
                      <div key={p.uid} className="space-y-1">
                        <div className="flex items-center gap-2">
                          <div className={`relative w-7 h-7 rounded-full overflow-hidden shrink-0 ${speaking ? 'ring-2 ring-success' : ''}`}>
                            <img src={p.photoURL || `https://ui-avatars.com/api/?name=${p.displayName}`} alt="" className="w-full h-full object-cover" />
                            {!inVoice && <div className="absolute inset-0 bg-white/70" />}
                          </div>
                          <span className="text-[11px] font-bold text-on-surface flex-1 truncate">{p.displayName}</span>
                          {remoteMuted && inVoice && <span className="material-symbols-outlined text-[14px] text-text-muted">mic_off</span>}
                          {inVoice && (
                            <button onClick={() => voice.togglePeerMuted(p.uid)} className={`p-1 rounded ${iMuted ? 'text-error' : 'text-text-muted'}`}>
                              <span className="material-symbols-outlined text-[16px] block">{iMuted ? 'volume_off' : 'volume_up'}</span>
                            </button>
                          )}
                        </div>
                        {inVoice && !iMuted && (
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={voice.peerVolumes[p.uid] ?? 1}
                            onChange={(e) => voice.setPeerVolume(p.uid, Number(e.target.value))}
                            className="w-full accent-primary h-1"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
