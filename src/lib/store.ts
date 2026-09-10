import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import type {
  EventItem,
  MemoryItem,
  Place,
  TravelTime,
  Activity,
  TransportProfile,
  WeekPlan,
  ChatHistoryEntry,
  Session,
} from "./types";
import { addTombstone } from "./google/tombstones";
import { colorFor } from "./colors";

/**
 * Stockage local ultra-simple sur fichiers JSON.
 * Objectif : rester "facilement modifiable" — tu peux ouvrir et éditer
 * les fichiers data/*.json à la main si besoin.
 */

const DATA_DIR = path.join(process.cwd(), "data");
const EVENTS_FILE = path.join(DATA_DIR, "events.json");
const MEMORY_FILE = path.join(DATA_DIR, "memory.json");
const PLACES_FILE = path.join(DATA_DIR, "places.json");
const TRAVEL_FILE = path.join(DATA_DIR, "travel-times.json");
const ACTIVITIES_FILE = path.join(DATA_DIR, "activities.json");
const PROFILE_FILE = path.join(DATA_DIR, "profile.json");
const PLANS_FILE = path.join(DATA_DIR, "plans.json");
const CHAT_HISTORY_FILE = path.join(DATA_DIR, "chat-history.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

/* ------------- Couleurs automatiques par catégorie ------------- */

// Les couleurs vivent dans un module sans dépendance Node : le navigateur en a
// besoin pour colorier un événement créé hors ligne (voir lib/colors.ts).
export { colorFor };

async function ensureFile(file: string, fallback: string): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, fallback, "utf8");
  }
}

async function readJson<T>(file: string): Promise<T[]> {
  await ensureFile(file, "[]");
  const raw = await fs.readFile(file, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writeJson<T>(file: string, data: T[]): Promise<void> {
  await ensureFile(file, "[]");
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

function id(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

/**
 * CRUD générique sur une collection JSON identifiée par `id`.
 * Réutilisé pour lieux, trajets et activités.
 */
function collection<T extends { id: string; updatedAt: string }>(file: string) {
  return {
    async list(): Promise<T[]> {
      return readJson<T>(file);
    },
    async create(
      input: Omit<T, "id" | "createdAt" | "updatedAt"> & Partial<Pick<T, "id">>
    ): Promise<T> {
      const items = await readJson<T>(file);
      const item = {
        ...(input as object),
        id: id(),
        createdAt: now(),
        updatedAt: now(),
      } as unknown as T;
      items.push(item);
      await writeJson(file, items);
      return item;
    },
    async update(itemId: string, patch: Partial<T>): Promise<T | null> {
      const items = await readJson<T>(file);
      const idx = items.findIndex((it) => it.id === itemId);
      if (idx === -1) return null;
      items[idx] = { ...items[idx], ...patch, updatedAt: now() };
      await writeJson(file, items);
      return items[idx];
    },
    async remove(itemId: string): Promise<boolean> {
      const items = await readJson<T>(file);
      const next = items.filter((it) => it.id !== itemId);
      if (next.length === items.length) return false;
      await writeJson(file, next);
      return true;
    },
  };
}

/* ---------------------------- Événements ---------------------------- */

export async function listEvents(): Promise<EventItem[]> {
  const events = await readJson<EventItem>(EVENTS_FILE);
  return events.sort((a, b) => a.start.localeCompare(b.start));
}

export async function createEvent(
  input: Omit<EventItem, "id" | "createdAt" | "updatedAt">
): Promise<EventItem> {
  const events = await readJson<EventItem>(EVENTS_FILE);
  const event: EventItem = {
    ...input,
    color: input.color || colorFor(input.category),
    id: id(),
    createdAt: now(),
    updatedAt: now(),
  };
  events.push(event);
  await writeJson(EVENTS_FILE, events);
  return event;
}

export async function updateEvent(
  eventId: string,
  patch: Partial<Omit<EventItem, "id" | "createdAt">>
): Promise<EventItem | null> {
  const events = await readJson<EventItem>(EVENTS_FILE);
  const idx = events.findIndex((e) => e.id === eventId);
  if (idx === -1) return null;
  const color = patch.color || (patch.category ? colorFor(String(patch.category)) : undefined);
  events[idx] = { ...events[idx], ...patch, ...(color ? { color } : {}), updatedAt: now() };
  await writeJson(EVENTS_FILE, events);
  return events[idx];
}

export async function getEvent(eventId: string): Promise<EventItem | null> {
  const events = await readJson<EventItem>(EVENTS_FILE);
  return events.find((e) => e.id === eventId) || null;
}

export async function deleteEvent(eventId: string): Promise<boolean> {
  const events = await readJson<EventItem>(EVENTS_FILE);
  const removed = events.find((e) => e.id === eventId);
  if (!removed) return false;
  const next = events.filter((e) => e.id !== eventId);
  await writeJson(EVENTS_FILE, next);
  // Événement importé de Google : on laisse une pierre tombale pour que la
  // synchro le supprime aussi côté Google (sinon il serait ré-importé au
  // passage suivant).
  if (removed.source === "google" && removed.google) {
    await addTombstone({
      accountId: removed.google.accountId,
      calendarId: removed.google.calendarId,
      eventId: removed.google.eventId,
      title: removed.title,
      deletedAt: now(),
    });
  }
  return true;
}

/**
 * Transaction lecture-modification-écriture sur TOUS les événements, en une
 * seule écriture du fichier. Utilisée par la synchro Google pour appliquer un
 * lot de créations / mises à jour / suppressions sans réécrire events.json N
 * fois. `fn` peut muter le tableau reçu ou en renvoyer un nouveau.
 */
export async function mutateEvents(
  fn: (events: EventItem[]) => EventItem[] | void
): Promise<EventItem[]> {
  const events = await readJson<EventItem>(EVENTS_FILE);
  const next = fn(events) ?? events;
  await writeJson(EVENTS_FILE, next);
  return next;
}

/** Identifiant neuf pour un événement créé hors `createEvent` (synchro). */
export function newEventId(): string {
  return id();
}

/* ------------------------------ Mémoire ----------------------------- */

export async function listMemory(): Promise<MemoryItem[]> {
  const items = await readJson<MemoryItem>(MEMORY_FILE);
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function addMemory(content: string): Promise<MemoryItem> {
  const items = await readJson<MemoryItem>(MEMORY_FILE);
  const item: MemoryItem = { id: id(), content, createdAt: now() };
  items.push(item);
  await writeJson(MEMORY_FILE, items);
  return item;
}

export async function deleteMemory(memoryId: string): Promise<boolean> {
  const items = await readJson<MemoryItem>(MEMORY_FILE);
  const next = items.filter((m) => m.id !== memoryId);
  if (next.length === items.length) return false;
  await writeJson(MEMORY_FILE, next);
  return true;
}

/* ------------------------------- Lieux ------------------------------ */

const placesCol = collection<Place>(PLACES_FILE);
export const listPlaces = placesCol.list;
export const createPlace = (input: Omit<Place, "id" | "createdAt" | "updatedAt">) =>
  placesCol.create(input);
export const updatePlace = placesCol.update;
export const deletePlace = placesCol.remove;

/* ----------------------------- Trajets ------------------------------ */

const travelCol = collection<TravelTime>(TRAVEL_FILE);
export const listTravelTimes = travelCol.list;
export const createTravelTime = (
  input: Omit<TravelTime, "id" | "updatedAt">
) => travelCol.create(input as Omit<TravelTime, "id" | "createdAt" | "updatedAt">);
export const updateTravelTime = travelCol.update;
export const deleteTravelTime = travelCol.remove;

/* ---------------------------- Activités ----------------------------- */

const activitiesCol = collection<Activity>(ACTIVITIES_FILE);
export const listActivities = activitiesCol.list;
export const createActivity = (
  input: Omit<Activity, "id" | "createdAt" | "updatedAt">
) => activitiesCol.create(input);
export const updateActivity = activitiesCol.update;
export const deleteActivity = activitiesCol.remove;

/* ---------------------------- Profil -------------------------------- */

const DEFAULT_PROFILE: TransportProfile = {
  transportModes: ["à pied", "vélo", "métro"],
  carDefault: false,
};

export async function getProfile(): Promise<TransportProfile> {
  await ensureFile(PROFILE_FILE, JSON.stringify(DEFAULT_PROFILE, null, 2));
  const raw = await fs.readFile(PROFILE_FILE, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PROFILE, ...parsed } as TransportProfile;
  } catch {
    return DEFAULT_PROFILE;
  }
}

export async function setProfile(
  patch: Partial<TransportProfile>
): Promise<TransportProfile> {
  const current = await getProfile();
  const next = { ...current, ...patch };
  await fs.writeFile(PROFILE_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/* ------------------------- Plans de semaine ------------------------- */

/**
 * Persiste un plan de semaine complet (une entrée par `weekStart`).
 * Écrase un plan déjà stocké pour la même semaine.
 */
export async function saveWeekPlan(plan: WeekPlan): Promise<WeekPlan> {
  const plans = await readJson<WeekPlan>(PLANS_FILE);
  const next = plans.filter((p) => p.weekStart !== plan.weekStart);
  next.push(plan);
  await writeJson(PLANS_FILE, next);
  return plan;
}

/** Renvoie le plan stocké pour une semaine donnée, ou null. */
export async function getWeekPlan(weekStart: string): Promise<WeekPlan | null> {
  const plans = await readJson<WeekPlan>(PLANS_FILE);
  return plans.find((p) => p.weekStart === weekStart) || null;
}

export async function listWeekPlans(): Promise<WeekPlan[]> {
  const plans = await readJson<WeekPlan>(PLANS_FILE);
  return plans.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/* ----------------------- Historique de conversation ------------------- */

/**
 * Nombre maximum de messages conservés par mode avant résumé.
 * Au-delà, les plus anciens sont tronqués (le résumé les remplace).
 */
export const CHAT_HISTORY_MAX = 60;

type ChatHistoryStore = Record<string, ChatHistoryEntry[]>;

async function readChatHistory(): Promise<ChatHistoryStore> {
  await ensureFile(CHAT_HISTORY_FILE, "{}");
  const raw = await fs.readFile(CHAT_HISTORY_FILE, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeChatHistory(store: ChatHistoryStore): Promise<void> {
  await ensureFile(CHAT_HISTORY_FILE, "{}");
  await fs.writeFile(CHAT_HISTORY_FILE, JSON.stringify(store, null, 2), "utf8");
}

/** Clé de stockage : "{mode}" pour la session active, "{mode}:{sessionId}" pour une session archivée. */
export function chatKey(mode: string, sessionId?: string): string {
  return sessionId ? `${mode}:${sessionId}` : mode;
}

/** Retourne l'historique d'un mode/session. */
export async function getChatHistory(mode: string, sessionId?: string): Promise<ChatHistoryEntry[]> {
  const store = await readChatHistory();
  return store[chatKey(mode, sessionId)] ?? [];
}

/** Remplace l'historique d'un mode/session par une nouvelle liste de messages. */
export async function setChatHistory(
  mode: string,
  entries: ChatHistoryEntry[],
  sessionId?: string
): Promise<void> {
  const store = await readChatHistory();
  store[chatKey(mode, sessionId)] = entries;
  await writeChatHistory(store);
}

/** Ajoute un message à l'historique d'un mode/session. Tronque si > CHAT_HISTORY_MAX. */
export async function appendChatHistory(
  mode: string,
  entry: ChatHistoryEntry,
  sessionId?: string
): Promise<void> {
  const store = await readChatHistory();
  const key = chatKey(mode, sessionId);
  const current = store[key] ?? [];
  current.push(entry);
  const summaries = current.filter((e) => e.role === "summary");
  const regular = current.filter((e) => e.role !== "summary");
  const trimmed = regular.slice(-CHAT_HISTORY_MAX);
  store[key] = [...summaries.slice(-1), ...trimmed];
  await writeChatHistory(store);
}

/* ----------------------------- Sessions -------------------------------- */

async function readSessions(): Promise<Session[]> {
  await ensureFile(SESSIONS_FILE, "[]");
  const raw = await fs.readFile(SESSIONS_FILE, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeSessions(sessions: Session[]): Promise<void> {
  await ensureFile(SESSIONS_FILE, "[]");
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2), "utf8");
}

/** Liste les sessions d'un mode, triées de la plus récente à la plus ancienne. */
export async function listSessions(mode: string): Promise<Session[]> {
  const all = await readSessions();
  return all
    .filter((s) => s.mode === mode)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Crée une nouvelle session. */
export async function createSession(mode: string, title: string): Promise<Session> {
  const sessions = await readSessions();
  const session: Session = {
    id: crypto.randomUUID(),
    mode,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  sessions.push(session);
  await writeSessions(sessions);
  return session;
}

/** Met à jour le titre d'une session. */
export async function updateSessionTitle(id: string, title: string): Promise<void> {
  const sessions = await readSessions();
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx === -1) return;
  sessions[idx].title = title;
  sessions[idx].updatedAt = new Date().toISOString();
  await writeSessions(sessions);
}

/** Supprime une session et son historique. */
export async function deleteSession(id: string): Promise<void> {
  const sessions = await readSessions();
  const session = sessions.find((s) => s.id === id);
  if (!session) return;
  // Efface l'historique associé
  const store = await readChatHistory();
  delete store[chatKey(session.mode, id)];
  await writeChatHistory(store);
  // Efface la session
  await writeSessions(sessions.filter((s) => s.id !== id));
}
