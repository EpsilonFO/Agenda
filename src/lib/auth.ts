import { promises as fs } from "fs";
import path from "path";

/**
 * Authentification par mot de passe (application mono-utilisateur).
 *
 * Le mot de passe n'est jamais stocké en clair : on garde un dérivé PBKDF2-
 * SHA256 (sel aléatoire) dans data/password.json, dans le même esprit fichier-
 * JSON que le reste du projet (store.ts). Pas de dépendance native : tout passe
 * par Web Crypto, comme session.ts.
 */

const DATA_DIR = path.join(process.cwd(), "data");
const PASSWORD_FILE = path.join(DATA_DIR, "password.json");

/** Sujet de la session (mono-utilisateur). */
export const USER_NAME = "felix";

/** Coût du dérivé. ~200k itérations : quelques dizaines de ms, imperceptible. */
const ITERATIONS = 210_000;
const KEY_BITS = 256;

type PasswordRecord = {
  algo: "pbkdf2-sha256";
  iterations: number;
  /** Sel aléatoire, base64url. */
  salt: string;
  /** Dérivé du mot de passe, base64url. */
  hash: string;
  updatedAt: string;
};

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  t += "=".repeat(t.length % 4 ? 4 - (t.length % 4) : 0);
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    KEY_BITS
  );
  return b64url(new Uint8Array(bits));
}

async function readRecord(): Promise<PasswordRecord | null> {
  try {
    const raw = await fs.readFile(PASSWORD_FILE, "utf8");
    const parsed = JSON.parse(raw) as PasswordRecord;
    return parsed && parsed.hash && parsed.salt ? parsed : null;
  } catch {
    return null;
  }
}

/** true si un mot de passe a déjà été défini (sinon : première configuration). */
export async function passwordConfigured(): Promise<boolean> {
  return (await readRecord()) !== null;
}

/** Longueur minimale exigée à la création / au changement. */
export const MIN_PASSWORD_LENGTH = 8;

/** Définit (ou remplace) le mot de passe. */
export async function setPassword(password: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const record: PasswordRecord = {
    algo: "pbkdf2-sha256",
    iterations: ITERATIONS,
    salt: b64url(salt),
    hash: await derive(password, salt, ITERATIONS),
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(PASSWORD_FILE, JSON.stringify(record, null, 2), "utf8");
}

/** Comparaison à temps constant des dérivés. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Vérifie un mot de passe proposé. false si aucun n'est configuré. */
export async function verifyPassword(password: string): Promise<boolean> {
  const record = await readRecord();
  if (!record) return false;
  const candidate = await derive(
    password,
    fromB64url(record.salt),
    record.iterations || ITERATIONS
  );
  return safeEqual(candidate, record.hash);
}
