"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Dictée vocale avec transcription en direct.
 *
 * Deux moteurs, choisis automatiquement au montage :
 *
 *  - « speech » : l'API Web Speech du navigateur (Chrome, Edge, Safari, iOS).
 *    Les mots arrivent au fil de la parole — résultats provisoires puis figés —
 *    la reconnaissance du français y est bonne et il n'y a rien à télécharger.
 *    Contrepartie : l'audio transite par le service de reconnaissance du
 *    navigateur (Google sur Chrome/Android, Apple sur Safari).
 *
 *  - « whisper » : repli 100 % local via transformers.js. C'est le seul moteur
 *    disponible sur Firefox, qui n'implémente pas l'API Web Speech.
 *
 * Le moteur Whisper suit deux règles, apprises à la dure :
 *
 *  1. L'inférence ne touche jamais le thread principal. Elle vit dans
 *     `whisper.worker.ts` : en WASM mono-thread une passe occupe le cœur
 *     plusieurs centaines de millisecondes, ce qui gèlerait la page.
 *  2. Aucune passe ne retranscrit l'audio depuis le début. Le flux est découpé
 *     en segments d'une dizaine de secondes, coupés sur un creux d'énergie
 *     (donc rarement au milieu d'un mot) ; chaque segment est transcrit une
 *     fois puis figé. Seule la queue en cours est retranscrite pour l'aperçu.
 *     Le coût d'une passe reste donc constant, quelle que soit la durée de la
 *     dictée.
 */

export type DictationStatus =
  | "idle"
  | "recording"
  | "loading" // téléchargement / initialisation du modèle Whisper
  | "transcribing";

export type DictationEngine = "speech" | "whisper";

const SPEECH_LANG = process.env.NEXT_PUBLIC_SPEECH_LANG || "fr-FR";
const WHISPER_MODEL =
  process.env.NEXT_PUBLIC_WHISPER_MODEL || "Xenova/whisper-base";
const WHISPER_LANG = process.env.NEXT_PUBLIC_WHISPER_LANG || "french";

/* ------------------------------------------------------------------ */
/* API Web Speech : types absents de lib.dom, déclarés au minimum ici.  */
/* ------------------------------------------------------------------ */

type SpeechAlt = { transcript: string; confidence: number };
interface SpeechResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechAlt;
}
interface SpeechResultList {
  length: number;
  [index: number]: SpeechResult;
}
interface SpeechEvent {
  resultIndex: number;
  results: SpeechResultList;
}
interface SpeechErrorEvent {
  error: string;
  message?: string;
}
interface SpeechRecognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechEvent) => void) | null;
  onerror: ((e: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
}
type SpeechCtor = new () => SpeechRecognizer;

function speechCtor(): SpeechCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechCtor;
    webkitSpeechRecognition?: SpeechCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

// Panne fatale du moteur navigateur : on retient le repli pour toute la page.
let speechDisabled = false;

/* ------------------------------------------------------------------ */
/* Capture PCM 16 kHz                                                  */
/* ------------------------------------------------------------------ */

const RATE = 16000;

/** Segments visés, et zone où chercher le silence qui servira de coupure. */
const SEGMENT_SEC = 8;
const SEGMENT_MIN_SEC = 5;
/** En dessous, Whisper brode sur du bruit : pas d'aperçu. */
const MIN_TAIL_SEC = 1.5;
/** Respiration entre deux aperçus, pour ne pas saturer le worker. */
const INTERIM_GAP_MS = 600;
/** Limite du modèle : une passe ne dépasse jamais 30 s d'audio. */
const MAX_PASS_SEC = 30;

/**
 * Le tap qui recopie le micro. Publié en Blob plutôt qu'en fichier statique :
 * il n'a de sens que pour ce hook. Les échantillons partent par paquets de
 * 2048 (~43 ms) au lieu des 128 du callback, sinon c'est 375 messages/seconde.
 */
const WORKLET_SRC = `
class PcmTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.slice(0));
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
`;

/**
 * Ré-échantillonnage vers 16 kHz par moyenne glissante (filtre boîte), plutôt
 * qu'une simple décimation qui replierait le spectre. Le compteur de phase est
 * fractionnaire : gère aussi bien 48 kHz (ratio 3) que 44,1 kHz (2,75625).
 */
function makeResampler(inRate: number) {
  const ratio = inRate / RATE;
  let acc = 0;
  let n = 0;
  let phase = 0;
  return (chunk: Float32Array): Float32Array => {
    const out = new Float32Array(Math.ceil(chunk.length / ratio) + 1);
    let k = 0;
    for (let i = 0; i < chunk.length; i++) {
      acc += chunk[i];
      n++;
      phase += 1;
      if (phase >= ratio) {
        out[k++] = acc / n;
        acc = 0;
        n = 0;
        phase -= ratio;
      }
    }
    return out.subarray(0, k);
  };
}

/** Tampon PCM à croissance amortie (doublement), pour éviter les recopies. */
class PcmBuffer {
  data = new Float32Array(RATE * 60);
  length = 0;
  push(chunk: Float32Array) {
    if (this.length + chunk.length > this.data.length) {
      const bigger = new Float32Array(
        Math.max(this.data.length * 2, this.length + chunk.length)
      );
      bigger.set(this.data.subarray(0, this.length));
      this.data = bigger;
    }
    this.data.set(chunk, this.length);
    this.length += chunk.length;
  }
  slice(from: number, to: number) {
    return this.data.slice(from, to);
  }
}

/**
 * Point de coupure d'un segment : la fenêtre de 20 ms la moins énergique de la
 * zone de recherche. C'est ce qui évite de trancher au milieu d'un mot.
 */
function findQuietCut(data: Float32Array, from: number, to: number) {
  const win = Math.round(RATE * 0.02);
  let best = to;
  let bestRms = Infinity;
  for (let p = from; p + win <= to; p += win) {
    let sum = 0;
    for (let i = p; i < p + win; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / win);
    if (rms < bestRms) {
      bestRms = rms;
      best = p + win;
    }
  }
  return best;
}

type Capture = { close: () => void };

async function startCapture(
  stream: MediaStream,
  onPcm: (samples: Float32Array) => void
): Promise<Capture> {
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  // Taux natif conservé : Firefox refuse encore un MediaStreamSource dont le
  // contexte impose un autre taux. On ré-échantillonne nous-mêmes.
  const ctx = new AudioCtx();
  if (ctx.state === "suspended") await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);
  const resample = makeResampler(ctx.sampleRate);

  let node: AudioNode;
  try {
    const url = URL.createObjectURL(
      new Blob([WORKLET_SRC], { type: "text/javascript" })
    );
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const tap = new AudioWorkletNode(ctx, "pcm-tap");
    tap.port.onmessage = (e) => onPcm(resample(e.data as Float32Array));
    node = tap;
  } catch {
    // Repli historique : déprécié, mais universel.
    const sp = ctx.createScriptProcessor(4096, 1, 1);
    sp.onaudioprocess = (e) =>
      onPcm(resample(new Float32Array(e.inputBuffer.getChannelData(0))));
    node = sp;
  }

  // Un nœud doit être tiré par la destination pour tourner ; le gain à zéro
  // évite de renvoyer le micro dans les haut-parleurs.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);

  return {
    close: () => {
      try {
        source.disconnect();
        node.disconnect();
        mute.disconnect();
      } catch {
        /* déjà démonté */
      }
      void ctx.close();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Worker Whisper (partagé par toute la page)                          */
/* ------------------------------------------------------------------ */

type WorkerReply =
  | { type: "progress"; pct: number }
  | { type: "ready" }
  | { type: "result"; id: number; text: string }
  | { type: "error"; id?: number; message: string };

let workerRef: Worker | null = null;
let workerReady: Promise<void> | null = null;
let onWorkerProgress: ((pct: number) => void) | null = null;
const pending = new Map<
  number,
  { resolve: (t: string) => void; reject: (e: Error) => void }
>();
let nextId = 1;

function getWorker(): Worker {
  if (!workerRef) {
    workerRef = new Worker(new URL("./whisper.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.onmessage = (e: MessageEvent<WorkerReply>) => {
      const msg = e.data;
      if (msg.type === "progress") return onWorkerProgress?.(msg.pct);
      if (msg.type === "result") {
        pending.get(msg.id)?.resolve(msg.text);
        pending.delete(msg.id);
        return;
      }
      if (msg.type === "error" && typeof msg.id === "number") {
        pending.get(msg.id)?.reject(new Error(msg.message));
        pending.delete(msg.id);
      }
    };
  }
  return workerRef;
}

/** Charge le modèle (une seule fois par page). */
function loadModel(onProgress?: (pct: number) => void): Promise<void> {
  onWorkerProgress = onProgress ?? null;
  if (!workerReady) {
    const w = getWorker();
    workerReady = new Promise<void>((resolve, reject) => {
      const onMsg = (e: MessageEvent<WorkerReply>) => {
        if (e.data.type === "ready") {
          w.removeEventListener("message", onMsg);
          resolve();
        } else if (e.data.type === "error" && e.data.id === undefined) {
          w.removeEventListener("message", onMsg);
          workerReady = null; // un échec ne condamne pas la session
          reject(new Error(e.data.message));
        }
      };
      w.addEventListener("message", onMsg);
      w.postMessage({
        type: "load",
        model: WHISPER_MODEL,
        language: WHISPER_LANG,
      });
    });
  }
  return workerReady;
}

function transcribeInWorker(pcm: Float32Array): Promise<string> {
  const id = nextId++;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ type: "transcribe", id, pcm }, [pcm.buffer]);
  });
}

function joinParts(parts: string[]) {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" ");
}

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

export function useDictation(
  onText: (text: string) => void,
  onInterim?: (text: string) => void
) {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const [engine, setEngine] = useState<DictationEngine>("speech");
  const [modelReady, setModelReady] = useState(false);

  // Callbacks toujours à jour sans reconstruire start/stop à chaque rendu.
  const textCb = useRef(onText);
  const interimCb = useRef(onInterim);
  useEffect(() => {
    textCb.current = onText;
    interimCb.current = onInterim;
  });

  const emitText = useCallback((t: string) => {
    const v = t.trim();
    if (v) textCb.current(v);
  }, []);
  const emitInterim = useCallback((t: string) => {
    interimCb.current?.(t.trim());
  }, []);

  useEffect(() => {
    const hasSpeech = !!speechCtor();
    const hasCapture =
      typeof window !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof window.AudioContext !== "undefined";
    setSupported(hasSpeech || hasCapture);
    setEngine(hasSpeech && !speechDisabled ? "speech" : "whisper");
  }, []);

  /* ---------------- moteur navigateur (temps réel) ---------------- */

  const recRef = useRef<SpeechRecognizer | null>(null);
  const wantRef = useRef(false);
  const committedIndexRef = useRef(0);
  const speechTailRef = useRef("");
  const restartsRef = useRef<number[]>([]);

  const startSpeech = useCallback(() => {
    const Ctor = speechCtor();
    if (!Ctor) return false;

    let rec: SpeechRecognizer;
    try {
      rec = new Ctor();
    } catch {
      return false;
    }
    rec.lang = SPEECH_LANG;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    committedIndexRef.current = 0;
    speechTailRef.current = "";
    restartsRef.current = [];

    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const txt = r[0]?.transcript ?? "";
        if (r.isFinal) {
          // Chrome peut réémettre un résultat déjà figé : chaque index n'est
          // validé qu'une fois.
          if (i >= committedIndexRef.current) {
            committedIndexRef.current = i + 1;
            emitText(txt);
          }
        } else {
          interim += txt;
        }
      }
      speechTailRef.current = interim;
      emitInterim(interim);
    };

    rec.onerror = (e) => {
      // « no-speech » et « aborted » sont bénins : onend relancera.
      if (e.error === "no-speech" || e.error === "aborted") return;
      wantRef.current = false;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setError("Micro refusé. Autorise l'accès au microphone.");
        return;
      }
      // Réseau coupé, service indisponible… : on bascule sur Whisper.
      speechDisabled = true;
      setEngine("whisper");
      setError(
        "Dictée navigateur indisponible. Repli sur Whisper local : réappuie sur le micro."
      );
    };

    rec.onend = () => {
      if (wantRef.current) {
        // Chrome et iOS coupent d'eux-mêmes après un silence : on relance tant
        // que l'utilisateur n'a pas appuyé sur stop.
        const now = Date.now();
        restartsRef.current = restartsRef.current.filter((t) => now - t < 10000);
        restartsRef.current.push(now);
        if (restartsRef.current.length <= 12) {
          committedIndexRef.current = 0; // les index repartent de zéro
          try {
            rec.start();
            return;
          } catch {
            /* on retombe sur l'arrêt propre ci-dessous */
          }
        }
        wantRef.current = false;
      }
      recRef.current = null;
      const tail = speechTailRef.current;
      speechTailRef.current = "";
      emitInterim("");
      if (tail.trim()) emitText(tail);
      setStatus("idle");
    };

    wantRef.current = true;
    try {
      rec.start();
    } catch {
      wantRef.current = false;
      return false;
    }
    recRef.current = rec;
    setStatus("recording");
    return true;
  }, [emitText, emitInterim]);

  /* ---------------- moteur Whisper (repli local) ---------------- */

  const captureRef = useRef<Capture | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pcmRef = useRef<PcmBuffer | null>(null);
  const segmentsRef = useRef<string[]>([]);
  const cutRef = useRef(0); // échantillons déjà figés
  const recordingRef = useRef(false);
  const modelReadyRef = useRef(false);
  const lastInterimRef = useRef(0);

  // File d'exécution : une seule passe de transcription à la fois, et l'arrêt
  // attend naturellement la passe en cours.
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const pumpQueuedRef = useRef(false);

  const runExclusive = useCallback((fn: () => Promise<void>) => {
    const next = chainRef.current.then(fn, fn);
    chainRef.current = next.catch(() => {});
    return next;
  }, []);

  /** Une itération : fige un segment si la queue est assez longue, sinon rafraîchit l'aperçu. */
  const doPump = useCallback(async () => {
    const buf = pcmRef.current;
    if (!buf || !recordingRef.current || !modelReadyRef.current) return;
    const from = cutRef.current;
    const tail = buf.length - from;
    if (tail <= 0) return;
    const tailSec = tail / RATE;

    if (tailSec >= SEGMENT_SEC) {
      const segEnd = Math.min(buf.length, from + Math.round(SEGMENT_SEC * RATE));
      const cut = findQuietCut(
        buf.data,
        from + Math.round(SEGMENT_MIN_SEC * RATE),
        segEnd
      );
      const text = await transcribeInWorker(buf.slice(from, cut));
      segmentsRef.current.push(text);
      cutRef.current = cut;
      if (recordingRef.current) emitInterim(joinParts(segmentsRef.current));
      return;
    }

    if (
      tailSec >= MIN_TAIL_SEC &&
      Date.now() - lastInterimRef.current >= INTERIM_GAP_MS
    ) {
      const text = await transcribeInWorker(buf.slice(from, buf.length));
      lastInterimRef.current = Date.now();
      if (recordingRef.current)
        emitInterim(joinParts([...segmentsRef.current, text]));
    }
  }, [emitInterim]);

  const requestPump = useCallback(() => {
    if (pumpQueuedRef.current) return;
    pumpQueuedRef.current = true;
    void runExclusive(async () => {
      pumpQueuedRef.current = false;
      try {
        await doPump();
      } catch {
        /* une passe ratée n'interrompt pas la dictée */
      }
    });
  }, [doPump, runExclusive]);

  const finishWhisper = useCallback(async () => {
    recordingRef.current = false;
    captureRef.current?.close();
    captureRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    const buf = pcmRef.current;
    pcmRef.current = null;
    const segments = segmentsRef.current;
    segmentsRef.current = [];
    const from = cutRef.current;
    cutRef.current = 0;

    if (!buf || buf.length === 0) {
      emitInterim("");
      setStatus("idle");
      return;
    }

    try {
      setStatus(modelReadyRef.current ? "transcribing" : "loading");
      await loadModel(setProgress);
      modelReadyRef.current = true;
      setModelReady(true);
      setStatus("transcribing");
      // Vide ce qui reste, par tranches d'au plus 30 s (limite du modèle).
      let cursor = from;
      while (cursor < buf.length) {
        const end = Math.min(buf.length, cursor + MAX_PASS_SEC * RATE);
        segments.push(await transcribeInWorker(buf.slice(cursor, end)));
        cursor = end;
      }
      emitInterim("");
      emitText(joinParts(segments));
    } catch (e) {
      console.error(e);
      emitInterim("");
      // Ce qui avait déjà été figé n'est pas perdu.
      const partial = joinParts(segments);
      if (partial) emitText(partial);
      else setError("Transcription impossible. Réessaie.");
    } finally {
      setStatus("idle");
    }
  }, [emitInterim, emitText]);

  const startWhisper = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      pcmRef.current = new PcmBuffer();
      segmentsRef.current = [];
      cutRef.current = 0;
      lastInterimRef.current = 0;
      recordingRef.current = true;

      captureRef.current = await startCapture(stream, (samples) => {
        pcmRef.current?.push(samples);
        requestPump();
      });
      setStatus("recording");

      // Chargement du modèle en parallèle de la parole : c'est là que se
      // jouait l'essentiel de la latence perçue.
      modelReadyRef.current = false;
      setModelReady(false);
      setProgress(0);
      loadModel(setProgress)
        .then(() => {
          modelReadyRef.current = true;
          setModelReady(true);
          requestPump();
        })
        .catch(() => {});
      return true;
    } catch {
      recordingRef.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setError("Micro inaccessible. Autorise l'accès au microphone.");
      setStatus("idle");
      return false;
    }
  }, [requestPump]);

  /* ---------------- commandes ---------------- */

  const start = useCallback(async () => {
    setError(null);
    emitInterim("");
    if (engine === "speech" && !speechDisabled && startSpeech()) return;
    await startWhisper();
  }, [engine, startSpeech, startWhisper, emitInterim]);

  const stop = useCallback(() => {
    if (recRef.current) {
      wantRef.current = false;
      try {
        recRef.current.stop();
      } catch {
        recRef.current = null;
        setStatus("idle");
      }
      return;
    }
    if (recordingRef.current) {
      recordingRef.current = false;
      void runExclusive(finishWhisper);
    }
  }, [finishWhisper, runExclusive]);

  const toggle = useCallback(() => {
    if (status === "recording") stop();
    else if (status === "idle") void start();
  }, [status, start, stop]);

  // Nettoyage si le composant est démonté en cours de dictée. Le worker, lui,
  // survit : il garde le modèle chargé pour la prochaine dictée.
  useEffect(
    () => () => {
      wantRef.current = false;
      recordingRef.current = false;
      if (recRef.current) {
        try {
          recRef.current.abort();
        } catch {
          /* déjà arrêté */
        }
        recRef.current = null;
      }
      captureRef.current?.close();
      captureRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      pcmRef.current = null;
    },
    []
  );

  return {
    status,
    progress,
    error,
    supported,
    engine,
    modelReady,
    toggle,
  };
}
