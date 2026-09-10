"use client";

import { useSyncExternalStore } from "react";

/**
 * État « en ligne / hors ligne » de l'app, partagé par tous les composants.
 *
 * `navigator.onLine` seul ne suffit pas : il dit « en ligne » dès qu'il y a du
 * wifi, même derrière un portail captif ou quand le serveur est injoignable.
 * On croise donc trois sources :
 *   - les événements `online` / `offline` du navigateur ;
 *   - le résultat réel de nos requêtes (`noteNetworkOk` / `noteNetworkFail`,
 *     appelés par la couche de synchro à chaque fetch) ;
 *   - `navigator.onLine` au démarrage.
 */

const canUseDom = typeof window !== "undefined";

// Valeur initiale lue tout de suite (et pas au premier abonnement) : sinon un
// démarrage déjà hors ligne passerait inaperçu — React lit l'instantané avant
// de s'abonner.
let online = canUseDom ? navigator.onLine !== false : true;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

function set(next: boolean): void {
  if (next === online) return;
  online = next;
  emit();
}

if (canUseDom) {
  window.addEventListener("online", () => set(true));
  window.addEventListener("offline", () => set(false));
}

/** Une requête a abouti : on est bien en ligne. */
export function noteNetworkOk(): void {
  // `navigator.onLine === false` est fiable dans ce sens-là : si le système
  // dit qu'il n'y a pas de réseau, une réponse arrivée quand même sort du
  // cache du navigateur ou du service worker, pas du serveur.
  if (canUseDom && navigator.onLine === false) return;
  set(true);
}

/**
 * Une requête a échoué au niveau réseau (fetch rejeté, pas un 4xx/5xx) :
 * on considère l'app hors ligne jusqu'à la prochaine requête qui passe.
 */
export function noteNetworkFail(): void {
  set(false);
}

export function isOnline(): boolean {
  return online;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Hook : re-rend le composant à chaque bascule en ligne / hors ligne. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    isOnline,
    () => true // rendu serveur : on suppose « en ligne » (pas de mismatch)
  );
}
