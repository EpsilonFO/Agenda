/**
 * Trace de debug d'une séance du Conseil : tout ce que les agents reçoivent
 * et répondent, round par round, est collecté puis écrit dans
 * data/traces/council-<timestamp>.json — pour comprendre POURQUOI un plan
 * est sorti comme il est sorti.
 *
 * DÉSACTIVÉE par défaut (09/2026) : en usage courant, ces fichiers
 * s'accumulaient pour rien. `PLANNER_TRACE=1` dans `.env.local` les
 * réactive le temps d'un diagnostic — la collecte en mémoire, elle, ne coûte
 * rien et reste branchée.
 */

import { promises as fs } from "fs";
import path from "path";

export type TraceEvent = {
  ts: string;
  agent: string;
  kind:
    | "system" // le system prompt (une fois par agent)
    | "request" // contenu utilisateur envoyé
    | "response" // réponse brute du modèle
    | "invalid" // sortie refusée par le schéma (avec les erreurs)
    | "violations" // violations guardrails après un round
    | "repair" // action de réparation mécanique
    | "info";
  content: string;
};

export type Trace = {
  onEvent: (agent: string, kind: TraceEvent["kind"], content: string) => void;
  /** Écrit le fichier et renvoie son chemin — ou "" si la trace est désactivée. */
  save: () => Promise<string>;
};

/** `PLANNER_TRACE=1` (ou true/yes/on) active l'écriture sur disque. */
export function traceEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.PLANNER_TRACE?.trim() ?? "");
}

const TRACES_DIR = path.join(process.cwd(), "data", "traces");
/** On garde les N traces les plus récentes. */
const KEEP = 20;

export function createTrace(label: string): Trace {
  const startedAt = new Date();
  const events: TraceEvent[] = [];

  return {
    onEvent(agent, kind, content) {
      events.push({ ts: new Date().toISOString(), agent, kind, content });
    },
    async save() {
      if (!traceEnabled()) return "";
      await fs.mkdir(TRACES_DIR, { recursive: true });
      const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const file = path.join(TRACES_DIR, `council-${label}-${stamp}.json`);
      await fs.writeFile(
        file,
        JSON.stringify({ label, startedAt: startedAt.toISOString(), events }, null, 2),
        "utf8"
      );
      // Ménage : on ne garde que les plus récentes.
      const all = (await fs.readdir(TRACES_DIR))
        .filter((f) => f.startsWith("council-"))
        .sort();
      for (const old of all.slice(0, Math.max(0, all.length - KEEP))) {
        await fs.unlink(path.join(TRACES_DIR, old)).catch(() => {});
      }
      return file;
    },
  };
}
