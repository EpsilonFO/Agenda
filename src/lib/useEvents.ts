"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EventItem } from "./types";
import { toLocalIso } from "./dates";
import { noteNetworkFail, noteNetworkOk, useOnline } from "./connectivity";
import {
  applyPending,
  flushOutbox,
  localEventId,
  newOp,
  pushOp,
  readOutbox,
  readSnapshot,
  writeSnapshot,
  type EventPayload,
  type PendingOp,
} from "./offline";

/** Rythme des nouvelles tentatives quand la file d'attente n'est pas vide. */
const RETRY_MS = 15_000;

export type EventsState = {
  /** Ce qu'il faut afficher : serveur (ou cache) + modifications en attente. */
  events: EventItem[];
  /** Recharge depuis le serveur, avec repli sur le cache local. */
  reload: () => Promise<void>;
  online: boolean;
  /** true si l'agenda affiché vient du cache local (pas du serveur). */
  fromCache: boolean;
  /** Nombre de modifications qui attendent de partir. */
  pending: number;
  syncing: boolean;
  /** Modifications définitivement abandonnées (refus du serveur). */
  failures: string[];
  clearFailures: () => void;
  /** Pousse la file maintenant (bouton « réessayer »). */
  syncNow: () => void;
  /** Crée (sans `id`) ou modifie (avec `id`) un événement. */
  saveEvent: (payload: EventPayload, id?: string) => void;
  removeEvent: (id: string) => void;
  /** Déplacement / redimensionnement depuis la grille. */
  moveEvent: (id: string, start: Date, end: Date) => void;
};

/**
 * Source unique des événements affichés, hors ligne comprise.
 *
 * Lecture : on tente le serveur ; s'il est injoignable on ressort le dernier
 * instantané rangé dans le localStorage (le service worker sert de son côté la
 * page elle-même, cf. public/sw.js).
 *
 * Écriture : tout passe par la file d'attente de lib/offline.ts et est appliqué
 * à l'écran immédiatement — donc on peut déplacer, créer, retoucher sans
 * réseau, et tout part à la reconnexion.
 */
export function useEvents(): EventsState {
  const online = useOnline();
  const [base, setBase] = useState<EventItem[]>([]);
  const [ops, setOps] = useState<PendingOp[]>([]);
  const [fromCache, setFromCache] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  // Évite de relancer une vidange déjà en cours depuis cet écran.
  const syncingRef = useRef(false);

  const events = useMemo(() => applyPending(base, ops), [base, ops]);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/events");
      if (!res.ok) throw new Error(String(res.status));
      const list: EventItem[] = await res.json();
      setBase(list);
      writeSnapshot(list);
      // Le service worker marque les réponses qu'il ressort de son cache :
      // la requête a « réussi », mais le serveur n'a pas répondu pour autant.
      const cached = res.headers.get("x-agenda-cache") === "1";
      setFromCache(cached);
      if (cached) noteNetworkFail();
      else noteNetworkOk();
    } catch {
      // Serveur injoignable : on affiche le dernier état connu.
      noteNetworkFail();
      const snap = readSnapshot();
      if (snap) {
        setBase(snap.events);
        setFromCache(true);
      }
    }
  }, []);

  const sync = useCallback(async () => {
    if (syncingRef.current) return;
    if (readOutbox().length === 0) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const result = await flushOutbox();
      setOps(readOutbox());
      if (result.dropped.length) {
        setFailures((prev) => [...prev, ...result.dropped]);
      }
      // Une écriture est passée : on récupère la version serveur (ids réels,
      // couleurs, invitations Google résolues…).
      if (result.sent > 0) await reload();
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [reload]);

  /** Applique une opération : à l'écran tout de suite, au serveur si possible. */
  const enqueue = useCallback(
    (op: PendingOp) => {
      setOps(pushOp(op));
      void sync();
    },
    [sync]
  );

  const saveEvent = useCallback(
    (payload: EventPayload, id?: string) => {
      enqueue(
        id
          ? newOp("update", id, payload)
          : newOp("create", localEventId(), payload)
      );
    },
    [enqueue]
  );

  const removeEvent = useCallback(
    (id: string) => enqueue(newOp("delete", id)),
    [enqueue]
  );

  const moveEvent = useCallback(
    (id: string, start: Date, end: Date) =>
      enqueue(newOp("update", id, { start: toLocalIso(start), end: toLocalIso(end) })),
    [enqueue]
  );

  // Démarrage : file d'attente rangée dans le localStorage, puis chargement.
  useEffect(() => {
    setOps(readOutbox());
    void reload();
    void sync();
  }, [reload, sync]);

  // Retour du réseau / retour au premier plan : on repousse la file et on
  // rafraîchit (l'agenda a pu bouger ailleurs pendant la coupure).
  useEffect(() => {
    const resume = () => {
      void sync();
      void reload();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") resume();
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload, sync]);

  // Tant qu'il reste des modifications en attente, on retente régulièrement :
  // l'événement `online` du navigateur ne se déclenche pas quand c'est le
  // serveur (et non le wifi) qui était tombé.
  useEffect(() => {
    if (ops.length === 0) return;
    const timer = setInterval(() => void sync(), RETRY_MS);
    return () => clearInterval(timer);
  }, [ops.length, sync]);

  const clearFailures = useCallback(() => setFailures([]), []);
  const syncNow = useCallback(() => void sync(), [sync]);

  return {
    events,
    reload,
    online,
    fromCache,
    pending: ops.length,
    syncing,
    failures,
    clearFailures,
    syncNow,
    saveEvent,
    removeEvent,
    moveEvent,
  };
}
