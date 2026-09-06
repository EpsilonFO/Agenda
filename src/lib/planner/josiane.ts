/**
 * Le PLACEMENT (v5) — entrée unique du planificateur, plus aucun LLM ici.
 *
 *   WeekInput ──► applyOverrides (copie de config) + indisponibilités en
 *   blocs fixes ──► solveWeekBest (K candidats déterministes, fonction
 *   objectif, le meilleur gagne) ──► PlacementResult
 *
 * Le nom du fichier honore Josiane, qui plaçait les créneaux dans les v2-v4 :
 * il ne reste d'elle que la RETOUCHE (retouchWeek), le seul endroit où un LLM
 * intervient encore — et il ne fait que remplir des opérations JSON validées
 * (RetouchOp[]) appliquées puis re-vérifiées par les guardrails.
 *
 * Les overrides de la demande (ex: « Marine absente » → sortiesMarineMin: 0)
 * sont appliqués à une COPIE de la config avant tout : solveur, objectif et
 * guardrails jugent avec les mêmes règles ajustées. Les indisponibilités
 * deviennent des blocs fixes : y poser quoi que ce soit = chevauchement.
 */

import { retouchEffort } from "../llm";
import { addDays, toLocalIso } from "../dates";
import type { LifeConfig } from "./config";
import type { JosianeRetouchOut, ReplanPatch, RetouchOp, WeekInput } from "./contracts";
import { JosianeRetouchOutSchema, ReplanPatchSchema, applyReplanPatch } from "./contracts";
import { checkWeekPlan } from "./guardrails";
import { callJson, type ChatFn } from "./llm";
import { solveWeekBest, type OptimizeResult } from "./optimize";
import { buildJosianeRetouchSystem, buildReplanPatchSystem } from "./prompts";
import { buildTravelEvents } from "./solver";
import type { FixedItem, PlanSession, Violation } from "./types";

const WEEKDAYS = [
  "dimanche",
  "lundi",
  "mardi",
  "mercredi",
  "jeudi",
  "vendredi",
  "samedi",
] as const;

/* ----------------------------- Utilitaires --------------------------- */

/** Les 7 dates (YYYY-MM-DD) de la semaine commençant à weekStart (lundi). */
export function weekDates(weekStart: string): string[] {
  const monday = new Date(`${weekStart}T12:00:00`);
  return Array.from({ length: 7 }, (_, i) =>
    toLocalIso(addDays(monday, i)).slice(0, 10)
  );
}

function labelOf(day: string): string {
  return `${WEEKDAYS[new Date(`${day}T12:00:00`).getDay()]} ${day}`;
}

/** Copie de la config avec les overrides hebdo appliqués. */
export function applyOverrides(cfg: LifeConfig, input: WeekInput): LifeConfig {
  const o = input.overrides;
  const next: LifeConfig = JSON.parse(JSON.stringify(cfg));
  if (o.sortiesMarineMin !== undefined) next.sorties.copine.perWeekMin = o.sortiesMarineMin;
  if (o.sportSessionsMax !== undefined) {
    next.sport.sessionsPerWeekMax = o.sportSessionsMax;
    next.sport.sessionsPerWeekMin = Math.min(next.sport.sessionsPerWeekMin, o.sportSessionsMax);
  }
  if (o.monumiaMinHours !== undefined) next.work.monumia.minHoursPerWeek = o.monumiaMinHours;
  // « Semaine légère » : plafonne les cibles explorées par l'optimiseur — jamais
  // au-dessus du plafond de la config, jamais sous son plancher.
  if (o.monumiaMaxHours !== undefined)
    next.work.monumia.maxHoursPerWeek = Math.max(
      next.work.monumia.minHoursPerWeek,
      Math.min(o.monumiaMaxHours, next.work.monumia.maxHoursPerWeek)
    );
  // Le VOLUME Delos est une RÈGLE (jamais surchargé) ; son PLACEMENT et sa
  // MODALITÉ, si. « Cette semaine j'ai cours tous les jours, je fais tout à
  // distance » ne réduit rien : les demi-journées qui quittent le présentiel
  // rebasculent en heures à distance, heure pour heure. Le total hebdo est
  // recalculé AVANT modification pour rester l'invariant du calcul.
  if (o.delosGroupHalfDays !== undefined) next.work.delos.groupHalfDays = o.delosGroupHalfDays;
  if (o.delosWeekendOk !== undefined) next.work.delos.weekendOk = o.delosWeekendOk;
  if (o.delosPresentielHalfDays !== undefined) {
    const d = next.work.delos;
    const halfDayHours = halfDayLengthHours(d.halfDayWindows);
    const totalHours = d.presentielHalfDaysPerWeek * halfDayHours + (d.remote?.hoursPerWeek ?? 0);
    const wanted = Math.min(o.delosPresentielHalfDays, Math.floor(totalHours / halfDayHours));
    d.presentielHalfDaysPerWeek = wanted;
    const remoteHours = Math.max(0, totalHours - wanted * halfDayHours);
    if (d.remote) d.remote.hoursPerWeek = remoteHours;
    else if (remoteHours > 0)
      // Une config sans volet distant n'en avait pas besoin ; dès qu'on retire
      // du présentiel, il en faut un — sinon les heures disparaissent.
      d.remote = { hoursPerWeek: remoteHours, placeId: cfg.work.monumia.preferredPlaceIds[0], blockHours: [4, 2] };
  }
  if (!input.voitureDispo) next.ownedModes = next.ownedModes.filter((m) => m !== "voiture");
  return next;
}

/** Durée (en heures) d'un gabarit de demi-journée — la moyenne des gabarits
 *  déclarés, qui font tous la même taille en pratique (9h-13h / 14h-18h). */
function halfDayLengthHours(windows: { start: string; end: string }[]): number {
  const min = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const total = windows.reduce((a, w) => a + (min(w.end) - min(w.start)), 0);
  return total / windows.length / 60;
}

/** Les indisponibilités deviennent des blocs FIXES (rien ne peut s'y poser). */
export function indispoAsFixed(cfg: LifeConfig, input: WeekInput): FixedItem[] {
  return input.indisponibilites.map((ind, i) => ({
    id: `indispo-${i}`,
    title: `Indisponible${ind.reason ? ` (${ind.reason})` : ""}`,
    start: `${ind.day}T${ind.from ?? cfg.schedule.dayStart}:00`,
    end: `${ind.day}T${ind.to ?? cfg.schedule.exceptionalEnd}:00`,
    indispo: true,
  }));
}

/* ------------------------------ Placement ---------------------------- */

export type PlacementResult = {
  sessions: PlanSession[];
  /** Violations restantes (erreurs non résolues et warns) — l'utilisateur tranche. */
  violations: Violation[];
  /** Warnings pour l'utilisateur (notes du solveur + warns des guardrails). */
  warnings: string[];
  /** Nombre d'appels LLM effectués (0 en v5 : le placement est pur code). */
  attempts: number;
};

export type PlacementOptions = {
  /** Client de chat injectable (retouche uniquement — le placement est pur). */
  chat?: ChatFn;
  model?: string;
  /** Trace de debug (voir trace.ts). */
  onEvent?: (agent: string, kind: "system" | "request" | "response" | "invalid" | "violations" | "repair" | "info", content: string) => void;
};

export type PlaceArgs = {
  input: WeekInput;
  fixed: FixedItem[];
  /** Plan précédent (replanification) : le solveur y reprend ce qu'on ne lui a pas demandé de changer. */
  previous?: PlanSession[];
};

/**
 * Place la semaine : overrides hebdo appliqués à une copie de la config,
 * indisponibilités matérialisées en blocs fixes, puis optimiseur déterministe
 * (K candidats scorés). Async pour garder une signature stable côté appelants,
 * mais aucun appel réseau : tout est pur calcul.
 */
export async function placeWeek(
  baseCfg: LifeConfig,
  args: PlaceArgs,
  opts: PlacementOptions = {}
): Promise<OptimizeResult> {
  const cfg = applyOverrides(baseCfg, args.input);
  const fixed = [...args.fixed, ...indispoAsFixed(cfg, args.input)];
  return solveWeekBest(cfg, { input: args.input, fixed, previous: args.previous }, opts);
}

/* ------------------------------ Retouche ------------------------------ */

function fixedBlock(fixed: FixedItem[]): string {
  if (fixed.length === 0) return "(aucun — semaine libre)";
  return fixed
    .map((f) => `- ${labelOf(f.start.slice(0, 10))} ${f.start.slice(11, 16)}-${f.end.slice(11, 16)} : ${f.title}${f.placeId ? ` [${f.placeId}]` : ""}`)
    .join("\n");
}

/** Applique des opérations de retouche (par id) à un plan existant. Pur. */
export function applyOperations(
  sessions: PlanSession[],
  ops: RetouchOp[]
): PlanSession[] {
  let next = sessions.map((s) => ({ ...s }));
  let addSeq = 0;
  for (const op of ops) {
    if (op.op === "remove") {
      next = next.filter((s) => s.id !== op.sessionId);
    } else if (op.op === "move") {
      const idx = next.findIndex((s) => s.id === op.sessionId);
      if (idx === -1) continue;
      next[idx] = {
        ...next[idx],
        start: `${op.day}T${op.start}:00`,
        end: `${op.day}T${op.end}:00`,
      };
    } else {
      addSeq++;
      const s = op.session;
      next.push({
        id: `add${addSeq}-${s.category}`,
        title: s.title,
        category: s.category,
        activityId: s.activityId ?? undefined,
        placeId: s.placeId ?? undefined,
        start: `${s.day}T${s.start}:00`,
        end: `${s.day}T${s.end}:00`,
        exceptional: s.exceptional || undefined,
        rationale: s.rationale || undefined,
      });
    }
  }
  next.sort((a, b) => a.start.localeCompare(b.start));
  return next;
}

/**
 * Retouche SANS LLM : les opérations sont déjà connues (Josiane les a déduites
 * elle-même dans sa boucle de chat, la cible étant explicite). On applique et
 * on revalide exactement comme `retouchWeek` — seules les violations
 * INTRODUITES bloquent, un plan déjà imparfait ne fait pas échouer une
 * modification sans rapport.
 */
export function applyRetouchOps(
  cfg: LifeConfig,
  args: { sessions: PlanSession[]; fixed: FixedItem[]; operations: RetouchOp[] }
): RetouchResult {
  // Les trajets sont DÉRIVÉS des blocs : on les retire avant d'opérer (une
  // opération qui les cible est ignorée) et on les régénère après — sinon un
  // bloc déplacé laissait ses anciens trajets orphelins sur le calendrier.
  const base = withoutTravel(args.sessions);
  const sessions = applyOperations(base, args.operations);
  const violations = checkWeekPlan(cfg, sessions, args.fixed);
  const before = new Set(checkWeekPlan(cfg, base, args.fixed).map(violationKey));
  const blockingErrors = violations
    .filter((v) => v.severity === "error" && !before.has(violationKey(v)))
    .map((v) => v.message);
  const notes: string[] = [];
  const withTravel = withTravelEvents(cfg, sessions, args.fixed, notes);

  return {
    sessions: withTravel,
    operations: args.operations,
    violations,
    warnings: [...notes, ...blockingErrors.map((m) => `Non résolu : ${m}`)],
    blockingErrors,
    attempts: 0,
  };
}

function withoutTravel(sessions: PlanSession[]): PlanSession[] {
  return sessions.filter((s) => s.category !== "trajet");
}

/** Sessions + trajets inter-zones régénérés, triés. */
function withTravelEvents(
  cfg: LifeConfig,
  sessions: PlanSession[],
  fixed: FixedItem[],
  notes: string[]
): PlanSession[] {
  return [...sessions, ...buildTravelEvents(cfg, sessions, fixed, notes)].sort((a, b) =>
    a.start.localeCompare(b.start)
  );
}

export type RetouchResult = {
  sessions: PlanSession[];
  operations: RetouchOp[];
  violations: Violation[];
  warnings: string[];
  /** Erreurs INTRODUITES par la retouche et non résolues — ne pas auto-appliquer. */
  blockingErrors: string[];
  attempts: number;
};

/**
 * Retouche ciblée d'un plan en place : le LLM remplit des opérations minimales
 * par id (le seul JSON qu'il produit encore), re-validées par les guardrails
 * (1 re-prompt en cas d'erreur, puis on remonte les violations restantes —
 * pas de réparation destructive sur une retouche).
 */
export async function retouchWeek(
  baseCfg: LifeConfig,
  args: {
    weekStart: string;
    changeNote: string;
    sessions: PlanSession[];
    fixed: FixedItem[];
  },
  opts: PlacementOptions = {}
): Promise<RetouchResult> {
  const cfg = baseCfg;
  const system = buildJosianeRetouchSystem(cfg);
  // Les trajets (dérivés) ne sont ni montrés ni opérables : régénérés à la fin.
  const base = withoutTravel(args.sessions);
  const planBlock = base
    .map(
      (s) =>
        `- id=${s.id} | ${labelOf(s.start.slice(0, 10))} ${s.start.slice(11, 16)}-${s.end.slice(11, 16)} | ${s.title} [${s.category}]${s.placeId ? ` @ ${s.placeId}` : ""}`
    )
    .join("\n");
  const user = `SEMAINE :
${weekDates(args.weekStart).map(labelOf).map((l) => `- ${l}`).join("\n")}

ÉVÉNEMENTS FIXES (intouchables) :
${fixedBlock(args.fixed)}

PLANNING EN PLACE :
${planBlock || "(vide)"}

MODIFICATION DEMANDÉE :
"""${args.changeNote}"""

Renvoie les opérations minimales.`;

  let attempts = 0;
  const call = async (userContent: string): Promise<JosianeRetouchOut> => {
    attempts++;
    return callJson(JosianeRetouchOutSchema, {
      agent: "josiane-retouche",
      role: "planner",
      model: opts.model,
      system,
      user: userContent,
      chat: opts.chat,
      effort: retouchEffort(),
    });
  };

  let out = await call(user);
  let sessions = applyOperations(base, out.operations);
  let violations = checkWeekPlan(cfg, sessions, args.fixed);

  const before = new Set(checkWeekPlan(cfg, base, args.fixed).map(violationKey));
  const isNew = (v: Violation) => !before.has(violationKey(v));

  // Un seul re-prompt : seules les erreurs INTRODUITES par la retouche comptent
  // (un plan déjà imparfait ne bloque pas une retouche sans rapport).
  const newErrors = violations.filter((v) => v.severity === "error" && isNew(v));
  if (newErrors.length > 0) {
    const repromptUser = `${user}

TES OPÉRATIONS :
${JSON.stringify(out.operations, null, 1)}

Elles introduisent ces violations — corrige UNIQUEMENT ça :
${newErrors.map((v) => `- [${v.rule}] ${v.message}`).join("\n")}

Renvoie les opérations corrigées.`;
    out = await call(repromptUser);
    sessions = applyOperations(base, out.operations);
    violations = checkWeekPlan(cfg, sessions, args.fixed);
  }

  const blockingErrors = violations
    .filter((v) => v.severity === "error" && isNew(v))
    .map((v) => v.message);
  const notes: string[] = [];
  const withTravel = withTravelEvents(cfg, sessions, args.fixed, notes);

  return {
    sessions: withTravel,
    operations: out.operations,
    violations,
    warnings: [...out.warnings, ...notes, ...blockingErrors.map((m) => `Non résolu : ${m}`)],
    blockingErrors,
    attempts,
  };
}

/* --------------------------- Replanification -------------------------- */

/**
 * Retouche PAR LE SOLVEUR (v5.1) : le LLM ne déplace rien — il traduit la
 * demande de modification en un PATCH de la demande hebdo d'origine (décisions
 * « muscu jeudi soir », ajout/retrait de sorties, indisponibilités…), validé
 * par zod. L'appelant re-résout ensuite TOUTE la semaine avec la demande
 * patchée : déjeuner, Monumia et trajets sont recalés de façon cohérente, là
 * où une opération à la main laissait le reste du plan incohérent.
 */
export async function replanInput(
  cfg: LifeConfig,
  args: {
    input: WeekInput;
    changeNote: string;
    sessions: PlanSession[];
    fixed: FixedItem[];
  },
  opts: PlacementOptions = {}
): Promise<{ input: WeekInput; patch: ReplanPatch }> {
  const system = buildReplanPatchSystem(cfg);
  const planBlock = withoutTravel(args.sessions)
    .map(
      (s) =>
        `- ${labelOf(s.start.slice(0, 10))} ${s.start.slice(11, 16)}-${s.end.slice(11, 16)} | ${s.title} [${s.category}]${s.placeId ? ` @ ${s.placeId}` : ""}`
    )
    .join("\n");
  const user = `SEMAINE :
${weekDates(args.input.weekStart).map(labelOf).map((l) => `- ${l}`).join("\n")}

ÉVÉNEMENTS FIXES (intouchables) :
${fixedBlock(args.fixed)}

DEMANDE D'ORIGINE (JSON — c'est elle que tu patches) :
${JSON.stringify(args.input, null, 1)}

PLANNING ACTUEL (produit par le solveur depuis cette demande) :
${planBlock || "(vide)"}

MODIFICATION DEMANDÉE :
"""${args.changeNote}"""

Renvoie le patch minimal.`;

  const patch = await callJson(ReplanPatchSchema, {
    agent: "replanification",
    role: "planner",
    model: opts.model,
    system,
    user,
    chat: opts.chat,
    onEvent: opts.onEvent,
  });
  return { input: applyReplanPatch(args.input, patch), patch };
}

function violationKey(v: Violation): string {
  return `${v.rule}|${v.message}`;
}
