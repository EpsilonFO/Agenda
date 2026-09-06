/**
 * Les RENDEZ-VOUS à heure fixe (v5.2) : posés le jour dit, à l'heure dite.
 *
 * Vécu, la raison de ce champ : « ajoute une inscription SUAPS le mercredi à
 * 13h, ~15 min » n'avait d'autre voie que `imprevus` — le solveur en avait fait
 * un bloc de travail d'1h30 posé le LUNDI « pour garder de la marge », et deux
 * replanifications de suite n'ont pas su le corriger.
 */

import { describe, expect, it } from "vitest";
import { testConfig } from "./__fixtures__/testConfig";
import { WeekInputSchema, applyReplanPatch, ReplanPatchSchema } from "./contracts";
import { checkWeekPlan } from "./guardrails";
import { solveWeek } from "./solver";
import type { PlanSession } from "./types";

const WEEK = "2026-07-27"; // lundi
const MERCREDI = "2026-07-29";

const suaps = {
  label: "Inscription SUAPS",
  day: MERCREDI,
  start: "13:00",
  durationMin: 15,
};

function solve(over: Record<string, unknown> = {}) {
  return solveWeek(testConfig, {
    input: WeekInputSchema.parse({ weekStart: WEEK, engagements: [suaps], ...over }),
    fixed: [],
  });
}

const find = (sessions: PlanSession[], title: string) =>
  sessions.filter((s) => s.title === title);

describe("engagements — rendez-vous à heure fixe", () => {
  it("pose le rendez-vous au jour et à l'heure dits, pour la durée dite", () => {
    const blocks = find(solve().sessions, "Inscription SUAPS");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].start).toBe(`${MERCREDI}T13:00:00`);
    expect(blocks[0].end).toBe(`${MERCREDI}T13:15:00`);
  });

  it("ne déclenche aucune violation et n'est pas confondu avec un imprévu", () => {
    const res = solve();
    const errors = checkWeekPlan(testConfig, res.sessions, [], {
      engagements: [suaps],
    }).filter((v) => v.severity === "error");
    expect(errors).toEqual([]);
  });

  it("le reste de la semaine le contourne (aucun chevauchement)", () => {
    const res = solve();
    const rdv = find(res.sessions, "Inscription SUAPS")[0];
    const overlapping = res.sessions.filter(
      (s) => s !== rdv && s.start < rdv.end && s.end > rdv.start
    );
    expect(overlapping).toEqual([]);
  });

  it("un rendez-vous hors semaine est signalé, jamais posé au hasard", () => {
    const res = solveWeek(testConfig, {
      input: WeekInputSchema.parse({
        weekStart: WEEK,
        engagements: [{ ...suaps, day: "2026-08-15" }],
      }),
      fixed: [],
    });
    expect(find(res.sessions, "Inscription SUAPS")).toHaveLength(0);
    expect(res.warnings.join(" ")).toContain("Inscription SUAPS");
  });

  it("le garde-fou crie si le rendez-vous n'est pas à l'heure demandée", () => {
    const decale: PlanSession[] = [
      {
        id: "x",
        title: "Inscription SUAPS",
        category: "autre",
        start: "2026-07-27T09:00:00",
        end: "2026-07-27T10:30:00",
        placeId: "bibli",
      },
    ];
    const errors = checkWeekPlan(testConfig, decale, [], { engagements: [suaps] })
      .filter((v) => v.rule === "engagement-place");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("error");
  });
});

describe("replanification d'un rendez-vous mal daté", () => {
  it("le même label re-daté REMPLACE l'ancien au lieu de le doubler", () => {
    const input = WeekInputSchema.parse({
      weekStart: WEEK,
      engagements: [{ ...suaps, day: "2026-07-27", start: "08:00" }],
    });
    const patched = applyReplanPatch(
      input,
      ReplanPatchSchema.parse({ engagementsAjoutes: [suaps] })
    );
    expect(patched.engagements).toHaveLength(1);
    expect(patched.engagements[0].day).toBe(MERCREDI);
    expect(patched.engagements[0].start).toBe("13:00");
  });
});
