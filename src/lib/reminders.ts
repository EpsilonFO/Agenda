import { promises as fs } from "fs";
import path from "path";
import { listEvents } from "./store";
import { parseIso, formatTime } from "./dates";
import { sendToAll } from "./push";
import type { EventItem } from "./types";

/**
 * Rappels d'événements : à chaque passage du cron, on notifie les événements
 * qui commencent bientôt (dans la fenêtre de « préavis ») et qu'on n'a pas
 * encore signalés. L'état « déjà notifié » est persisté dans data/notified.json.
 *
 * Deux rappels par événement : un préavis pour se préparer (20 min), et un
 * dernier appel juste avant le début (1 min) — celui qu'on ne veut pas manquer
 * quand on a la tête ailleurs.
 */

const DATA_DIR = path.join(process.cwd(), "data");
const NOTIFIED_FILE = path.join(DATA_DIR, "notified.json");

/** Préavis par défaut, en minutes : préparation puis dernier appel. */
const DEFAULT_LEADS = [20, 1];

/**
 * Préavis en minutes, du plus lointain au plus proche.
 * `REMINDER_LEAD_MIN` accepte une liste (« 30,5,1 ») comme une valeur seule.
 */
const LEADS = parseLeads(process.env.REMINDER_LEAD_MIN);

/** Le passage périodique tourne toutes les minutes : sans marge, un rappel à
 *  1 min pourrait tomber pile entre deux passages et ne jamais partir. */
const TICK_TOLERANCE_MIN = 0.25;

/** Parse une liste de préavis (« 30,5,1 »), triée décroissante et dédoublonnée.
 *  Toute valeur illisible ou négative est ignorée ; liste vide → défaut. */
export function parseLeads(raw: string | undefined): number[] {
  const parsed = (raw ?? "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const leads = parsed.length > 0 ? parsed : DEFAULT_LEADS;
  return [...new Set(leads)].sort((a, b) => b - a);
}

/**
 * Préavis d'un événement, du plus lointain au plus proche.
 * `reminderMin` remplace le préavis de préparation, mais le dernier appel est
 * conservé : demander « préviens-moi 1 h avant » n'est pas renoncer au rappel
 * du début.
 */
export function leadsFor(
  ev: Pick<EventItem, "reminderMin">,
  leads: number[] = LEADS
): number[] {
  if (typeof ev.reminderMin !== "number" || ev.reminderMin <= 0) return leads;
  const lastCall = leads[leads.length - 1];
  return [...new Set([ev.reminderMin, lastCall])].sort((a, b) => b - a);
}

/** Ce préavis est-il échu, à la tolérance de passage près ? */
export function isDue(minsUntil: number, lead: number): boolean {
  return minsUntil >= 0 && minsUntil <= lead + TICK_TOLERANCE_MIN;
}

/** Clé « déjà notifié » : un marqueur par événement ET par préavis. Elle
 *  contient l'heure de début, donc un événement déplacé se re-notifie. */
function notifiedKey(ev: Pick<EventItem, "id" | "start">, lead: number): string {
  return `${ev.id}@${ev.start}#${lead}`;
}

type NotifiedMap = Record<string, string>; // clé -> ISO d'envoi

async function readNotified(): Promise<NotifiedMap> {
  try {
    const raw = await fs.readFile(NOTIFIED_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeNotified(map: NotifiedMap): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(NOTIFIED_FILE, JSON.stringify(map, null, 2), "utf8");
}

export type ReminderRun = {
  checked: number;
  due: number;
  pushed: number;
};

/**
 * Passe en revue les événements et notifie ceux dont un préavis est échu.
 * Idempotent : chaque (événement, préavis) n'est notifié qu'une fois, et un
 * passage n'envoie qu'un rappel par événement — le plus proche du début.
 * `now` est injecté (pas de Date dans les modules partagés).
 */
export async function runReminders(now: Date): Promise<ReminderRun> {
  const events = await listEvents();
  const notified = await readNotified();
  const nowMs = now.getTime();

  let due = 0;
  let pushed = 0;

  for (const ev of events) {
    const startMs = parseIso(ev.start).getTime();
    if (Number.isNaN(startMs)) continue;
    const minsUntil = (startMs - nowMs) / 60000;
    // Préavis échus et pas encore envoyés pour cet événement.
    const dueLeads = leadsFor(ev).filter(
      (lead) => isDue(minsUntil, lead) && !notified[notifiedKey(ev, lead)]
    );
    if (dueLeads.length === 0) continue;

    due++;
    // Un seul envoi par passage : le rappel le plus proche du début (les
    // préavis sont triés décroissants). Les plus lointains encore dus sont
    // dépassés — serveur arrêté, événement déplacé — on les marque sans
    // enchaîner deux notifications d'affilée.
    const lead = dueLeads[dueLeads.length - 1];
    const rounded = Math.max(1, Math.round(minsUntil));
    const parts = [`Dans ${rounded} min · ${formatTime(parseIso(ev.start))}`];
    if (ev.location) parts.push(ev.location);
    const sent = await sendToAll({
      title: ev.title,
      body: parts.join(" · "),
      url: "/",
      // Un tag par préavis : le dernier appel s'annonce comme une notification
      // à part entière au lieu de remplacer le préavis en silence.
      tag: `${ev.id}#${lead}`,
    });
    if (sent > 0) pushed++;
    for (const l of dueLeads) notified[notifiedKey(ev, l)] = now.toISOString();
  }

  // Purge des marqueurs de plus de 24 h pour garder le fichier léger.
  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  for (const [key, iso] of Object.entries(notified)) {
    if (new Date(iso).getTime() < cutoff) delete notified[key];
  }
  await writeNotified(notified);

  return { checked: events.length, due, pushed };
}
