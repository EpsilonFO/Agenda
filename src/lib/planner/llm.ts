/**
 * Appel LLM sous contrat : la réponse DOIT valider un schéma zod.
 *
 * En cas de JSON invalide ou non conforme, on renvoie les erreurs au modèle
 * et on retente (maxRetries fois). Au-delà, on lève — l'orchestrateur décide
 * quoi faire. Jamais de parse silencieux qui devient un plan vide.
 */

import type { ZodType } from "zod";
import { llmChat, parseJsonLoose } from "../llm";
import type { LlmMessage, ModelRole } from "../llm";

/** Signature minimale d'un appel chat (injectable dans les tests). */
export type ChatFn = (opts: {
  /** Rôle → LLM_MODEL_<RÔLE>. Ignoré si `model` est fourni. */
  role?: ModelRole;
  /** Modèle explicite (alias du registre ou `fournisseur:identifiant`). */
  model?: string;
  messages: LlmMessage[];
  json?: boolean;
  /** Étiquette pour les logs (nom de l'agent). */
  label?: string;
  /** Effort de raisonnement — défaut : celui de la délibération. */
  effort?: string;
}) => Promise<Record<string, any>>;

export class AgentOutputError extends Error {
  constructor(
    public agent: string,
    public attempts: number,
    public lastIssues: string
  ) {
    super(
      `Sortie invalide de ${agent} après ${attempts} tentative(s) :\n${lastIssues}`
    );
  }
}

export type CallJsonOptions = {
  /** Nom de l'agent (pour les erreurs/logs). */
  agent: string;
  /** Rôle → LLM_MODEL_<RÔLE>. Ignoré si `model` est fourni. */
  role?: ModelRole;
  /** Modèle explicite, prioritaire sur le rôle. */
  model?: string;
  system: string;
  user: string;
  /** Nombre de RETRIES après le premier essai (défaut 2). */
  maxRetries?: number;
  /** Effort de raisonnement — défaut : celui de la délibération. */
  effort?: string;
  /** Implémentation de chat (défaut : llmChat, le provider actif). */
  chat?: ChatFn;
  /** Trace de debug (voir trace.ts). */
  onEvent?: (agent: string, kind: "system" | "request" | "response" | "invalid", content: string) => void;
};

/**
 * Appelle le modèle et renvoie un objet validé par `schema`.
 * Retry avec feedback d'erreurs en cas de sortie non conforme.
 */
export async function callJson<T>(
  schema: ZodType<T>,
  opts: CallJsonOptions
): Promise<T> {
  const chat = opts.chat ?? (llmChat as ChatFn);
  const maxRetries = opts.maxRetries ?? 2;

  const messages: LlmMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  opts.onEvent?.(opts.agent, "system", opts.system);
  opts.onEvent?.(opts.agent, "request", opts.user);

  let lastIssues = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const message = await chat({
      role: opts.role,
      model: opts.model,
      messages,
      json: true,
      label: opts.agent,
      effort: opts.effort,
    });
    const raw = String(message.content || "");
    opts.onEvent?.(opts.agent, "response", raw);

    const parsed = parseJsonLoose<unknown>(raw);
    if (parsed !== null) {
      const result = schema.safeParse(parsed);
      if (result.success) return result.data;
      lastIssues = result.error.issues
        .map((i) => {
          // Rendre l'erreur actionnable pour le modèle : « Invalid input »
          // seul ne permet pas de se corriger.
          const extra = i as { values?: unknown[]; expected?: unknown };
          let msg = i.message;
          if (Array.isArray(extra.values) && extra.values.length) {
            msg += ` — valeurs permises : ${extra.values.map((v) => JSON.stringify(v)).join(", ")}`;
          } else if (extra.expected !== undefined) {
            msg += ` — attendu : ${String(extra.expected)}`;
          }
          return `- ${i.path.join(".") || "(racine)"} : ${msg}`;
        })
        .join("\n");
    } else {
      lastIssues = "- la réponse n'est pas du JSON parsable";
    }

    console.warn(
      `[planner] sortie invalide de ${opts.agent} (tentative ${attempt + 1}/${maxRetries + 1}) :\n${lastIssues.slice(0, 500)}`
    );
    opts.onEvent?.(opts.agent, "invalid", lastIssues);
    // Feedback d'erreur pour la tentative suivante.
    messages.push({ role: "assistant", content: raw });
    messages.push({
      role: "user",
      content: `Ta réponse ne respecte pas le format attendu :\n${lastIssues}\nRenvoie UNIQUEMENT l'objet JSON corrigé, sans texte autour.`,
    });
  }

  throw new AgentOutputError(opts.agent, maxRetries + 1, lastIssues);
}
