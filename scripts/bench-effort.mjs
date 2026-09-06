#!/usr/bin/env node
/**
 * Mesure ce que coûte VRAIMENT un niveau d'effort sur un modèle : ce qui part
 * dans le corps de la requête, la latence, les jetons de raisonnement.
 *
 *   node --env-file=.env.local scripts/bench-effort.mjs ds-flash none low high
 *   node --env-file=.env.local scripts/bench-effort.mjs or-glm low medium --n 5
 *
 * Prompt réaliste (système long + outils), N appels par effort (défaut 3),
 * appels RÉELS — quelques dixièmes de centime. Sans réseau : `--dry` n'affiche
 * que le corps qui partirait.
 */

import { adapterFor, complete, prepare } from "providall";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const nIdx = args.indexOf("--n");
const n = nIdx >= 0 ? Number(args[nIdx + 1]) : 3;
const positional = args.filter((a, i) => !a.startsWith("--") && (nIdx < 0 || i !== nIdx + 1));
const [model, ...efforts] = positional;
if (!model || efforts.length === 0) {
  console.error("usage : bench-effort.mjs <modèle> <effort…> [--n 3] [--dry]");
  process.exit(1);
}

const tools = [
  "list_events", "resolve_dates", "create_event", "update_event",
  "delete_event", "list_plan_sessions", "edit_plan_sessions", "replan_week",
].map((name) => ({
  name,
  description: `Outil ${name} de l'agenda (description réaliste d'une centaine de mots pour charger le contexte comme en production, avec ses règles d'usage, ses cas limites et ses contre-indications habituelles).`,
  parameters: {
    type: "object",
    properties: {
      weekStart: { type: "string" },
      id: { type: "string" },
      operations: { type: "array", items: { type: "object" } },
    },
  },
}));

const system =
  "Tu es Josiane, la cheffe d'orchestre de l'agenda. " +
  "Règle de conduite détaillée. ".repeat(120) +
  "\nAgenda des 15 prochains jours :\n" +
  Array.from({ length: 12 }, (_, i) => {
    const d = `2026-09-${String(7 + i).padStart(2, "0")}`;
    return `- ${d} 09:00-12:00 Cours [id: c${i}] · 13:15-17:15 Delos (plan) [id: sol-${i}] · 17:30-21:30 Monumia (plan) [id: mon-${i}]`;
  }).join("\n");

const messages = [
  { role: "system", content: system },
  { role: "user", content: "déplace ma natation de lundi à mardi midi" },
];

const pad = (v, w) => String(v).padStart(w);

for (const effort of efforts) {
  const req = prepare(messages, { model, effort, tools });
  const body = adapterFor(req.spec.protocol).build(req).body;
  const sent = Object.fromEntries(
    Object.entries(body).filter(([k]) => /effort|thinking|reasoning|max_tokens|max_completion_tokens/.test(k))
  );
  console.log(`\n== ${req.spec.provider}:${req.spec.modelId} · effort ${effort} → ${JSON.stringify(sent)}`);
  if (dry) continue;

  const rows = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    try {
      const r = await complete(messages, { model, effort, tools, label: effort });
      rows.push({ ms: Date.now() - t0, reasoning: r.usage.reasoningTokens, out: r.usage.outputTokens, cost: r.costUsd ?? 0 });
      console.log(
        `  ${pad(rows.at(-1).ms, 6)} ms  reasoning=${pad(r.usage.reasoningTokens, 5)}  out=${pad(r.usage.outputTokens, 4)}` +
          `  finish=${r.finishReason}  outils=${r.toolCalls.map((c) => c.function.name).join(",") || "—"}`
      );
    } catch (err) {
      console.log(`  ÉCHEC ${err.constructor.name} : ${err.message.split("\n")[0]}`);
    }
  }
  if (rows.length) {
    const avg = (k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;
    console.log(
      `  moyenne : ${Math.round(avg("ms"))} ms · reasoning ${Math.round(avg("reasoning"))} · out ${Math.round(avg("out"))} · $${avg("cost").toFixed(5)}/appel`
    );
  }
}
