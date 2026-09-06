import { describe, expect, it } from "vitest";
import {
  JosianeRetouchOutSchema,
  ReplanPatchSchema,
  RetouchOpSchema,
  WeekInputSchema,
  applyReplanPatch,
} from "./contracts";

describe("WeekInput", () => {
  it("accepte une demande minimale (défauts appliqués)", () => {
    const input = WeekInputSchema.parse({ weekStart: "2026-07-20" });
    expect(input.imprevus).toEqual([]);
    expect(input.voitureDispo).toBe(true);
    expect(input.overrides).toEqual({});
  });

  it("accepte une demande complète avec overrides", () => {
    const input = WeekInputSchema.parse({
      weekStart: "2026-07-20",
      notes: "semaine chargée",
      imprevus: [{ label: "TP optim", hoursNeeded: 4, deadline: "2026-07-24" }],
      sortiesDatees: [
        { label: "Dîner Marine", withWhom: "marine", day: "2026-07-24", start: "20:00" },
      ],
      indisponibilites: [{ day: "2026-07-26", reason: "chez les parents" }],
      voitureDispo: false,
      overrides: { sortiesMarineMin: 0 },
    });
    expect(input.overrides.sortiesMarineMin).toBe(0);
    expect(input.sortiesDatees[0].withWhom).toBe("marine");
  });

  it("rejette une date mal formée", () => {
    expect(() => WeekInputSchema.parse({ weekStart: "lundi prochain" })).toThrow();
  });

  it("sport (v5) : défauts vides, surcharge hebdo acceptée", () => {
    const minimal = WeekInputSchema.parse({ weekStart: "2026-07-20" });
    expect(minimal.sport).toEqual({ exclure: [], imposer: [] });

    const input = WeekInputSchema.parse({
      weekStart: "2026-07-20",
      sport: { exclure: ["natation"], imposer: [{ activityId: "escalade" }] },
    });
    expect(input.sport.exclure).toEqual(["natation"]);
    expect(input.sport.imposer).toEqual([{ activityId: "escalade", fois: 1 }]);
  });

  it("sport (v5) : borne le nombre de fois", () => {
    expect(() =>
      WeekInputSchema.parse({
        weekStart: "2026-07-20",
        sport: { imposer: [{ activityId: "course", fois: 9 }] },
      })
    ).toThrow();
  });
});

describe("retouche", () => {
  it("RetouchOp : union discriminée move/remove/add", () => {
    expect(
      RetouchOpSchema.parse({
        op: "move",
        sessionId: "s1",
        day: "2026-07-20",
        start: "10:00",
        end: "12:00",
      }).op
    ).toBe("move");
    expect(() => RetouchOpSchema.parse({ op: "move", sessionId: "s1" })).toThrow();
    expect(RetouchOpSchema.parse({ op: "remove", sessionId: "s1" }).op).toBe("remove");
  });

  it("JosianeRetouchOut : catégorie tolérante au français naturel", () => {
    const out = JosianeRetouchOutSchema.parse({
      operations: [
        {
          op: "add",
          session: {
            title: "Dîner",
            category: "Déjeuner",
            day: "2026-07-20",
            start: "12:00",
            end: "13:00",
          },
        },
      ],
    });
    const add = out.operations[0];
    expect(add.op === "add" && add.session.category).toBe("repas");
  });
});

describe("v5.1 : décisions, zone, plafond Monumia, patch de replanification", () => {
  it("decisions : défauts vides, gabarit/moment par défaut", () => {
    const minimal = WeekInputSchema.parse({ weekStart: "2026-07-20" });
    expect(minimal.decisions).toEqual({ delos: [], sport: [], sorties: [] });
    const input = WeekInputSchema.parse({
      weekStart: "2026-07-20",
      decisions: { delos: [{ date: "2026-07-21" }], sport: [{ activityId: "salle", date: "2026-07-23" }] },
    });
    expect(input.decisions.delos[0].gabarit).toBe("journee");
    expect(input.decisions.sport[0].moment).toBe("fin-apres-midi");
  });

  it("zone d'une sortie et plafond Monumia hebdo (jamais sous 20h)", () => {
    const input = WeekInputSchema.parse({
      weekStart: "2026-07-20",
      sortiesDatees: [{ label: "Dîner", zone: "paris" }],
      overrides: { monumiaMaxHours: 22 },
    });
    expect(input.sortiesDatees[0].zone).toBe("paris");
    expect(input.overrides.monumiaMaxHours).toBe(22);
    expect(() =>
      WeekInputSchema.parse({ weekStart: "2026-07-20", overrides: { monumiaMaxHours: 10 } })
    ).toThrow();
  });

  it("applyReplanPatch : ajoute/retire par label, remplace les décisions PAR FAMILLE, conserve le reste — pur", () => {
    const base = WeekInputSchema.parse({
      weekStart: "2026-07-20",
      imprevus: [{ label: "TP optim", hoursNeeded: 4 }],
      sortiesDatees: [{ label: "Dîner Marine", withWhom: "marine", day: "2026-07-24" }],
      decisions: { delos: [{ date: "2026-07-21" }], sport: [{ activityId: "salle", date: "2026-07-22" }] },
    });
    const patch = ReplanPatchSchema.parse({
      decisions: { sport: [{ activityId: "salle", date: "2026-07-23" }] },
      imprevusSupprimes: ["tp optim"],
      sortiesAjoutees: [{ label: "Ciné", withWhom: "amis", day: "2026-07-25" }],
      indisponibilitesAjoutees: [{ day: "2026-07-26" }],
      warnings: ["pas compris « et le reste »"],
    });
    const next = applyReplanPatch(base, patch);
    expect(next.imprevus).toEqual([]);
    expect(next.sortiesDatees.map((s) => s.label)).toEqual(["Dîner Marine", "Ciné"]);
    expect(next.indisponibilites).toHaveLength(1);
    // Famille non touchée conservée ; famille fournie remplacée.
    expect(next.decisions.delos).toEqual(base.decisions.delos);
    expect(next.decisions.sport[0].date).toBe("2026-07-23");
    // La demande d'origine n'est pas mutée.
    expect(base.decisions.sport[0].date).toBe("2026-07-22");
    expect(base.imprevus).toHaveLength(1);
  });

  it("applyReplanPatch : un patch VIDE est l'identité — le plan re-résolu sera identique", () => {
    const base = WeekInputSchema.parse({
      weekStart: "2026-07-20",
      engagements: [{ label: "Inscription SUAPS", day: "2026-07-22", start: "13:00", durationMin: 15 }],
    });
    const next = applyReplanPatch(base, ReplanPatchSchema.parse({}));
    expect(next).toEqual(base);
  });
});
