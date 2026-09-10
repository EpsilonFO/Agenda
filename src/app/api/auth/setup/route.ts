import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  MIN_PASSWORD_LENGTH,
  USER_NAME,
  passwordConfigured,
  setPassword,
  verifyPassword,
} from "@/lib/auth";
import {
  SESSION_COOKIE,
  safeEqual,
  sessionCookieOptions,
  sessionDays,
  sessionSecret,
  signSession,
} from "@/lib/session";
import { registerFailure, throttle } from "@/lib/loginThrottle";

export const dynamic = "force-dynamic";

/** Code de secours exigé pour poser un mot de passe sans en connaître un. */
function setupCode(): string {
  return process.env.SETUP_CODE || process.env.ENROLL_CODE || "";
}

/**
 * Première configuration ET changement de mot de passe.
 *
 * Pour prouver qu'on est bien le propriétaire, il faut soit le mot de passe
 * actuel (`current`), soit le code de secours de .env.local (`code`) — sans
 * quoi n'importe qui tombant sur l'URL pourrait s'attribuer l'agenda.
 */
export async function POST(req: Request) {
  const wait = throttle(req);
  if (wait > 0) {
    return NextResponse.json(
      { error: `Trop de tentatives. Réessaie dans ${wait} s.` },
      { status: 429 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    password?: string;
    current?: string;
    code?: string;
  };
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Mot de passe trop court (${MIN_PASSWORD_LENGTH} caractères minimum).` },
      { status: 400 }
    );
  }

  const code = setupCode();
  const codeOk = Boolean(code) && Boolean(body.code) && safeEqual(body.code!.trim(), code);
  const currentOk = Boolean(body.current) && (await verifyPassword(body.current!));

  if (!codeOk && !currentOk) {
    registerFailure(req);
    if (!code && !(await passwordConfigured())) {
      return NextResponse.json(
        { error: "Aucun code de secours configuré (SETUP_CODE dans .env.local)." },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: "Code de secours ou mot de passe actuel invalide." },
      { status: 403 }
    );
  }

  await setPassword(password);

  const token = await signSession(USER_NAME, sessionSecret(), sessionDays());
  cookies().set(SESSION_COOKIE, token, sessionCookieOptions());
  return NextResponse.json({ ok: true });
}
