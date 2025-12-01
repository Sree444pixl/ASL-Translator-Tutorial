import { create } from 'zustand';

type State = {
  text: string;
  status: string;
  recognizedLabel?: string;
  confidence?: number;
  threshold: number; // 0..1
  cameraOn: boolean;
  holdMs: number; // letter commit hold time
};

type Actions = {
  setStatus: (status: string) => void;
  setRecognition: (label: string, confidence: number) => void;
  appendText: (t: string) => void;
  resetText: () => void;
  setThreshold: (v: number) => void;
  setCameraOn: (on: boolean) => void;
  setHoldMs: (ms: number) => void;
};

const savedText = typeof window !== 'undefined' ? localStorage.getItem('asl_text') || '' : '';

export const useAslStore = create<State & Actions>((set) => ({
  text: savedText,
  status: 'Listening to signs…',
  recognizedLabel: undefined,
  confidence: undefined,
  threshold: 0.95, // strict default for high accuracy
  cameraOn: true,
  holdMs: 600,
  setStatus: (status) => set({ status }),
  setRecognition: (label, confidence) => set({ recognizedLabel: label, confidence }),
  appendText: (t) => set((s) => {
    const next = (s.text + t);
    try { localStorage.setItem('asl_text', next); } catch {}
    return { text: next };
  }),
  resetText: () => set(() => { try { localStorage.removeItem('asl_text'); } catch {}; return { text: '' }; }),
  setThreshold: (v) => set({ threshold: Math.min(1.0, Math.max(0.7, v)) }), // allow 70%–100%
  setCameraOn: (on) => set({ cameraOn: on, status: on ? 'Listening to signs…' : 'Camera off' }),
  setHoldMs: (ms) => set({ holdMs: Math.min(1200, Math.max(200, Math.round(ms))) })
}));
