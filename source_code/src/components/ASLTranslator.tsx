import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import * as tmImage from '@teachablemachine/image';
import * as tf from '@tensorflow/tfjs';
import { useAslStore } from '../store/aslStore';
// corrections disabled: strict letter-by-letter (no NLP)

const MODEL_PATHS = {
  words: {
    modelUrl: '/assets/models/words/model.json',
    metadataUrl: '/assets/models/words/metadata.json',
  },
  letters: {
    modelUrl: '/assets/models/letters/model.json',
    metadataUrl: '/assets/models/letters/metadata.json',
  }
};

// Load Teachable Machine model from /assets only (production-safe absolute path)
async function loadModelWithFallback(modelUrl: string, metadataUrl: string): Promise<tmImage.CustomMobileNet> {
  // No '/public' fallback; ensure assets are served under '/assets/...'
  return await tmImage.load(modelUrl, metadataUrl);
}

const LETTER_GAP_MS = 3000; // time of inactivity to mark end of a word in letters mode
const WORD_GAP_MS = 6000;   // minimum gap between words in words mode
const STABLE_MS = 600;      // require longer stability for accuracy
const HOLD_MS = 600;        // require hold before commit
const RELEASE_MS = 300;     // require low-confidence release before next letter
const CONS_FRAMES = 8;      // stricter consensus across more frames

function mountCanvasToHost(webcam: tmImage.Webcam, host: HTMLDivElement | null) {
  try {
    webcam.canvas.style.width = '100%';
    webcam.canvas.style.height = '100%';
    webcam.canvas.style.objectFit = 'cover';
    webcam.canvas.setAttribute('aria-label', 'Webcam');
    if (host) host.replaceChildren(webcam.canvas);
  } catch {}
}

export default function ASLTranslator() {
  const { status, setStatus, setRecognition, appendText, resetText, threshold, cameraOn, setCameraOn, setThreshold, holdMs, setHoldMs } = useAslStore();
  const [copyOk, setCopyOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confidenceDisplay, setConfidenceDisplay] = useState<number | undefined>(undefined);

  const webcamRef = useRef<tmImage.Webcam | null>(null);
  const modelRef = useRef<tmImage.CustomMobileNet | null>(null);
  const rafRef = useRef<number | null>(null);

  // DOM host for external webcam canvas to avoid React removing/replacing nodes
  const canvasHostRef = useRef<HTMLDivElement | null>(null);

  // Debounce and gating refs
  const lastDetectedLabelRef = useRef<string>('');
  const stableSinceRef = useRef<number>(0);
  const lastEmittedLabelRef = useRef<string>('');
  const lastWordEmitTimeRef = useRef<number>(0);
  const lastWordBoundaryTimeRef = useRef<number>(0); // letters mode: gap between words
  const letterGapTimerRef = useRef<number | null>(null);
  const recentLabelsRef = useRef<string[]>([]);
  const awaitingReleaseRef = useRef<boolean>(false);
  const releaseStartRef = useRef<number>(0);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);

    (async () => {
      try {
        // Prefer WebGL; gracefully fall back to CPU if unavailable (e.g., headless or restricted env)
        try {
          await tf.setBackend('webgl');
          await tf.ready();
        } catch (backendErr) {
          console.warn('WebGL backend unavailable, falling back to CPU:', backendErr);
          await tf.setBackend('cpu');
          await tf.ready();
        }

        // Load letters model only
        const paths = MODEL_PATHS.letters;
        const model = await loadModelWithFallback(paths.modelUrl, paths.metadataUrl);
        if (cancelled) return;
        modelRef.current = model;

        if (cameraOn) {
          await startCamera();
        } else {
          setStatus('Camera off');
        }
      } catch (err: any) {
        console.error('Webcam/model init error:', err);
        setStatus('Camera or model error');
      } finally {
        setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
      stopLoop();
      stopCamera();
      modelRef.current = null;
      // Clear any pending letter timers
      if (letterGapTimerRef.current) {
        clearTimeout(letterGapTimerRef.current);
        letterGapTimerRef.current = null;
      }
      // Reset gating
      lastDetectedLabelRef.current = '';
      lastEmittedLabelRef.current = '';
      stableSinceRef.current = 0;
      recentLabelsRef.current = [];
    };
  }, []);

  const startCamera = async () => {
    // Setup webcam (always create a fresh instance when turning on)
    const size = getViewportSize();
    const webcam = new tmImage.Webcam(size.width, size.height, true); // flip
    await webcam.setup();
    await webcam.play();

    // Ensure the underlying <video> resumes properly across iOS/Android browsers
    try {
      const v: HTMLVideoElement | undefined = (webcam as any).webcam;
      if (v) {
        v.setAttribute('playsinline', 'true');
        v.muted = true;
        (v as any).autoplay = true;
      }
    } catch {}

    webcamRef.current = webcam;

    // Mount canvas and style for visibility
    mountCanvasToHost(webcam, canvasHostRef.current);

    setCameraOn(true);
    setStatus('Listening to signs…');
    startLoop();

    // Verify video actually started; if not, try a gentle retry
    window.setTimeout(async () => {
      try {
        const v: HTMLVideoElement | undefined = (webcam as any).webcam;
        const notReady = !v || v.readyState < 2 || v.paused || v.videoWidth === 0;
        if (notReady) {
          try { await (webcam as any).play(); } catch {}
          mountCanvasToHost(webcam, canvasHostRef.current);
        }
      } catch {}
    }, 600);
  };

  const stopCamera = () => {
    const w = webcamRef.current as any;
    if (w) {
      try { w.pause(); } catch {}
      try { w.stop(); } catch {}
      // Aggressively stop all MediaStream tracks to avoid ended-track issues on resume
      try {
        const v: HTMLVideoElement | undefined = w.webcam;
        const stream = v?.srcObject as MediaStream | null | undefined;
        if (stream) {
          stream.getTracks().forEach((t) => {
            try { t.stop(); } catch {}
          });
          if (v) v.srcObject = null;
        }
      } catch {}
    }
    webcamRef.current = null;
    // Clear the canvas host to avoid showing a stale/ended stream element
    if (canvasHostRef.current) {
      try { canvasHostRef.current.replaceChildren(); } catch {}
    }
    setCameraOn(false);
  };

  const startLoop = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(loop);
  };

  const stopLoop = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const loop = async () => {
    // Keep the loop alive across camera toggles by always scheduling the next frame
    if (!modelRef.current) {
      rafRef.current = requestAnimationFrame(loop);
      return;
    }

    const camOn = useAslStore.getState().cameraOn;
    if (!camOn || !webcamRef.current) {
      rafRef.current = requestAnimationFrame(loop);
      return;
    }

    webcamRef.current.update();

    const preds = await modelRef.current.predict(webcamRef.current.canvas);
    const best = preds.reduce((a, b) => (a.probability > b.probability ? a : b));
    const conf = best.probability;
    const label = best.className.trim();
    const now = Date.now();

    setConfidenceDisplay(conf);

    const thr = useAslStore.getState().threshold;
    if (conf >= thr) {
      // Track when the current label started so we can enforce simple hold timing
      if (lastDetectedLabelRef.current !== label) {
        lastDetectedLabelRef.current = label;
        stableSinceRef.current = now;
      }

      setRecognition(label, conf);
      setStatus(camOn ? `Recognizing sign for: ${label}` : 'Camera off');

      // Commit when held long enough at high confidence; allow repeating same letter after a release
      const heldLongEnough = (now - stableSinceRef.current) >= holdMs;
      const released = releaseStartRef.current > 0 && (now - releaseStartRef.current) >= RELEASE_MS;
      if ((label !== lastEmittedLabelRef.current || released) && heldLongEnough) {
        appendText(label.toUpperCase());
        lastEmittedLabelRef.current = label;
        // reset release timer after emission
        releaseStartRef.current = 0;

        // Word boundary timer: if no new letter arrives within 3s, insert a space
        if (letterGapTimerRef.current) clearTimeout(letterGapTimerRef.current);
        letterGapTimerRef.current = window.setTimeout(() => {
          const current = useAslStore.getState().text;
          if (current && !current.endsWith(' ')) {
            useAslStore.getState().appendText(' ');
            lastWordBoundaryTimeRef.current = Date.now();
            // strict letter-by-letter: no corrections
          }
        }, LETTER_GAP_MS);
      }

      // No release gating: next letter can be recognized as soon as label changes and meets holdMs
    } else {
      // Below threshold: start release timer and reset stability so next commit requires fresh hold
      if (releaseStartRef.current === 0) releaseStartRef.current = now;
      lastDetectedLabelRef.current = '';
      stableSinceRef.current = 0;
    }

    rafRef.current = requestAnimationFrame(loop);
  };

  const majorityCount = (arr: string[]) => {
    if (arr.length === 0) return 0;
    const counts: Record<string, number> = {};
    for (const l of arr) counts[l] = (counts[l] || 0) + 1;
    return Math.max(...Object.values(counts));
  };

  const shouldPrependSpace = () => {
    const s = useAslStore.getState().text;
    return s.length > 0 && !s.endsWith(' ');
  };

  const normalizeWord = (w: string) => w.replace(/_/g, ' ').toLowerCase();

  const triggerCorrection = async () => { /* disabled: strict letter-by-letter, no NLP */ };

  const { text } = useAslStore();

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text.trim());
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 1200);
    } catch {}
  };

  const onReset = () => {
    resetText();
    setStatus('Listening to signs…');
    // Reset gating runtime state
    lastDetectedLabelRef.current = '';
    lastEmittedLabelRef.current = '';
    stableSinceRef.current = 0;
    lastWordEmitTimeRef.current = 0;
    if (letterGapTimerRef.current) { clearTimeout(letterGapTimerRef.current); letterGapTimerRef.current = null; }
    lastWordBoundaryTimeRef.current = 0;
  };



  const toggleCamera = async () => {
    if (cameraOn) {
      // Turn camera off: stop loop and stop stream
      stopLoop();
      stopCamera();
      setStatus('Camera off');
    } else {
      // Turn camera on: always fresh-init the webcam to avoid ended tracks issues
      try {
        if (!modelRef.current) {
          const paths = MODEL_PATHS.letters;
          modelRef.current = await loadModelWithFallback(paths.modelUrl, paths.metadataUrl);
        }
        await startCamera();
      } catch (err) {
        console.error('Camera start error:', err);
        setStatus('Camera or model error');
      }
    }
  };

  const { recognizedLabel, confidence } = useAslStore();

  return (
    <div className="min-h-screen bg-black text-white">
      <header className="px-6 py-4 border-b border-white/10">
        <motion.h1 
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-center text-3xl sm:text-4xl font-semibold tracking-wide"
          style={{ textShadow: '0 0 10px rgba(0,255,200,0.6), 0 0 20px rgba(0,255,200,0.4)' }}
        >
          ASL Translator Tutorial
        </motion.h1>
      </header>

      <main className="grid grid-cols-1 lg:grid-cols-2 gap-6 p-6">
        {/* Left: Webcam */}
        <section className="relative rounded-xl overflow-hidden bg-white/5 border border-white/10">
          <div className="flex items-center justify-between p-3">
            <div className="text-sm text-white/70">{status}</div>
            <div className="flex items-center gap-2">
              <button onClick={toggleCamera} className="px-3 py-1 rounded-md bg-white/10 hover:bg-white/20 transition">{cameraOn ? 'Camera Off' : 'Camera On'}</button>
              <div className="flex items-center gap-4 text-xs text-white/80">
                <div className="flex items-center gap-2">
                  <label htmlFor="thr">Threshold</label>
                  <input id="thr" type="range" min={70} max={100} value={Math.round(threshold * 100)} onChange={(e) => setThreshold(Number(e.target.value) / 100)} />
                  <span>{Math.round(threshold * 100)}%</span>
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor="hold">Hold ms</label>
                  <input id="hold" type="range" min={200} max={1200} value={holdMs} onChange={(e) => setHoldMs(Number(e.target.value))} />
                  <span>{holdMs}ms</span>
                </div>
              </div>
            </div>
          </div>

          <div className="relative">
            {/* Webcam Canvas Host */}
            <div className="aspect-[4/3] w-full bg-black" ref={canvasHostRef} aria-label="Webcam canvas host" style={{ position: 'relative' }} />

            {/* Overlay */}
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="absolute bottom-3 left-3 right-3 flex items-center justify-between bg-black/60 backdrop-blur-sm rounded-lg px-4 py-2"
            >
              <div className="text-sm">
                <span className="text-white/80">Detected:</span> <span className="font-semibold">{recognizedLabel || '—'}</span>
              </div>
              <div className="text-sm">
                <span className="text-white/80">Confidence:</span> <span className="font-semibold">{(confidenceDisplay ?? confidence ?? 0).toFixed(2)}</span>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Right: Translation Panel */}
        <section className="rounded-xl bg-white/5 border border-white/10 p-4 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-medium">Translation</h2>
            <div className="flex items-center gap-2">
              <button onClick={onReset} className="px-3 py-1 rounded-md bg-white/10 hover:bg-white/20 transition">Reset</button>
              <button onClick={copyText} className="px-3 py-1 rounded-md bg-teal-500 text-black font-medium hover:bg-teal-400 transition">{copyOk ? 'Copied!' : 'Copy Text'}</button>
            </div>
          </div>

          <div className="flex-1">
            <div className="min-h-[240px] p-4 rounded-lg bg-black/50 border border-white/10 text-white/90 leading-relaxed">
              {text ? text : 'Start signing — translation will appear here.'}
            </div>
          </div>

          <div className="mt-3 text-xs text-white/60">Mode: Letters only • No corrections</div>
        </section>
      </main>
    </div>
  );
}

function getViewportSize() {
  const w = typeof window !== 'undefined' ? window.innerWidth : 640;
  const isMobile = w < 768;
  return { width: isMobile ? 480 : 640, height: isMobile ? 360 : 480 };
}
