import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { passwordConfigured } from "@/lib/auth";
import {
  SESSION_COOKIE,
  authDisabled,
  sessionSecret,
  verifySession,
} from "@/lib/session";

export const dynamic = "force-dynamic";

// Indique à la page /login s'il faut créer le mot de passe (première visite) ou
// simplement le saisir, et si la session en cours est déjà valide.
export async function GET() {
  // En mode AUTH_DISABLED, on court-circuite : toujours authentifié.
  if (authDisabled()) {
    return NextResponse.json({ configured: true, authenticated: true });
  }
  const token = cookies().get(SESSION_COOKIE)?.value;
  const session = await verifySession(token, sessionSecret());
  return NextResponse.json({
    configured: await passwordConfigured(),
    authenticated: Boolean(session),
  });
}
