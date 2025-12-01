# ASL Translator Pro - Project Guide

Project Type: React + TypeScript (Vite, Tailwind)
Entry: src/main.tsx → App.tsx → components/ASLTranslator.tsx

## Common Commands
- Install deps: `npm install`
- Production build: `npm run build` (MANDATORY after any code changes)
- Lint (if added): `npm run lint` (not configured by default)
- Test (if added): `npm test` (no test suite configured by default)

## Architecture Overview
- Components
  - `src/components/ASLTranslator.tsx`: Main UI and real-time loop
    - Loads Teachable Machine letters model only
    - Initializes webcam (flipped) and runs prediction per rAF
    - Strict letter-by-letter output (no NLP correction)
    - Accuracy gating: hold-only commit (see below)
    - Overlay shows current label and confidence; right panel shows translation
    - Reset and Copy buttons
    - Canvas mounting via a dedicated host container (`canvasHostRef`) to avoid direct DOM removals
  - `src/App.tsx`: Hosts ASLTranslator
- State (Zustand)
  - `src/store/aslStore.ts`:
    - `text`: translation buffer (persisted to localStorage)
    - `threshold`: confidence threshold (0.70–1.00) adjustable via slider
    - `holdMs`: letter commit hold time (200–1200ms) adjustable via slider
    - `recognizedLabel`, `confidence`, `status`, `cameraOn`
- Models & Assets
  - Letters: `/assets/models/letters/{model.json,metadata.json,weights.bin}`
  - All asset paths are absolute (`/assets/...`) to be build-safe
- Types & Styles
  - `src/types/teachable.d.ts`: minimal TS types for '@teachablemachine/image'
  - `src/styles/asl.css` + Tailwind classes for dark neon theme

## Recognition & Emission Rules (Letters Mode)
- Threshold gate: commit logic only runs when confidence ≥ `threshold`
- Hold-to-commit: once a label appears and remains the same for `holdMs`, emit exactly that letter (uppercased)
- Duplicate letters: allowed; if confidence drops below threshold briefly, the same letter can be emitted again after a fresh hold
- Word boundary: a space is inserted after 3s of inactivity (no corrections applied)

## UI Controls
- Threshold slider: 70%–100%
- Hold slider: 200–1200ms
- Camera On/Off toggle, Reset, Copy Text

## Troubleshooting
- NotFoundError: "Failed to execute 'removeChild' on 'Node'..."
  - Fix: Use a host container and `replaceChildren(webcam.canvas)`; avoid calling `removeChild` yourself
- Model load 403 under /assets
  - Fix: Load models from `/assets/...` only; ensure `public/assets/models/**` exists so Vite copies to `dist/assets/models`.
- WebGL unavailable / headless environments
  - Fix: Automatic fallback to `tf.setBackend('cpu')` is implemented. Performance will be lower but functional.
- Browser without WebRTC (no camera)
  - Use a modern browser with camera permissions enabled; headless/screenshot runners will not work for live webcam.
- Large bundle warning (>500kB)
  - Consider dynamic imports or `manualChunks` if needed

## Backend (for dataset management)
- Location: `backend/`
- D1 schema (`backend/schema.sql`):
  - `datasets(id, name, description, created_by, created_at)` STRICT
  - `samples(id, dataset_id, label, file_key, notes, created_at)` STRICT (FK → datasets)
  - `training_jobs(id, dataset_id, status, created_at, updated_at)` STRICT (FK → datasets)
  - Indexes on `samples(dataset_id)` and `training_jobs(dataset_id)`
- Purpose: store datasets and samples for future model retraining; use R2 for files via presigned uploads

## Mobile Considerations
- Webcam uses user permission; flip enabled for mirror view
- Responsive layout (1-col mobile, 2-col desktop)
- For mobile hardware integrations or touch-optimized UX, consult `/skills/mobile-develop/SKILL.md`

## AI/NLP
- Present in the codebase but currently disabled for strict letter-by-letter output.
- `src/api/nlp.ts` remains available if grammar correction needs to be re-enabled later.
