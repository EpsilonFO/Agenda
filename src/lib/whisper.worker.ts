/**
 * Worker de transcription Whisper.
 *
 * Tout ce qui coûte — téléchargement du modèle, initialisation d'ONNX Runtime,
 * inférence — vit ici. C'est la raison d'être du fichier : en WASM mono-thread,
 * une passe de transcription occupe le cœur pendant plusieurs centaines de
 * millisecondes ; sur le thread principal elle gèle la page entière. Ici, la
 * page reste fluide quoi qu'il arrive.
 *
 * Protocole (voir useDictation.ts) :
 *   → { type: "load", model, language }
 *   ← { type: "progress", pct } puis { type: "ready" } ou { type: "error" }
 *   → { type: "transcribe", id, pcm }   (PCM mono 16 kHz, buffer transféré)
 *   ← { type: "result", id, text } ou { type: "error", id, message }
 */

import { pipeline, env } from "@xenova/transformers";

// Toujours récupérer les modèles depuis le hub distant.
env.allowLocalModels = false;

type Transcriber = (
  audio: Float32Array,
  opts: Record<string, unknown>
) => Promise<{ text: string }>;

// `self` typé au minimum : la lib "webworker" n'est pas dans le tsconfig
// (elle entrerait en conflit avec "dom", utilisé par tout le reste du projet).
const worker = self as unknown as {
  postMessage: (message: unknown) => void;
  onmessage: ((e: MessageEvent) => void) | null;
};

let ready: Promise<Transcriber> | null = null;
let modelName = "";
let language = "french";

function load(model: string) {
  if (model) modelName = model;
  if (!ready) {
    ready = pipeline("automatic-speech-recognition", model, {
      progress_callback: (p: { status: string; progress?: number }) => {
        if (p.status === "progress" && typeof p.progress === "number") {
          worker.postMessage({ type: "progress", pct: Math.round(p.progress) });
        }
      },
    }).then((t) => t as unknown as Transcriber);
  }
  return ready;
}

worker.onmessage = async (e: MessageEvent) => {
  const msg = e.data as
    | { type: "load"; model: string; language?: string }
    | { type: "transcribe"; id: number; pcm: Float32Array };

  if (msg.type === "load") {
    if (msg.language) language = msg.language;
    try {
      await load(msg.model);
      worker.postMessage({ type: "ready" });
    } catch (err) {
      ready = null; // un échec ne doit pas condamner la session
      worker.postMessage({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (msg.type === "transcribe") {
    try {
      const transcribe = await load(modelName);
      const out = await transcribe(msg.pcm, {
        language,
        task: "transcribe",
        // Les segments envoyés font au plus 30 s : pas de découpage interne.
        chunk_length_s: 30,
      });
      worker.postMessage({ type: "result", id: msg.id, text: out.text || "" });
    } catch (err) {
      worker.postMessage({
        type: "error",
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
};

export {};
