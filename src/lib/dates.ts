/** Utilitaires de dates — semaine commençant le lundi, fuseau local. */

export function startOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // lundi = 0
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Minuit du jour donné (par défaut aujourd'hui). */
export function startOfDay(date: Date = new Date()): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Convertit une Date en chaîne ISO locale sans fuseau : 2026-07-14T09:00:00 */
export function toLocalIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:00`
  );
}

/** Parse une chaîne ISO locale (ou avec Z) en Date locale. */
export function parseIso(iso: string): Date {
  return new Date(iso);
}

const WEEKDAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const MONTHS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

export function weekdayShort(date: Date): string {
  return WEEKDAYS[(date.getDay() + 6) % 7];
}

export function formatDayNum(date: Date): string {
  return String(date.getDate());
}

export function formatRangeLabel(start: Date, days = 7): string {
  const end = addDays(start, days - 1);
  if (days === 1) {
    return `${start.getDate()} ${MONTHS[start.getMonth()]} ${start.getFullYear()}`;
  }
  if (start.getMonth() === end.getMonth()) {
    return `${start.getDate()} – ${end.getDate()} ${MONTHS[end.getMonth()]} ${end.getFullYear()}`;
  }
  return `${start.getDate()} ${MONTHS[start.getMonth()]} – ${end.getDate()} ${MONTHS[end.getMonth()]} ${end.getFullYear()}`;
}

export function formatTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* ----------------- Résolution de dates (déterministe) ---------------- */

const WEEKDAY_ALIASES: Record<string, number> = {
  // lundi = 0 … dimanche = 6 (même convention que startOfWeek)
  lundi: 0, lun: 0, monday: 0, mon: 0,
  mardi: 1, mar: 1, tuesday: 1, tue: 1,
  mercredi: 2, mer: 2, wednesday: 2, wed: 2,
  jeudi: 3, jeu: 3, thursday: 3, thu: 3,
  vendredi: 4, ven: 4, friday: 4, fri: 4,
  samedi: 5, sam: 5, saturday: 5, sat: 5,
  dimanche: 6, dim: 6, sunday: 6, sun: 6,
};

export const FULL_WEEKDAYS = [
  "lundi", "mardi", "mercredi", "jeudi",
  "vendredi", "samedi", "dimanche",
];

/** Indice lundi=0…dimanche=6 pour un nom de jour (fr/en, tolère la casse). */
export function weekdayIndex(name: string): number | null {
  const key = name.trim().toLowerCase();
  return key in WEEKDAY_ALIASES ? WEEKDAY_ALIASES[key] : null;
}

/** Indice lundi=0…dimanche=6 d'une Date. */
export function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

/**
 * Parse une date "souple" en Date locale à minuit :
 * "today"/"aujourd'hui", "tomorrow"/"demain", "next week"/"semaine prochaine",
 * ou une date ISO (YYYY-MM-DD…). Défaut : aujourd'hui.
 */
export function parseFlexibleDate(value?: string, base: Date = new Date()): Date {
  const today = startOfDay(base);
  if (!value) return today;
  const v = value.trim().toLowerCase();
  if (v === "today" || v === "aujourd'hui" || v === "aujourdhui") return today;
  if (v === "tomorrow" || v === "demain") return addDays(today, 1);
  if (v === "next week" || v === "semaine prochaine" || v === "la semaine prochaine") {
    return addDays(startOfWeek(today), 7);
  }
  const parsed = new Date(v.length <= 10 ? `${v}T00:00:00` : v);
  return isNaN(parsed.getTime()) ? today : startOfDay(parsed);
}

/**
 * Toutes les dates d'un jour de semaine donné, entre `from` (inclus) et
 * `until` (inclus). Si `until` absent, renvoie les `count` premières (défaut 8).
 * Calcul 100% déterministe côté serveur — le LLM ne calcule jamais de dates.
 */
export function datesForWeekday(
  weekday: string,
  from: Date,
  until?: Date,
  count = 8
): Date[] {
  const target = weekdayIndex(weekday);
  if (target === null) return [];
  const start = startOfDay(from);
  // Premier jour >= from qui tombe sur le bon jour de semaine.
  const delta = (target - mondayIndex(start) + 7) % 7;
  let cursor = addDays(start, delta);
  const out: Date[] = [];
  const limit = until ? startOfDay(until) : null;
  while (limit ? cursor.getTime() <= limit.getTime() : out.length < count) {
    out.push(new Date(cursor));
    cursor = addDays(cursor, 7);
    if (out.length > 520) break; // garde-fou
  }
  return out;
}

/** Libellé humain d'une date, ex: "mardi 14 juillet 2026". */
export function formatFullDate(date: Date): string {
  return `${FULL_WEEKDAYS[mondayIndex(date)]} ${date.getDate()} ${
    MONTHS[date.getMonth()]
  } ${date.getFullYear()}`;
}

/**
 * Aperçu des 14 prochains jours (aujourd'hui inclus) sous forme de lignes
 * "mardi 14 juillet 2026". Injecté dans le prompt pour ancrer le modèle.
 */
export function upcomingDaysPreview(base: Date = new Date(), days = 14): string {
  const start = startOfDay(base);
  return Array.from({ length: days }, (_, i) =>
    formatFullDate(addDays(start, i))
  ).join("\n");
}

/**
 * Les deux ancres de semaine, RÉSOLUES côté serveur, à injecter dans un prompt.
 *
 * Un modèle qui calcule lui-même « le lundi de la semaine prochaine » se
 * trompe de sept jours dès que la conversation a lieu un dimanche (convention
 * US : la semaine commence le dimanche) — vécu, une semaine entière planifiée
 * et validée au mauvais endroit. On lui donne donc la réponse.
 */
export function weekAnchors(base: Date = new Date()): string {
  const line = (label: string, monday: Date) =>
    `${label} : ${formatFullDate(monday)} → ${formatFullDate(addDays(monday, 6))} (weekStart=${toLocalIso(
      monday
    ).slice(0, 10)})`;
  const thisMonday = startOfWeek(base);
  return [
    line("SEMAINE EN COURS", thisMonday),
    line("SEMAINE PROCHAINE", addDays(thisMonday, 7)),
  ].join("\n");
}
