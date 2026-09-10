/**
 * Configuration Google (variables d'environnement). Voir GOOGLE.md.
 */

export const CALLBACK_PATH = "/api/google/callback";

/** Portées demandées : événements (lecture/écriture), liste des calendriers, email du compte. */
export const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

export function googleClientId(): string {
  return process.env.GOOGLE_CLIENT_ID || "";
}

export function googleClientSecret(): string {
  return process.env.GOOGLE_CLIENT_SECRET || "";
}

/** true si les identifiants OAuth sont renseignés (sinon la fonctionnalité est masquée). */
export function googleConfigured(): boolean {
  return Boolean(googleClientId() && googleClientSecret());
}

/**
 * URI de redirection OAuth — doit être EXACTEMENT celle déclarée dans la
 * console Google Cloud. Priorité : GOOGLE_REDIRECT_URI, sinon
 * APP_ORIGIN + /api/google/callback, sinon l'origine de la requête.
 */
export function googleRedirectUri(requestOrigin?: string): string {
  const explicit = process.env.GOOGLE_REDIRECT_URI;
  if (explicit) return explicit;
  const origin = process.env.APP_ORIGIN || process.env.WEBAUTHN_ORIGIN || requestOrigin || "http://localhost:3002";
  return origin.replace(/\/+$/, "") + CALLBACK_PATH;
}

/** Fenêtre glissante synchronisée : passé / futur, en jours. */
export function syncWindowDays(): { past: number; future: number } {
  const past = Number(process.env.GOOGLE_SYNC_PAST_DAYS);
  const future = Number(process.env.GOOGLE_SYNC_FUTURE_DAYS);
  return {
    past: Number.isFinite(past) && past >= 0 ? past : 14,
    future: Number.isFinite(future) && future > 0 ? future : 90,
  };
}

/** Bornes de la fenêtre autour de `now`. */
export function syncWindow(now: Date): { start: Date; end: Date } {
  const { past, future } = syncWindowDays();
  const start = new Date(now.getTime() - past * 86_400_000);
  const end = new Date(now.getTime() + future * 86_400_000);
  return { start, end };
}

/** Période du passage automatique (ms). Défaut : 5 minutes. */
export function syncIntervalMs(): number {
  const min = Number(process.env.GOOGLE_SYNC_INTERVAL_MIN);
  return (Number.isFinite(min) && min > 0 ? min : 5) * 60_000;
}
