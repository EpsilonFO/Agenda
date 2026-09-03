"use client";

import { useEffect } from "react";
import { useDictation } from "@/lib/useDictation";

/**
 * Bouton micro : dictée vocale en direct.
 * `onInterim` reçoit le texte encore provisoire (aperçu au fil de la parole),
 * `onText` les segments définitifs. Voir `useDictationField` pour le branchement
 * sur un champ contrôlé.
 */
export default function MicButton({
  onText,
  onInterim,
  onError,
}: {
  onText: (text: string) => void;
  onInterim?: (text: string) => void;
  onError?: (message: string | null) => void;
}) {
  const { status, progress, error, supported, engine, modelReady, toggle } =
    useDictation(onText, onInterim);

  // Remonte les erreurs éventuelles au parent (barre d'info).
  useEffect(() => {
    onError?.(error);
  }, [error, onError]);

  if (!supported) return null;

  const busy = status === "loading" || status === "transcribing";
  const recording = status === "recording";
  // Sur le repli Whisper, le modèle se charge pendant qu'on parle : sans ce
  // compteur, les premières secondes passent pour une panne.
  const warming = recording && engine === "whisper" && !modelReady;

  const title = warming
    ? `Dictée en cours — chargement du modèle vocal… ${progress || 0}%`
    : status === "recording"
      ? "Arrêter la dictée"
      : status === "loading"
      ? `Chargement du modèle vocal… ${progress || 0}%`
      : status === "transcribing"
        ? "Transcription en cours…"
        : engine === "speech"
          ? "Dicter (temps réel)"
          : "Dicter (Whisper local)";

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      title={title}
      aria-label={title}
      className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-all duration-200 ease-out active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/[0.45] ${
        recording
          ? "animate-mic-pulse border-transparent bg-brand-gradient text-brand-ink shadow-glow-sm"
          : busy
          ? "border-line bg-white/[0.06] text-brand backdrop-blur"
          : "border-line bg-white/[0.06] text-ink-soft shadow-soft backdrop-blur hover:border-line-strong hover:bg-white/[0.12] hover:text-ink"
      }`}
    >
      {busy ? (
        <span className="h-4 w-4 animate-spin-soft rounded-full border-2 border-brand/30 border-t-brand" />
      ) : warming ? (
        // Le modèle arrive : on montre l'avancement plutôt qu'un carré muet.
        <span className="text-[9px] font-semibold tabular-nums text-brand-ink">
          {progress || 0}%
        </span>
      ) : recording ? (
        // Carré "stop"
        <span className="h-3 w-3 rounded-[3px] bg-brand-ink" />
      ) : (
        <MicIcon />
      )}
    </button>
  );
}

function MicIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}
