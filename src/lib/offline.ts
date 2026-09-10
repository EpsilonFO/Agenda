import type { Attendee, EventItem } from "./types";
import { colorFor } from "./colors";
import { noteNetworkFail, noteNetworkOk } from "./connectivity";

/**
 * Agenda hors ligne : cache local + file d'attente d'écritures.
 *
 * Principe (write-behind) : TOUTE modification d'événement faite dans l'UI
 * part d'abord dans une file d'attente (« outbox ») rangée dans le
 * localStorage, puis on tente de la pousser vers l'API tout de suite. Sans
 * réseau, elle reste dans la file et repart à la reconnexion. L'affichage,
 * lui, applique la file par-dessus le dernier instantané connu du serveur :
 * l'agenda est donc toujours à jour à l'écran, en ligne comme hors ligne.
 *
 * Le stockage est du localStorage (synchrone, trivial à inspecter) : un agenda
 * personnel pèse quelques dizaines de Ko, très loin du quota de ~5 Mo.
 */

const SNAPSHOT_KEY = "agenda.events.v1";
const OUTBOX_KEY = "agenda.outbox.v1";

/** Préfixe des ids d'événements créés hors ligne (avant leur vrai id serveur). */
export const LOCAL_ID_PREFIX = "local-";

export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX);
}

/** Champs qu'un client a le droit d'envoyer à l'API (cf. api/events). */
export type EventPayload = {
  title?: string;
  start?: string;
  end?: string;
  description?: string;
  location?: string;
  category?: string;
  color?: string;
  reminderMin?: number;
  attendees?: (string | Attendee)[];
  inviteAccountId?: string;
};

export type PendingOp = {
  opId: string;
  kind: "create" | "update" | "delete";
  /** Id de l'événement visé — `local-…` tant que la création n'est pas partie. */
  eventId: string;
  payload?: EventPayload;
  at: string;
};

export type FlushResult = {
  /** Nombre d'opérations effectivement enregistrées côté serveur. */
  sent: number;
  /** Opérations abandonnées définitivement (refus du serveur), avec la raison. */
  dropped: string[];
  /** true si la file reste non vide faute de réseau. */
  offline: boolean;
};

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Nouvel id provisoire pour un événement créé sans réseau. */
export function localEventId(): string {
  return `${LOCAL_ID_PREFIX}${uid()}`;
}

export function newOp(
  kind: PendingOp["kind"],
  eventId: string,
  payload?: EventPayload
): PendingOp {
  return { opId: uid(), kind, eventId, payload, at: new Date().toISOString() };
}

/* --------------------------- Logique pure ---------------------------- */

/**
 * Ajoute une opération à la file, en fusionnant ce qui peut l'être :
 *   - une retouche d'un événement encore en attente de création est absorbée
 *     par la création (un seul POST partira) ;
 *   - deux retouches successives du même événement fusionnent (déplacer trois
 *     fois un événement hors ligne ne fait pas trois PUT) ;
 *   - supprimer un événement jamais parti annule simplement sa création.
 * Résultat : la file reste courte et son ordre reste celui des actions.
 */
export function enqueueOp(ops: PendingOp[], op: PendingOp): PendingOp[] {
  const next = [...ops];

  if (op.kind === "delete") {
    const pendingCreate = next.some(
      (o) => o.eventId === op.eventId && o.kind === "create"
    );
    // Les retouches en attente sur cet événement n'ont plus d'objet.
    const kept = next.filter((o) => o.eventId !== op.eventId);
    // Création jamais partie : on oublie tout, il n'y a rien à envoyer.
    return pendingCreate ? kept : [...kept, op];
  }

  if (op.kind === "update") {
    // Fusion uniquement avec la DERNIÈRE opération portant sur cet événement,
    // et seulement si c'est aussi la dernière de la file : sinon on changerait
    // l'ordre des écritures.
    const last = next[next.length - 1];
    if (last && last.eventId === op.eventId && last.kind !== "delete") {
      next[next.length - 1] = {
        ...last,
        payload: { ...last.payload, ...op.payload },
        at: op.at,
      };
      return next;
    }
  }

  return [...next, op];
}

/** Rebaptise un id provisoire en id serveur dans toute la file. */
export function remapOps(
  ops: PendingOp[],
  fromId: string,
  toId: string
): PendingOp[] {
  return ops.map((o) => (o.eventId === fromId ? { ...o, eventId: toId } : o));
}

/**
 * Vue affichable : l'instantané serveur, recouvert par les modifications
 * encore en attente. Les événements touchés portent `pendingSync` pour que
 * l'UI puisse les signaler.
 */
export function applyPending(
  base: EventItem[],
  ops: PendingOp[]
): EventItem[] {
  const map = new Map(base.map((e) => [e.id, e]));

  for (const op of ops) {
    if (op.kind === "delete") {
      map.delete(op.eventId);
      continue;
    }

    // Les invités sont saisis en emails côté formulaire ; le serveur en fait
    // des objets. Localement on les affiche tels quels.
    const { attendees: rawAttendees, inviteAccountId, ...patch } =
      op.payload ?? {};
    void inviteAccountId; // sert au serveur, pas à l'affichage
    const attendees = normalizeLocalAttendees(rawAttendees);
    const color =
      patch.color || (patch.category ? colorFor(patch.category) : undefined);

    if (op.kind === "create") {
      // Une création sans titre/début/fin serait refusée par l'API : on ne
      // l'affiche pas non plus.
      if (!patch.title || !patch.start || !patch.end) continue;
      map.set(op.eventId, {
        ...patch,
        title: patch.title,
        start: patch.start,
        end: patch.end,
        color: color || colorFor(undefined),
        ...(attendees ? { attendees } : {}),
        id: op.eventId,
        createdAt: op.at,
        updatedAt: op.at,
        pendingSync: true,
      });
      continue;
    }

    // Retouche d'un événement absent de l'instantané (supprimé ailleurs) :
    // rien à afficher, l'opération sera abandonnée au flush.
    const current = map.get(op.eventId);
    if (!current) continue;
    map.set(op.eventId, {
      ...current,
      ...patch,
      ...(color ? { color } : {}),
      ...(attendees ? { attendees } : {}),
      updatedAt: op.at,
      pendingSync: true,
    });
  }

  return [...map.values()].sort((a, b) => a.start.localeCompare(b.start));
}

function normalizeLocalAttendees(
  input: EventPayload["attendees"]
): Attendee[] | undefined {
  if (!input) return undefined;
  return input.map((a) => (typeof a === "string" ? { email: a } : a));
}

/* ----------------------------- Stockage ------------------------------ */

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // Safari en navigation privée peut lever ici
  }
}

function readKey<T>(key: string, fallback: T): T {
  const s = store();
  if (!s) return fallback;
  try {
    const raw = s.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeKey(key: string, value: unknown): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(key, JSON.stringify(value));
  } catch {
    // Quota dépassé : on préfère perdre le cache qu'empêcher l'utilisateur
    // d'utiliser l'app.
  }
}

export type Snapshot = { savedAt: string; events: EventItem[] };

export function readSnapshot(): Snapshot | null {
  return readKey<Snapshot | null>(SNAPSHOT_KEY, null);
}

export function writeSnapshot(events: EventItem[]): void {
  writeKey(SNAPSHOT_KEY, {
    savedAt: new Date().toISOString(),
    // On ne garde pas les marqueurs d'attente dans le cache serveur.
    events: events.map((e) => {
      const clean = { ...e };
      delete clean.pendingSync;
      return clean;
    }),
  } satisfies Snapshot);
}

export function readOutbox(): PendingOp[] {
  const ops = readKey<PendingOp[]>(OUTBOX_KEY, []);
  return Array.isArray(ops) ? ops : [];
}

export function writeOutbox(ops: PendingOp[]): void {
  writeKey(OUTBOX_KEY, ops);
}

/** Ajoute une opération à la file persistée et renvoie la file complète. */
export function pushOp(op: PendingOp): PendingOp[] {
  const next = enqueueOp(readOutbox(), op);
  writeOutbox(next);
  return next;
}

/* ------------------------------ Envoi -------------------------------- */

/** Une seule vidange à la fois (reconnexion + timer peuvent tomber ensemble). */
let flushing: Promise<FlushResult> | null = null;

/**
 * Rejoue la file d'attente dans l'ordre, en la persistant après chaque
 * opération réussie : une coupure en plein milieu ne rejoue jamais deux fois
 * la même écriture.
 */
export function flushOutbox(): Promise<FlushResult> {
  if (flushing) return flushing;
  flushing = runFlush().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function runFlush(): Promise<FlushResult> {
  const dropped: string[] = [];
  let sent = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ops = readOutbox();
    const op = ops[0];
    if (!op) return { sent, dropped, offline: false };

    let outcome: OpOutcome;
    try {
      outcome = await sendOp(op);
      noteNetworkOk();
    } catch {
      // Échec réseau : la file est intacte, on retentera plus tard.
      noteNetworkFail();
      return { sent, dropped, offline: true };
    }

    if (outcome.retry) {
      return { sent, dropped, offline: true };
    }

    // Opération traitée (réussie ou abandonnée) : on la retire de la file.
    let rest = readOutbox().filter((o) => o.opId !== op.opId);
    if (outcome.serverId && isLocalId(op.eventId)) {
      rest = remapOps(rest, op.eventId, outcome.serverId);
    }
    writeOutbox(rest);

    if (outcome.error) dropped.push(outcome.error);
    else sent += 1;
  }
}

type OpOutcome = {
  /** Id serveur obtenu à la création (pour rebaptiser les opérations suivantes). */
  serverId?: string;
  /** Renseigné si le serveur a refusé définitivement : opération abandonnée. */
  error?: string;
  /** true = à retenter plus tard (serveur en vrac), la file reste en place. */
  retry?: boolean;
};

async function sendOp(op: PendingOp): Promise<OpOutcome> {
  const label = op.payload?.title ? ` « ${op.payload.title} »` : "";

  if (op.kind === "delete") {
    // Un événement jamais parti ne peut pas être supprimé côté serveur.
    if (isLocalId(op.eventId)) return {};
    const res = await fetch(`/api/events/${op.eventId}`, { method: "DELETE" });
    // 404 : déjà supprimé côté serveur — le résultat voulu est atteint.
    if (res.ok || res.status === 404) return {};
    return outcomeFor(res, `Suppression refusée${label}`);
  }

  if (op.kind === "create") {
    const res = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(op.payload ?? {}),
    });
    if (!res.ok) return outcomeFor(res, `Création refusée${label}`);
    const created = (await res.json()) as EventItem;
    return { serverId: created?.id };
  }

  // Retouche d'un événement encore en attente de création : sa création a
  // déjà absorbé le patch (cf. enqueueOp), il n'y a rien à envoyer.
  if (isLocalId(op.eventId)) return {};
  const res = await fetch(`/api/events/${op.eventId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(op.payload ?? {}),
  });
  if (res.ok) return {};
  // 404 : l'événement a disparu côté serveur (supprimé ailleurs, retiré par la
  // synchro Google) — la retouche n'a plus d'objet.
  if (res.status === 404) {
    return { error: `Modification perdue${label} : l'événement n'existe plus.` };
  }
  return outcomeFor(res, `Modification refusée${label}`);
}

function outcomeFor(res: Response, prefix: string): OpOutcome {
  // 5xx ou 401 (session à rafraîchir) : ce n'est pas la faute de l'opération,
  // on la garde et on retentera.
  if (res.status >= 500 || res.status === 401) return { retry: true };
  return { error: `${prefix} (erreur ${res.status}).` };
}
