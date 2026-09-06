/**
 * Ce qu'une REPLANIFICATION doit respecter — tiré d'une semaine vécue
 * (2026-09-07, cours tous les matins, Delos tout à distance) :
 *
 *   - « natation avant de manger » → au creux de midi, déjeuner juste après ;
 *   - « Delos vendredi → mercredi » ne déplace QUE le vendredi ;
 *   - un rendez-vous de 15 min à 13h ne repousse pas le déjeuner à 13h15.
 *
 * Tout est pur : le solveur est déterministe, aucun LLM.
 */

import { describe, expect, it } from "vitest";
import { addDays, toLocalIso } from "../dates";
import { testConfig as cfg } from "./__fixtures__/testConfig";
import { WeekInputSchema } from "./contracts";
import { placedDelosDecisions } from "./council";
import { applyOverrides } from "./josiane";
import { solveWeek } from "./solver";
import type { FixedItem, PlanSession } from "./types";

const WEEK = "2026-09-07"; // un lundi
const day = (i: number) => toLocalIso(addDays(new Date(`${WEEK}T12:00:00`), i)).slice(0, 10);
const hm = (iso: string) => iso.slice(11, 16);

/** Cours 9h-12h tous les jours de semaine, à la fac. */
function coursTousLesMatins(): FixedItem[] {
  return [0, 1, 2, 3, 4].map((i) => ({
    id: `c${i}`,
    title: "Cours de statistiques",
    start: `${day(i)}T09:00:00`,
    end: `${day(i)}T12:00:00`,
    placeId: "fac",
  }));
}

const input = (extra: Record<string, unknown> = {}) =>
  WeekInputSchema.parse({ weekStart: WEEK, ...extra });

/** Config d'une semaine « Delos tout à distance ». */
const remoteWeek = input({ overrides: { delosPresentielHalfDays: 0 } });
const cfgRemote = applyOverrides(cfg, remoteWeek);

const onDay = (sessions: PlanSession[], i: number, category: string) =>
  sessions.filter((s) => s.category === category && s.start.startsWith(day(i)));
const delosDays = (sessions: PlanSession[]) =>
  [...new Set(sessions.filter((s) => s.category === "delos").map((s) => s.start.slice(0, 10)))].sort();
const sportDay = (sessions: PlanSession[], activityId: string) =>
  sessions.find((s) => s.category === "sport" && s.activityId === activityId)?.start.slice(0, 10);

describe("déjeuner face à un rendez-vous court à 13h", () => {
  it("mange en sortant du cours (12h), pas collé derrière le rendez-vous (13h15)", () => {
    const fixed: FixedItem[] = [
      ...coursTousLesMatins(),
      { id: "suaps", title: "Inscription SUAPS", start: `${day(2)}T13:00:00`, end: `${day(2)}T13:15:00` },
    ];
    const res = solveWeek(cfgRemote, { input: remoteWeek, fixed });
    const lunch = onDay(res.sessions, 2, "repas");
    expect(lunch).toHaveLength(1);
    expect(hm(lunch[0].start)).toBe("12:00");
  });
});

describe("décision sport « midi »", () => {
  it("pose la séance entre le cours et le déjeuner, le déjeuner juste après", () => {
    // La course : sans lieu et « matin ok » — le creux de midi lui était refusé
    // d'office. Demandé explicitement, il doit passer.
    const res = solveWeek(cfgRemote, {
      input: remoteWeek,
      fixed: coursTousLesMatins(),
      decisions: { delos: [], sport: [{ activityId: "course", date: day(0), moment: "midi" }], sorties: [] },
    });
    expect(res.rejected.filter((r) => r.kind === "sport")).toEqual([]);
    const [course] = onDay(res.sessions, 0, "sport").filter((s) => s.activityId === "course");
    expect(course).toBeDefined();
    // Collée à la sortie du cours (12h), transition comprise.
    expect(hm(course.start) >= "12:00" && hm(course.start) <= "12:30").toBe(true);
    const [lunch] = onDay(res.sessions, 0, "repas");
    expect(lunch).toBeDefined();
    expect(lunch.start >= course.end).toBe(true);
  });

  it("une décision sur une activité à créneau imposé est rejetée, pas ignorée", () => {
    // La natation du fixture a un créneau imposé (jeudi 18h).
    const res = solveWeek(cfgRemote, {
      input: remoteWeek,
      fixed: coursTousLesMatins(),
      decisions: { delos: [], sport: [{ activityId: "natation", date: day(0), moment: "midi" }], sorties: [] },
    });
    expect(res.rejected.some((r) => r.kind === "sport" && /imposé/.test(r.reason))).toBe(true);
  });
});

describe("Delos à distance pilotable", () => {
  it("honore « Delos mercredi après-midi » quand la semaine n'a aucun présentiel", () => {
    const res = solveWeek(cfgRemote, {
      input: remoteWeek,
      fixed: coursTousLesMatins(),
      decisions: { delos: [{ date: day(2), gabarit: "apres-midi" }], sport: [], sorties: [] },
    });
    expect(res.rejected.filter((r) => r.kind === "delos")).toEqual([]);
    const wed = onDay(res.sessions, 2, "delos");
    expect(wed).toHaveLength(1);
    expect(wed[0].title).toBe("Delos (à distance)");
    expect(hm(wed[0].start) >= "13:00").toBe(true);
    // Le volume est complet : 12h en blocs de 4h → 3 jours.
    expect(delosDays(res.sessions)).toHaveLength(3);
  });

  it("une décision « distance » explicite n'est pas prise pour du présentiel", () => {
    const res = solveWeek(cfg, {
      input: input(),
      fixed: coursTousLesMatins(),
      decisions: { delos: [{ date: day(2), gabarit: "apres-midi", modalite: "distance" }], sport: [], sorties: [] },
    });
    // Sans heures à distance dans cette config, la décision n'a rien à poser :
    // elle ne doit surtout pas être HONORÉE comme une demi-journée sur place
    // (le repli seedé reste libre de choisir mercredi, mais de lui-même).
    const demanded = res.sessions.filter((s) => s.category === "delos" && /jour demandé/.test(s.rationale ?? ""));
    expect(demanded).toEqual([]);
  });
});

describe("replanification : ne bouge que ce qu'on demande", () => {
  const fixed = coursTousLesMatins();
  const first = solveWeek(cfgRemote, { input: remoteWeek, fixed, seed: "a" });
  const before = delosDays(first.sessions);

  it("déplacer UNE demi-journée Delos garde les deux autres à leur place", () => {
    expect(before).toHaveLength(3);
    const free = [0, 1, 2, 3, 4].map(day).find((d) => !before.includes(d))!;
    const moved = before[before.length - 1];
    const res = solveWeek(cfgRemote, {
      input: remoteWeek,
      fixed,
      seed: "b", // un autre seed : c'est `previous` qui doit tenir, pas le hasard
      previous: first.sessions,
      decisions: {
        delos: before.filter((d) => d !== moved).map((date) => ({ date, gabarit: "apres-midi" as const })).concat([
          { date: free, gabarit: "apres-midi" as const },
        ]),
        sport: [],
        sorties: [],
      },
    });
    expect(delosDays(res.sessions)).toEqual([...before.filter((d) => d !== moved), free].sort());
  });

  it("même avec une décision partielle, les jours précédents sont préférés", () => {
    const free = [0, 1, 2, 3, 4].map(day).find((d) => !before.includes(d))!;
    const res = solveWeek(cfgRemote, {
      input: remoteWeek,
      fixed,
      seed: "c",
      previous: first.sessions,
      decisions: { delos: [{ date: free, gabarit: "apres-midi" }], sport: [], sorties: [] },
    });
    const after = delosDays(res.sessions);
    expect(after).toContain(free);
    // Deux des trois jours d'avant sont conservés (celui qui « part » n'est pas connu du solveur).
    expect(after.filter((d) => before.includes(d))).toHaveLength(2);
  });

  it("les séances de sport restent sur leur jour", () => {
    const res = solveWeek(cfgRemote, { input: remoteWeek, fixed, seed: "d", previous: first.sessions });
    for (const act of ["course", "natation", "salle"]) {
      expect(sportDay(res.sessions, act)).toBe(sportDay(first.sessions, act));
    }
  });
});

describe("placedDelosDecisions", () => {
  it("relit les demi-journées posées, présentiel comme distance", () => {
    const sessions: PlanSession[] = [
      { id: "1", title: "Delos (présentiel)", category: "delos", placeId: "delos", start: `${day(0)}T09:00:00`, end: `${day(0)}T13:00:00` },
      { id: "2", title: "Delos (présentiel)", category: "delos", placeId: "delos", start: `${day(0)}T14:00:00`, end: `${day(0)}T18:00:00` },
      { id: "3", title: "Delos (à distance)", category: "delos", placeId: "bibli", start: `${day(2)}T13:15:00`, end: `${day(2)}T17:15:00` },
      { id: "4", title: "Monumia", category: "monumia", placeId: "bibli", start: `${day(3)}T14:00:00`, end: `${day(3)}T18:00:00` },
    ];
    expect(placedDelosDecisions(cfg, sessions)).toEqual([
      { date: day(0), gabarit: "journee", modalite: "presentiel" },
      { date: day(2), gabarit: "apres-midi", modalite: "distance" },
    ]);
  });
});
