# Meeting Recorder Web v0.1

Static PWA prototype for Chrome / Edge.

## Important browser rule
Microphone and screen/system-audio capture require a **secure context**:
- HTTPS website, or
- localhost

Opening `index.html` directly with `file://` is not enough.

## Main functions
- Room microphone recording
- Optional screen/tab/system audio capture (browser permission required)
- Live waveform + level meters
- Optional 10-second room-noise / voice tests
- IndexedDB meeting library
- Browser-side Whisper transcription using Transformers.js
- English / Mandarin / multilingual Whisper model
- Browser model cache after first load
- ChatGPT ZIP export
- AI-reviewed transcript JSON import
- Confirmed-only Speaker Library learning
- Preliminary automatic speaker matching using local spectral signatures
- PWA shell/service worker

## Transcription
Press **Load Browser Whisper** once. The browser downloads/caches the model.
Default model: `Xenova/whisper-small`

The first download can be large and requires access to jsDelivr + Hugging Face.
Subsequent use should reuse the browser cache.

## System / Teams audio
Browsers cannot silently capture Windows system audio.
Press **Share PC / Teams Audio**, choose the relevant tab/window/screen, and enable **Share audio** in the browser picker.

## Deploy
Upload this folder to any static HTTPS host, such as:
- GitHub Pages
- Cloudflare Pages
- Netlify
- your company HTTPS web server

No backend is required for the prototype.

## Speaker matching
This prototype stores confirmed speaker samples locally in IndexedDB and uses a lightweight spectral signature.
It is useful for experimentation, but a future neural speaker-embedding model will be more accurate.

## Privacy
Recordings, transcripts, and speaker profiles remain in browser IndexedDB unless you explicitly export a package.
The Whisper model is downloaded from Hugging Face on first use.
