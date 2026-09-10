/**
 * Anti-force-brute minimaliste pour /api/auth/login.
 *
 * Compteur en mémoire par IP : au-delà de quelques essais ratés, on impose une
 * attente qui double à chaque échec (plafonnée à 5 min). Suffisant pour une app
 * mono-utilisateur — un redémarrage remet les compteurs à zéro, et c'est très
 * bien : c'est un ralentisseur, pas un verrou.
 */

const MAX_FREE_ATTEMPTS = 5;
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 5 * 60_000;
/** Un quart d'heure sans tentative et on oublie l'IP. */
const FORGET_MS = 15 * 60_000;

type Entry = { failures: number; last: number };
const attempts = new Map<string, Entry>();

function ipOf(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

function delayFor(failures: number): number {
  if (failures <= MAX_FREE_ATTEMPTS) return 0;
  const steps = failures - MAX_FREE_ATTEMPTS - 1;
  return Math.min(BASE_DELAY_MS * 2 ** steps, MAX_DELAY_MS);
}

/** Secondes d'attente restantes avant d'accepter une nouvelle tentative (0 = ok). */
export function throttle(req: Request): number {
  const key = ipOf(req);
  const entry = attempts.get(key);
  if (!entry) return 0;
  const now = Date.now();
  if (now - entry.last > FORGET_MS) {
    attempts.delete(key);
    return 0;
  }
  const remaining = entry.last + delayFor(entry.failures) - now;
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

export function registerFailure(req: Request): void {
  const key = ipOf(req);
  const entry = attempts.get(key);
  attempts.set(key, {
    failures: (entry?.failures ?? 0) + 1,
    last: Date.now(),
  });
}
