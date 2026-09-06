import { NextResponse } from "next/server";
import { getChatHistory, deleteSession, updateSessionTitle } from "@/lib/store";
import { generateSessionTitle } from "@/lib/summary";

export const dynamic = "force-dynamic";

/** GET /api/agent/sessions/[id]?mode=agenda — historique d'une session archivée. */
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") || "agenda";
  const history = await getChatHistory(mode, params.id);
  return NextResponse.json(history);
}

/**
 * PATCH /api/agent/sessions/[id] — remplace le titre provisoire par le titre
 * généré. Appelé sans être attendu, en parallèle de la requête à l'agent :
 * c'est un libellé de liste, il n'a aucune raison de passer devant la réponse.
 */
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const body = await req.json();
  const mode: string = body.mode || "agenda";
  const title = await generateSessionTitle(String(body.firstUserMessage || ""), mode);
  await updateSessionTitle(params.id, title);
  return NextResponse.json({ title });
}

/** DELETE /api/agent/sessions/[id] — supprime une session et son historique. */
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  await deleteSession(params.id);
  return NextResponse.json({ ok: true });
}
