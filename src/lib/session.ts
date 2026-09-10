/**
 * Cookie de session signé (HMAC-SHA256), 100% Web Crypto pour fonctionner
 * aussi bien dans le middleware (runtime edge) que dans les routes API (node).
 * N'importe AUCUN module Node ici — c'est aussi pourquoi les réglages communs
 * (origine, durée, secret) vivent dans ce fichier plutôt que dans auth.ts.
 */

export const SESSION_COOKIE = "agenda_session";

/**
 * true = auth désactivée (développement local uniquement).
 * Activé par AUTH_DISABLED=true dans .env.local — jamais en prod.
 */
export function authDisabled(): boolean {
  return process.env.AUTH_DISABLED === "true";
}

/** Origine publique de l'app (sert aussi de base à l'OAuth Google). */
export function appOrigin(): string {
  return (
    process.env.APP_ORIGIN ||
    process.env.WEBAUTHN_ORIGIN || // ancien nom, gardé pour ne rien casser
    "http://localhost:3002"
  );
}

export function sessionSecret(): string {
  return process.env.SESSION_SECRET || "";
}

/**
 * Durée de vie du cookie. Volontairement longue (1 an par défaut) : la session
 * est de toute façon reconduite à chaque visite (voir `shouldRefresh`), donc en
 * pratique on ne retape le mot de passe que si on ne vient pas de tout un an.
 */
export function sessionDays(): number {
  const n = Number(process.env.SESSION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 365;
}

/** Cookies sécurisés dès que l'origin est en https (donc pas en local http). */
export function cookieSecure(): boolean {
  return appOrigin().startsWith("https://");
}

/** Options communes du cookie de session (même valeur à l'écriture partout). */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax" as const,
    path: "/",
    maxAge: sessionDays() * 24 * 60 * 60,
  };
}

type Payload = { sub: string; exp: number };

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromB64url(s: string): Uint8Array {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = t.length % 4 ? 4 - (t.length % 4) : 0;
  t += "=".repeat(pad);
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return b64urlFromBytes(new Uint8Array(sig));
}

/** Comparaison à temps constant (évite les attaques temporelles). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Crée un jeton de session valable `days` jours pour le sujet `sub`. */
export async function signSession(
  sub: string,
  secret: string,
  days: number
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
  const payload: Payload = { sub, exp };
  const body = b64urlFromBytes(enc.encode(JSON.stringify(payload)));
  const sig = await hmac(body, secret);
  return `${body}.${sig}`;
}

/** Vérifie signature + expiration. Renvoie le payload ou null. */
export async function verifySession(
  token: string | undefined,
  secret: string
): Promise<Payload | null> {
  if (!token) return null;
  // Secret absent : personne ne peut être connecté — on refuse, on ne plante
  // pas. Vécu en prod : un .env.local perdu sur le VPS et WebCrypto jetait
  // « Zero-length key is not supported » depuis le middleware, soit une 500
  // opaque sur TOUTES les pages au lieu d'une redirection vers le login.
  if (!secret) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = await hmac(body, secret);
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(dec.decode(bytesFromB64url(body))) as Payload;
    if (typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Session glissante : au-delà de la moitié de sa vie, on réémet le jeton pour
 * repartir d'une durée pleine. Tant qu'on ouvre l'agenda de temps en temps, la
 * session ne s'éteint jamais — c'est ça qui évite de retaper le mot de passe.
 */
export function shouldRefresh(payload: Payload, days: number): boolean {
  const remaining = payload.exp - Math.floor(Date.now() / 1000);
  return remaining < (days * 24 * 60 * 60) / 2;
}
