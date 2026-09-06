/**
 * Le nouveau contrat Delos : 2 demi-journées de PRÉSENTIEL à Paris (groupées
 * sur une journée par défaut) + des heures À DISTANCE hors Paris, découpées par
 * le solveur — jamais par un modèle.
 */

import { describe, expect, it } from "vitest";
import { testConfig } from "./__fixtures__/testConfig";
import { WeekInputSchema } from "./contracts";
import { applyOverrides } from "./josiane";
import { checkWeekPlan } from "./guardrails";
import { solveWeek, type SolverDecisions } from "./solver";
import type { PlanSession } from "./types";

const WEEK = "2026-07-27";

function cfgWith(over: Record<string, unknown>) {
  const c = structuredClone(testConfig);
  Object.assign(c.work.delos, over);
  return c;
}

function solve(cfg: ReturnType<typeof cfgWith>, decisions: SolverDecisions = {}) {
  return solveWeek(cfg, {
    input: WeekInputSchema.parse({ weekStart: WEEK }),
    fixed: [],
    decisions,
  });
}

const delosOf = (r: { sessions: PlanSession[] }) =>
  r.sessions.filter((s) => s.category === "delos");

const hours = (s: { start: string; end: string }) =>
  (new Date(s.end).getTime() - new Date(s.start).getTime()) / 3600000;

describe("Delos — présentiel + heures à distance", () => {
  const base = {
    presentielHalfDaysPerWeek: 2,
    groupHalfDays: true,
    remote: { hoursPerWeek: 4, placeId: "bibli", blockHours: [4, 2] },
  };

  it("pose 2 demi-journées de présentiel sur UNE seule journée par défaut", () => {
    const res = solve(cfgWith(base));
    const presentiel = delosOf(res).filter((s) => s.placeId === "delos");
    expect(presentiel).toHaveLength(2);
    expect(presentiel[0].start.slice(0, 10)).toBe(presentiel[1].start.slice(0, 10));
  });

  it("groupHalfDays=false les étale sur des jours distincts", () => {
    const res = solve(cfgWith({ ...base, groupHalfDays: false }));
    const days = new Set(
      delosOf(res)
        .filter((s) => s.placeId === "delos")
        .map((s) => s.start.slice(0, 10))
    );
    expect(days.size).toBe(2);
  });

  it("pose les heures à distance hors Paris, en 1×4h quand ça rentre", () => {
    const res = solve(cfgWith(base));
    const remote = delosOf(res).filter((s) => s.placeId === "bibli");
    expect(remote).toHaveLength(1);
    expect(hours(remote[0])).toBe(4);
  });

  it("retombe sur 2×2h quand aucun bloc de 4h ne rentre", () => {
    // Journées courtes : 4h d'affilée ne tiennent nulle part, 2h oui.
    const cfg = cfgWith(base);
    cfg.schedule.dayStart = "08:00";
    cfg.schedule.normalEnd = "10:30";
    const remote = delosOf(solve(cfg)).filter((s) => s.placeId === "bibli");
    expect(remote.length).toBe(2);
    for (const s of remote) expect(hours(s)).toBe(2);
  });

  it("le volume total reste présentiel + distance, sans violation de quota", () => {
    const res = solve(cfgWith(base));
    const total = delosOf(res).reduce((a, s) => a + hours(s), 0);
    expect(total).toBe(12);
    const quota = checkWeekPlan(cfgWith(base), res.sessions, []).filter(
      (v) => v.rule === "delos-quota"
    );
    expect(quota).toEqual([]);
  });

  it("les heures à distance ne sont PAS jugées hors gabarit", () => {
    const res = solve(cfgWith(base));
    const windowErrors = checkWeekPlan(cfgWith(base), res.sessions, []).filter(
      (v) => v.rule === "delos-window"
    );
    expect(windowErrors).toEqual([]);
  });

  it("une demi-journée demandée au-delà du quota est REFUSÉE, pas ignorée", () => {
    const res = solve(cfgWith(base), {
      delos: [
        { date: "2026-07-28", gabarit: "journee" },
        { date: "2026-07-31", gabarit: "matin" },
      ],
    });
    const refus = res.rejected.filter((r) => r.kind === "delos");
    expect(refus).toHaveLength(1);
    expect(refus[0].ref).toBe("2026-07-31");
    expect(refus[0].reason).toMatch(/quota/i);
  });
});

/**
 * MODALITÉ Delos (v5.2) : « cette semaine j'ai cours tous les jours, je fais
 * tout à distance » ne réduit RIEN — les demi-journées qui quittent le
 * présentiel repassent en heures à distance, heure pour heure. Vécu : faute de
 * ce levier, la demande était ignorée en silence et le solveur imposait deux
 * demi-journées à Paris avec leurs trajets.
 */
describe("modalité Delos — présentiel ↔ distance, volume constant", () => {
  const base = {
    presentielHalfDaysPerWeek: 2,
    groupHalfDays: true,
    remote: { hoursPerWeek: 4, placeId: "bibli", blockHours: [4, 2] },
  };
  const TOTAL = 2 * 4 + 4; // 12h de CDD

  const withOverride = (n: number) => {
    const input = WeekInputSchema.parse({
      weekStart: WEEK,
      overrides: { delosPresentielHalfDays: n },
    });
    return { input, cfg: applyOverrides(cfgWith(base), input) };
  };

  it("0 demi-journée sur place : tout le volume bascule à distance", () => {
    const { cfg, input } = withOverride(0);
    expect(cfg.work.delos.presentielHalfDaysPerWeek).toBe(0);
    expect(cfg.work.delos.remote?.hoursPerWeek).toBe(TOTAL);

    const delos = delosOf(solveWeek(cfg, { input, fixed: [] }));
    expect(delos.filter((s) => s.placeId === "delos")).toHaveLength(0);
    expect(delos.reduce((a, s) => a + hours(s), 0)).toBe(TOTAL);
  });

  it("1 demi-journée sur place : le reste passe à distance (total inchangé)", () => {
    const { cfg, input } = withOverride(1);
    expect(cfg.work.delos.remote?.hoursPerWeek).toBe(TOTAL - 4);

    const delos = delosOf(solveWeek(cfg, { input, fixed: [] }));
    expect(delos.filter((s) => s.placeId === "delos")).toHaveLength(1);
    expect(delos.reduce((a, s) => a + hours(s), 0)).toBe(TOTAL);
  });

  it("ne mute pas la config de base", () => {
    const cfg = cfgWith(base);
    applyOverrides(cfg, WeekInputSchema.parse({
      weekStart: WEEK,
      overrides: { delosPresentielHalfDays: 0 },
    }));
    expect(cfg.work.delos.presentielHalfDaysPerWeek).toBe(2);
    expect(cfg.work.delos.remote?.hoursPerWeek).toBe(4);
  });
});
