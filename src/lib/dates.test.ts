/**
 * Les ancres de semaine sont RÉSOLUES côté serveur : c'est la seule protection
 * contre un modèle qui calcule lui-même « le lundi de la semaine prochaine ».
 * Vécu : demande faite un dimanche, plan produit et validé sur la semaine
 * D'APRÈS (convention US : la semaine commence le dimanche).
 */

import { describe, expect, it } from "vitest";
import { weekAnchors, startOfWeek, toLocalIso } from "./dates";

const monday = (d: Date) => toLocalIso(startOfWeek(d)).slice(0, 10);

describe("weekAnchors", () => {
  it("un DIMANCHE, la semaine en cours est celle qui se termine ce jour-là", () => {
    const dimanche = new Date("2026-09-06T17:00:00");
    expect(monday(dimanche)).toBe("2026-08-31");
    const out = weekAnchors(dimanche);
    expect(out).toContain("SEMAINE EN COURS : lundi 31 août 2026 → dimanche 6 septembre 2026 (weekStart=2026-08-31)");
    expect(out).toContain("SEMAINE PROCHAINE : lundi 7 septembre 2026 → dimanche 13 septembre 2026 (weekStart=2026-09-07)");
  });

  it("un LUNDI, la semaine en cours commence le jour même", () => {
    const out = weekAnchors(new Date("2026-09-07T09:00:00"));
    expect(out).toContain("(weekStart=2026-09-07)");
    expect(out).toContain("(weekStart=2026-09-14)");
  });

  it("un VENDREDI, la semaine prochaine est bien le lundi suivant", () => {
    const out = weekAnchors(new Date("2026-09-04T17:00:00"));
    expect(out).toContain("SEMAINE PROCHAINE : lundi 7 septembre 2026");
  });
});
