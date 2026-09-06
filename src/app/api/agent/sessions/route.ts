import { NextResponse } from "next/server";
import { listSessions, createSession } from "@/lib/store";
import { provisionalTitle } from "@/lib/summary";

export const dynamic = "force-dynamic";

/** GET /api/agent/sessions?mode=agenda — liste les sessions d'un mode. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") || "agenda";
  const sessions = await listSessions(mode);
  return NextResponse.json(sessions);
}

/**
 * POST /api/agent/sessions
 * Body: { mode, firstUserMessage }
 *
 * Crée la session IMMÉDIATEMENT, avec un titre provisoire tiré du message. Le
 * titre soigné est un appel LLM : il se demande ensuite en PATCH, en parallèle
 * de l'agent. Le faire ici retardait la réponse de ~3 s pour un libellé que
 * personne ne regarde à cet instant.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const mode: string = body.mode || "agenda";
  // Les séances du Conseil sont éphémères : jamais archivées en session.
  if (mode === "council") {
    return NextResponse.json({ error: "le conseil n'a pas de sessions" }, { status: 400 });
  }
  const firstMessage: string = body.firstUserMessage || "";

  const session = await createSession(mode, provisionalTitle(firstMessage));
  return NextResponse.json(session);
}
