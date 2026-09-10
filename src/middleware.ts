import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  authDisabled,
  sessionCookieOptions,
  sessionDays,
  sessionSecret,
  shouldRefresh,
  signSession,
  verifySession,
} from "@/lib/session";

/**
 * Verrouille toute l'app derrière la session (mot de passe).
 * Exemptions : la page de login, les routes d'auth, le cron (protégé par son
 * propre secret) et les fichiers statiques nécessaires à la PWA.
 */

const PUBLIC_PATHS = ["/login"];
const PUBLIC_FILES = ["/manifest.webmanifest", "/sw.js", "/favicon.ico"];
const PUBLIC_PREFIXES = ["/api/auth", "/api/cron", "/icons"];

export async function middleware(req: NextRequest) {
  // Bypass total en dev local (AUTH_DISABLED=true) : accès direct à l'agenda.
  if (authDisabled()) return NextResponse.next();

  const { pathname } = req.nextUrl;

  const isPublic =
    PUBLIC_PATHS.includes(pathname) ||
    PUBLIC_FILES.includes(pathname) ||
    PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
  if (isPublic) return NextResponse.next();

  const secret = sessionSecret();
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token, secret);
  if (session) {
    const res = NextResponse.next();
    // Session glissante : passé la moitié de sa vie, on la reconduit. C'est ce
    // qui fait qu'on ne retape jamais le mot de passe tant qu'on utilise l'app.
    const days = sessionDays();
    if (shouldRefresh(session, days)) {
      const fresh = await signSession(session.sub, secret, days);
      res.cookies.set(SESSION_COOKIE, fresh, sessionCookieOptions());
    }
    return res;
  }

  // API protégée → 401 ; page protégée → redirection vers le login.
  if (pathname.startsWith("/api")) {
    return NextResponse.json({ error: "non authentifié" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Middleware sur tout, sauf les assets internes de Next.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
