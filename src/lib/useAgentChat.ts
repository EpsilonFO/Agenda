"use client";

import { Dispatch, SetStateAction, useCallback, useEffect, useState } from "react";
import type { WeekPlan, ChatHistoryEntry, Session } from "@/lib/types";
import { toLocalIso } from "@/lib/dates";
import { AGENT_ORDER, type ChatMode } from "@/lib/agents";

export type ChatMsg = {
  role: "user" | "assistant";
  content: string;
  actions?: string[];
  plan?: WeekPlan;
  planCommitted?: boolean;
};

/**
 * Erreur portant un message déjà rédigé pour l'utilisateur : permet de
 * distinguer un échec HTTP identifié d'une vraie coupure réseau.
 */
class AgentFetchError extends Error {}

/** Une conversation neuve d\u00e9marre vide : aucun message d'accueil automatique. */
function initialConvos(): Record<ChatMode, ChatMsg[]> {
  const modes: ChatMode[] = ["council", ...AGENT_ORDER];
  return Object.fromEntries(
    modes.map((m) => [m, [] as ChatMsg[]])
  ) as Record<ChatMode, ChatMsg[]>;
}

export type AgentChat = {
  mode: ChatMode;
  setMode: (m: ChatMode) => void;
  startCouncil: () => void;
  messages: ChatMsg[];
  input: string;
  loading: boolean;
  setInput: Dispatch<SetStateAction<string>>;
  send: (text?: string) => Promise<void>;
  commitPlan: (index: number) => Promise<void>;
  activeSession: Session | null;
  sessions: Session[];
  loadSession: (session: Session) => Promise<void>;
  newConversation: () => void;
  deleteSession: (id: string) => Promise<void>;
};

export function useAgentChat(onChanged: () => void): AgentChat {
  const [convos, setConvos] = useState<Record<ChatMode, ChatMsg[]>>(initialConvos);
  const [mode, setMode] = useState<ChatMode>("josiane");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionIds, setSessionIds] = useState<Partial<Record<ChatMode, string>>>({});
  const [activeSessions, setActiveSessions] = useState<Partial<Record<ChatMode, Session>>>({});
  const [sessionsList, setSessionsList] = useState<Partial<Record<ChatMode, Session[]>>>({});

  const currentSessionId = sessionIds[mode];
  const activeSession = activeSessions[mode] ?? null;
  const sessions = sessionsList[mode] ?? [];

  // Charge la liste des sessions archivées au montage (Conseil exclu).
  // On arrive toujours sur une conversation vierge : une ancienne conversation
  // ne se recharge que si on l'ouvre explicitement via le drawer (loadSession).
  useEffect(() => {
    AGENT_ORDER.forEach(async (m) => {
      try {
        const res = await fetch(`/api/agent/sessions?mode=${m}`);
        if (res.ok) {
          const list: Session[] = await res.json();
          setSessionsList((prev) => ({ ...prev, [m]: list }));
        }
      } catch {
        // non critique
      }
    });
  }, []);

  const startCouncil = useCallback(() => {
    setConvos((prev) => ({ ...prev, council: [] }));
    setSessionIds((prev) => ({ ...prev, council: undefined }));
    setActiveSessions((prev) => ({ ...prev, council: undefined }));
    setMode("council");
  }, []);

  /** Charge une session archiv\u00e9e dans le panneau. */
  const loadSession = useCallback(async (session: Session) => {
    const m = session.mode as ChatMode;
    try {
      const res = await fetch(`/api/agent/sessions/${session.id}?mode=${m}`);
      if (!res.ok) return;
      const entries: ChatHistoryEntry[] = await res.json();
      const msgs: ChatMsg[] = entries
        .filter((e) => e.role !== "summary")
        .map((e) => ({
          role: e.role as "user" | "assistant",
          content: e.content,
          actions: e.actions,
        }));
      setConvos((prev) => ({ ...prev, [m]: msgs }));
      setSessionIds((prev) => ({ ...prev, [m]: session.id }));
      setActiveSessions((prev) => ({ ...prev, [m]: session }));
      setMode(m);
    } catch {
      // non critique
    }
  }, []);

  /** D\u00e9marre une nouvelle conversation vierge pour le mode courant. */
  const newConversation = useCallback(() => {
    setConvos((prev) => ({ ...prev, [mode]: [] }));
    setSessionIds((prev) => ({ ...prev, [mode]: undefined }));
    setActiveSessions((prev) => ({ ...prev, [mode]: undefined }));
  }, [mode]);

  /** Supprime une session archiv\u00e9e. */
  const deleteSession = useCallback(async (id: string) => {
    try {
      await fetch(`/api/agent/sessions/${id}`, { method: "DELETE" });
      setSessionsList((prev) => ({
        ...prev,
        [mode]: (prev[mode] ?? []).filter((s) => s.id !== id),
      }));
      // Si c'\u00e9tait la session active, revenir \u00e0 la conversation courante.
      if (currentSessionId === id) {
        setConvos((prev) => ({ ...prev, [mode]: [] }));
        setSessionIds((prev) => ({ ...prev, [mode]: undefined }));
        setActiveSessions((prev) => ({ ...prev, [mode]: undefined }));
      }
    } catch {
      // non critique
    }
  }, [mode, currentSessionId]);

  const send = useCallback(
    async (text?: string) => {
      const content = (text ?? input).trim();
      if (!content || loading) return;
      setInput("");

      const activeMode = mode;
      const sessionId = sessionIds[activeMode];
      const isFirstUserMsg = convos[activeMode].filter((m) => m.role === "user").length === 0;

      const history = [
        ...convos[activeMode],
        { role: "user" as const, content },
      ];
      setConvos((prev) => ({ ...prev, [activeMode]: history }));
      setLoading(true);

      try {
        // Si c'est le 1er message et pas de session active, cr\u00e9er la session
        // AVANT d'appeler l'agent : son id part avec la requ\u00eate, donc tout
        // l'historique serveur est rang\u00e9 sous la session (aucune cl\u00e9 globale).
        // Jamais pour le Conseil : ses s\u00e9ances sont \u00e9ph\u00e9m\u00e8res.
        let resolvedSessionId = sessionId;
        if (isFirstUserMsg && !sessionId && activeMode !== "council") {
          try {
            const r = await fetch("/api/agent/sessions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ mode: activeMode, firstUserMessage: content }),
            });
            if (r.ok) {
              const session: Session = await r.json();
              resolvedSessionId = session.id;
              setSessionIds((prev) => ({ ...prev, [activeMode]: session.id }));
              setActiveSessions((prev) => ({ ...prev, [activeMode]: session }));
              setSessionsList((prev) => ({
                ...prev,
                [activeMode]: [session, ...(prev[activeMode] ?? [])],
              }));
              // Le titre soigné est un appel LLM : on le lance SANS l'attendre,
              // il se génère pendant que l'agent travaille et remplace le titre
              // provisoire quand il arrive. L'attendre ici coûtait ~3 s de
              // silence avant même que la question ne parte.
              void fetch(`/api/agent/sessions/${session.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mode: activeMode, firstUserMessage: content }),
              })
                .then((res) => (res.ok ? res.json() : null))
                .then((data: { title?: string } | null) => {
                  if (!data?.title) return;
                  const renamed = { ...session, title: data.title };
                  setActiveSessions((prev) =>
                    prev[activeMode]?.id === session.id
                      ? { ...prev, [activeMode]: renamed }
                      : prev
                  );
                  setSessionsList((prev) => ({
                    ...prev,
                    [activeMode]: (prev[activeMode] ?? []).map((x) =>
                      x.id === session.id ? renamed : x
                    ),
                  }));
                })
                .catch(() => {
                  // Titre provisoire conservé — sans conséquence.
                });
            }
          } catch {
            // non critique \u2014 la conversation continue sans archivage
          }
        }

        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: history.map((m) => ({ role: m.role, content: m.content })),
            mode: activeMode,
            now: toLocalIso(new Date()),
            sessionId: resolvedSessionId,
          }),
        });
        // Sans ce test, un 502/504 (page HTML du proxy) fait échouer res.json()
        // et l'erreur se déguise en « impossible de contacter l'agent ».
        if (!res.ok) {
          throw new AgentFetchError(
            res.status === 502 || res.status === 504
              ? "⏱️ Le proxy a coupé avant la fin, mais le traitement continue côté serveur — recharge la page dans une minute, le résultat y sera."
              : `❌ L'agent a répondu une erreur ${res.status}.`
          );
        }
        const data = await res.json();
        setConvos((prev) => ({
          ...prev,
          [activeMode]: [
            ...prev[activeMode],
            {
              role: "assistant",
              content: data.reply || "\u2026",
              actions: data.actions,
              plan: data.plan,
              planCommitted: data.plan?.committed,
            },
          ],
        }));
        if (data.changed) onChanged();
      } catch (err) {
        const content =
          err instanceof AgentFetchError
            ? err.message
            : "\u274c Impossible de contacter l'agent.";
        setConvos((prev) => ({
          ...prev,
          [activeMode]: [...prev[activeMode], { role: "assistant", content }],
        }));
      } finally {
        setLoading(false);
      }
    },
    [input, loading, mode, convos, sessionIds, onChanged]
  );

  const commitPlan = useCallback(
    async (index: number) => {
      const activeMode = mode;
      const msg = convos[activeMode][index];
      if (!msg?.plan || msg.planCommitted || loading) return;
      setLoading(true);
      try {
        const res = await fetch("/api/plan/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan: msg.plan }),
        });
        const data = await res.json();
        setConvos((prev) => ({
          ...prev,
          [activeMode]: [
            ...prev[activeMode].map((m, i) =>
              i === index ? { ...m, planCommitted: true } : m
            ),
            {
              role: "assistant",
              content: `C'est valid\u00e9 \u2014 ${
                data.created ?? msg.plan!.sessions.length
              } s\u00e9ance(s) ajout\u00e9e(s) \u00e0 ton agenda.`,
            },
          ],
        }));
        onChanged();
      } catch {
        setConvos((prev) => ({
          ...prev,
          [activeMode]: [
            ...prev[activeMode],
            { role: "assistant", content: "\u274c Impossible d'\u00e9crire le plan." },
          ],
        }));
      } finally {
        setLoading(false);
      }
    },
    [mode, convos, loading, onChanged]
  );

  return {
    mode,
    setMode,
    startCouncil,
    messages: convos[mode],
    input,
    loading,
    setInput,
    send,
    commitPlan,
    activeSession,
    sessions,
    loadSession,
    newConversation,
    deleteSession,
  };
}
