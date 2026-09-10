"use client";

import { useState } from "react";
import type { EventsState } from "@/lib/useEvents";

/**
 * Pastille d'état de synchronisation, dans l'en-tête de l'agenda.
 *
 * Elle ne s'affiche que quand il y a quelque chose à dire : hors ligne,
 * modifications en attente, envoi en cours, ou échec définitif. Tout va bien
 * = rien à l'écran.
 */
export default function SyncStatus({ state }: { state: EventsState }) {
  const [open, setOpen] = useState(false);
  const { online, pending, syncing, failures, fromCache } = state;

  const hasFailures = failures.length > 0;
  const show = !online || pending > 0 || syncing || hasFailures || fromCache;
  if (!show) return null;

  const tone = hasFailures
    ? "border-red-400/40 bg-red-500/10 text-red-200"
    : !online
      ? "border-amber-400/40 bg-amber-500/10 text-amber-200"
      : "border-line bg-white/[0.06] text-ink-soft";

  const label = hasFailures
    ? `${failures.length} échec${failures.length > 1 ? "s" : ""}`
    : !online
      ? pending > 0
        ? `Hors ligne · ${pending} en attente`
        : "Hors ligne"
      : syncing
        ? "Synchronisation…"
        : pending > 0
          ? `${pending} en attente`
          : "Données locales";

  // Sur mobile l'en-tête est déjà serré : version courte de la même info.
  const shortLabel =
    !online && pending > 0 ? `Hors ligne · ${pending}` : label;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-semibold shadow-soft backdrop-blur-md transition hover:bg-white/10 ${tone}`}
        aria-label="État de la synchronisation"
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            hasFailures
              ? "bg-red-300"
              : !online
                ? "bg-amber-300"
                : syncing
                  ? "animate-pulse bg-brand"
                  : "bg-ink-faint"
          }`}
        />
        <span className="whitespace-nowrap sm:hidden">{shortLabel}</span>
        <span className="hidden whitespace-nowrap sm:inline">{label}</span>
      </button>

      {open && (
        // Ancrée à GAUCHE de la pastille et large au plus comme l'écran :
        // ancrée à droite, elle sortirait de l'écran sur mobile (la pastille y
        // est le premier élément de la rangée). Fond opaque, sinon l'agenda
        // derrière rend le texte illisible.
        <div
          className="glass-strong absolute left-0 top-full z-50 mt-2 w-[min(19rem,calc(100vw-2rem))] rounded-2xl p-3.5 text-xs leading-snug"
          style={{ background: "#101d31" }}
        >
          {hasFailures ? (
            <p className="font-semibold text-ink">
              Ces modifications n&apos;ont pas pu être enregistrées :
            </p>
          ) : !online ? (
            <p className="text-ink-soft">
              Pas de connexion. Ton agenda reste consultable et modifiable :
              création, déplacement et retouche sont enregistrés sur le
              téléphone et partiront dès le retour du réseau. Les agents, eux,
              ont besoin d&apos;internet.
            </p>
          ) : pending > 0 ? (
            <p className="text-ink-soft">
              {pending} modification{pending > 1 ? "s" : ""} en attente
              d&apos;envoi au serveur.
            </p>
          ) : fromCache ? (
            <p className="text-ink-soft">
              Agenda affiché depuis le cache du téléphone — le serveur
              n&apos;a pas répondu au dernier chargement.
            </p>
          ) : (
            <p className="text-ink-soft">Tout est synchronisé.</p>
          )}

          {hasFailures && (
            <ul className="mt-2 flex flex-col gap-1.5 text-red-300">
              {failures.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex justify-end gap-2">
            {hasFailures && (
              <button
                onClick={() => {
                  state.clearFailures();
                  setOpen(false);
                }}
                className="rounded-lg px-2.5 py-1.5 font-semibold text-ink-soft transition hover:bg-white/10 hover:text-ink"
              >
                Ignorer
              </button>
            )}
            <button
              onClick={() => {
                state.syncNow();
                void state.reload();
              }}
              disabled={syncing}
              className="rounded-lg border border-brand/40 bg-brand/10 px-2.5 py-1.5 font-semibold text-brand transition hover:bg-brand/20 disabled:opacity-50"
            >
              {syncing ? "…" : "Réessayer"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
