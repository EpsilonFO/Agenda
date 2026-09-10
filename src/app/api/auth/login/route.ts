import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { USER_NAME, verifyPassword } from "@/lib/auth";
import {
  SESSION_COOKIE,
  sessionCookieOptions,
  sessionDays,
  sessionSecret,
  signSession,
} from "@/lib/session";
import { registerFailure, throttle } from "@/lib/loginThrottle";

export const dynamic = "force-dynamic";

/** Connexion par mot de passe : ouvre une session longue (cookie signé). */
export async function POST(req: Request) {
  const wait = throttle(req);
  if (wait > 0) {
    return NextResponse.json(
      { error: `Trop de tentatives. Réessaie dans ${wait} s.` },
      { status: 429 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { password?: string };
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) {
    return NextResponse.json({ error: "Mot de passe manquant." }, { status: 400 });
  }

  if (!(await verifyPassword(password))) {
    registerFailure(req);
    return NextResponse.json({ error: "Mot de passe incorrect." }, { status: 401 });
  }

  const token = await signSession(USER_NAME, sessionSecret(), sessionDays());
  cookies().set(SESSION_COOKIE, token, sessionCookieOptions());
  return NextResponse.json({ ok: true });
}
