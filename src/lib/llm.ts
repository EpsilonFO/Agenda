/**
 * Couche LLM de l'application : une fine traduction vers **providall**.
 *
 * providall porte tout ce qui était écrit ici avant (table de fournisseurs,
 * clés, protocoles Anthropic / chat-completions, retries, coût, erreurs
 * typées). Ce fichier ne garde que ce qui est propre à l'agenda :
 *
 *   - la forme des outils du reste du code (`{ type: "function", function }`,
 *     dialecte OpenAI) → la forme plate de providall ;
 *   - les rôles (`planner`, `coach`…) → `LLM_MODEL_<RÔLE>` ;
 *   - trois niveaux d'effort de raisonnement, parce qu'arbitrer une semaine et
 *     écrire deux phrases dans la boucle de chat ne méritent pas le même prix.
 *
 * Changer de modèle = changer `LLM_MODEL` dans `.env.local` (alias du registre
 * — `sonnet`, `gpt-terra`, `ds-flash` — ou `fournisseur:identifiant`), plus
 * une ligne de code.
 */

import { complete, logLine, normalizeEffort } from "providall";
import type { Effort, Env, FetchLike, Message, ToolDef } from "providall";

export { parseJsonLoose } from "providall";
export {
  APIError,
  CapabilityError,
  ConfigError,
  MissingKeyError,
  ProvidallError,
  describeConfig,
} from "providall";
export type { Message as LlmMessage, ToolCall as LlmToolCall } from "providall";

/** Rôles ayant leur propre modèle : `LLM_MODEL_PLANNER`, `LLM_MODEL_COACH`… */
export type ModelRole =
  /** Josiane (agenda) : raisonnement spatio-temporel & arbitrage. */
  | "planner"
  /** Jannik (coach sportif). */
  | "coach"
  /** Emilien (travail). */
  | "work"
  /** Djimo (loisir). */
  | "leisure"
  /** Simone (cheffe cuisinière). */
  | "chef"
  /** Tout le reste : boucle de chat, résumés, titres de session. */
  | "small";

/**
 * Outil au dialecte OpenAI, celui que le reste du code écrit déjà.
 * providall attend la forme plate ; la traduction tient en trois lignes.
 */
export type LlmToolDef = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatRequest = {
  /** Rôle → `LLM_MODEL_<RÔLE>`, à défaut `LLM_MODEL`. */
  role?: ModelRole;
  /** Modèle explicite (alias du registre ou `fournisseur:identifiant`) — prioritaire. */
  model?: string;
  messages: Message[];
  tools?: LlmToolDef[];
  toolChoice?: "auto" | "none" | "required";
  /** Force une réponse JSON. */
  json?: boolean;
  /** Étiquette pour les logs (nom de l'agent). */
  label?: string;
  /** Effort de raisonnement — défaut : celui de la délibération. */
  effort?: string;
  /** Injections de test (providall les accepte partout) : faux fetch, faux env. */
  fetch?: FetchLike;
  env?: Env;
};

function flatten(t: LlmToolDef): ToolDef {
  return {
    name: t.function.name,
    description: t.function.description ?? "",
    parameters: t.function.parameters,
  };
}

/**
 * Un aller-retour avec le modèle actif.
 *
 * Renvoie le message au format pivot de providall (chat-completions). Il peut
 * porter un `_raw` — la réponse native du fournisseur, à rejouer telle quelle
 * en le repoussant dans l'historique (blocs `thinking` signés d'Anthropic, que
 * l'API refuse de voir détachés de l'appel d'outil qu'ils ont produit). Le
 * reste du code n'a rien à en faire : il suffit de le remettre tel quel.
 *
 * Les erreurs remontent en `ProvidallError` typée (`ConfigError`,
 * `MissingKeyError`, `APIError`, `TimeoutError`…), déjà retentées quand elles
 * sont transitoires.
 */
export async function llmChat(opts: ChatRequest): Promise<Message> {
  const label = opts.label ?? opts.role ?? "llm";
  // Une ligne AVANT l'appel, pas seulement après : sans elle, un appel parti
  // chez un fournisseur lent ne se voit nulle part — la console reste muette
  // pendant des minutes et on ne sait pas si le serveur travaille ou a planté.
  console.log(`[llm] → ${label}`);
  const response = await complete(opts.messages, {
    role: opts.role,
    model: opts.model,
    tools: opts.tools?.map(flatten),
    toolChoice: opts.toolChoice,
    json: opts.json ? true : undefined,
    label,
    effort: normalizeEffort(opts.effort) ?? deliberationEffort(opts.env),
    fetch: opts.fetch,
    env: opts.env,
    onResponse: (r) => console.log(`[llm] ${logLine(r, label)}`),
  });
  return response.message;
}

/**
 * Texte d'un message. Le contenu peut être une liste de parties (multimodal) :
 * le reste du code ne veut que les mots.
 */
export function textOf(message: Message | null | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  }
  return "";
}

/* ------------------------------ Efforts ------------------------------- */

function effortFrom(name: string, fallback: Effort, env?: Env): Effort {
  const raw = (env ?? process.env)[name];
  const value = normalizeEffort(raw);
  if (raw?.trim() && !value) {
    console.warn(`[llm] ${name}="${raw}" invalide — ignoré.`);
  }
  return value ?? fallback;
}

/**
 * Effort des appels de DÉLIBÉRATION (Conseil, planner) : ce sont eux qui
 * arbitrent sous contraintes, ils méritent de réfléchir.
 */
export function deliberationEffort(env?: Env): Effort {
  return effortFrom("LLM_EFFORT", "xhigh", env);
}

/**
 * Effort de la BOUCLE DE CHAT (routage d'outils + rédaction de la réponse).
 * Volontairement bien plus bas : ces tours-là choisissent un outil et écrivent
 * deux phrases en français. À xhigh ils coûtaient chacun des dizaines de
 * milliers de jetons de raisonnement, et la boucle en enchaîne 3 à 5 — c'est ce
 * qui faisait des réponses à plusieurs minutes sur une demande simple.
 */
export function chatEffort(env?: Env): Effort {
  return effortFrom("LLM_EFFORT_CHAT", "medium", env);
}

/**
 * Effort de la RETOUCHE ciblée d'un plan (`replan_week`). Entre les deux :
 * déplacer une session en vérifiant qu'elle ne casse rien est un problème bien
 * plus petit qu'arbitrer une semaine entière depuis zéro — xhigh y partait en
 * boucle plutôt qu'en convergence.
 */
export function retouchEffort(env?: Env): Effort {
  return effortFrom("LLM_EFFORT_RETOUCH", "high", env);
}
