/**
 * Résumé automatique de l'historique de conversation.
 *
 * Quand le nombre de messages d'un mode dépasse SUMMARY_THRESHOLD, on demande
 * au modèle de produire un résumé compact des échanges passés. Ce résumé est
 * stocké comme un message de role "summary" en tête de l'historique persisté,
 * et injecté dans le contexte système de l'agent à chaque appel.
 *
 * Objectif : garder un contexte utile sans envoyer 100 messages à l'API.
 */

import { chatEffort, llmChat, textOf } from "./llm";
import {
  getChatHistory,
  setChatHistory,
  CHAT_HISTORY_MAX,
} from "./store";
import type { ChatHistoryEntry } from "./types";

/** Déclenche un résumé quand on dépasse ce seuil de messages réguliers. */
const SUMMARY_THRESHOLD = 40;

/**
 * Construit le bloc de contexte "mémoire de conversation" à injecter dans le
 * system prompt de l'agent. Retourne une chaîne vide si l'historique est vide.
 */
export async function buildConversationContext(mode: string, sessionId?: string): Promise<string> {
  const history = await getChatHistory(mode, sessionId);
  if (history.length === 0) return "";

  const summary = history.find((e) => e.role === "summary");
  const regular = history.filter((e) => e.role !== "summary");

  const parts: string[] = [];

  if (summary) {
    parts.push(`RÉSUMÉ DES ÉCHANGES PRÉCÉDENTS :\n${summary.content}`);
  }

  if (regular.length > 0) {
    const lines = regular
      .slice(-20) // les 20 derniers messages seulement dans le contexte
      .map((e) => `${e.role === "user" ? "Utilisateur" : "Assistant"}: ${e.content}`)
      .join("\n");
    parts.push(`DERNIERS ÉCHANGES :\n${lines}`);
  }

  if (parts.length === 0) return "";
  return `\n\n--- MÉMOIRE DE CONVERSATION ---\n${parts.join("\n\n")}\n--- FIN MÉMOIRE ---`;
}

/**
 * Vérifie si l'historique du mode dépasse le seuil et, si oui, génère un
 * résumé via le modèle puis compacte l'historique (résumé + 20 derniers msgs).
 */
export async function maybeSummarize(mode: string, sessionId?: string): Promise<void> {
  const history = await getChatHistory(mode, sessionId);
  const regular = history.filter((e) => e.role !== "summary");

  if (regular.length < SUMMARY_THRESHOLD) return;

  // Les messages à résumer = tout sauf les 20 derniers (qu'on garde intacts).
  const toSummarize = regular.slice(0, -20);
  if (toSummarize.length === 0) return;

  const transcript = toSummarize
    .map((e) => `${e.role === "user" ? "Utilisateur" : "Assistant"}: ${e.content}`)
    .join("\n");

  try {
    const msg = await llmChat({
      role: "small",
      messages: [
        {
          role: "system",
          content:
            "Tu es un assistant qui résume des conversations. Produis un résumé factuel et concis (10 lignes max) des échanges suivants, en retenant les décisions prises, préférences exprimées et actions effectuées sur l'agenda. Écris en français, au présent.",
        },
        {
          role: "user",
          content: `Résume cette conversation :\n\n${transcript}`,
        },
      ],
      label: "résumé",
      // Résumer dix lignes ne mérite pas de réflexion : même effort que le chat.
      effort: chatEffort(),
    });

    const summaryText = textOf(msg).trim();
    if (!summaryText) return;

    const summaryEntry: ChatHistoryEntry = {
      role: "summary",
      content: summaryText,
      createdAt: new Date().toISOString(),
    };

    // Nouveau store : résumé + 20 derniers messages réguliers
    const kept = regular.slice(-20);
    await setChatHistory(mode, [summaryEntry, ...kept], sessionId);
  } catch (err) {
    // Résumé non critique — on continue sans planter
    console.warn("[summary] échec résumé automatique :", err);
  }
}

/**
 * Titre PROVISOIRE, immédiat : le début du premier message.
 *
 * Il existe pour que la création d'une session ne coûte pas un aller-retour LLM
 * devant la réponse de l'agent — 3 secondes de silence pour un libellé de liste.
 * Le titre soigné le remplace quand il arrive (voir generateSessionTitle).
 */
export function provisionalTitle(firstMessage: string): string {
  const clean = firstMessage.replace(/\s+/g, " ").trim();
  if (!clean) return "Nouvelle conversation";
  if (clean.length <= 40) return clean;
  const cut = clean.slice(0, 40);
  const space = cut.lastIndexOf(" ");
  return `${space > 20 ? cut.slice(0, space) : cut}…`;
}

/**
 * Génère un titre court pour une session à partir du premier message utilisateur.
 * Fallback sur "Nouvelle conversation" en cas d'erreur.
 */
export async function generateSessionTitle(
  firstMessage: string,
  mode: string
): Promise<string> {
  if (!firstMessage.trim()) return "Nouvelle conversation";

  const modeLabel: Record<string, string> = {
    josiane: "Josiane (agenda)",
    emilien: "Emilien (travail)",
    jannik: "Jannik (coach sportif)",
    djimo: "Djimo (loisir)",
    simone: "Simone (cuisine)",
  };

  try {
    const msg = await llmChat({
      role: "small",
      messages: [
        {
          role: "system",
          content:
            "Tu génères des titres de conversation très courts (5 mots max, sans ponctuation finale). Réponds UNIQUEMENT avec le titre, rien d'autre.",
        },
        {
          role: "user",
          content: `Contexte : conversation avec ${modeLabel[mode] || mode}.
Premier message : "${firstMessage}"
Génère un titre court.`,
        },
      ],
      label: "titre-session",
      effort: chatEffort(),
    });

    const title = textOf(msg).trim().replace(/^["']|["']$/g, "").slice(0, 60);
    return title || "Nouvelle conversation";
  } catch {
    return "Nouvelle conversation";
  }
}
