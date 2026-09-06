import { describe, expect, it } from "vitest";
import { josianeHorizon } from "./context";
import type { EventItem } from "../types";

const ev = (over: Partial<EventItem>): EventItem =>
  ({
    id: "x",
    title: "Truc",
    start: "2026-09-07T09:00:00",
    end: "2026-09-07T12:00:00",
    category: "études",
    ...over,
  }) as EventItem;

describe("josianeHorizon", () => {
  const now = new Date("2026-09-04T17:00:00");

  it("expose l'id de chaque événement — c'est ce qui évite un list_events", () => {
    const out = josianeHorizon(
      [ev({ id: "stats-lundi", title: "Cours de statistiques" })],
      now,
      15
    );
    expect(out).toContain("lundi 7 septembre 2026 :");
    expect(out).toContain("09:00–12:00 Cours de statistiques [études] · id=stats-lundi");
  });

  it("marque les séances du plan, pour router vers edit_plan_sessions", () => {
    const out = josianeHorizon(
      [ev({ id: "a", source: "plan" }), ev({ id: "b", start: "2026-09-08T09:00:00", end: "2026-09-08T10:00:00" })],
      now,
      15
    );
    expect(out).toContain("id=a (plan)");
    expect(out).toContain("id=b\n");
  });

  it("liste aussi les jours vides — ils ancrent les dates", () => {
    const out = josianeHorizon([], now, 3);
    expect(out.split("\n")).toEqual([
      "vendredi 4 septembre 2026 (aujourd'hui) : (rien de prévu)",
      "samedi 5 septembre 2026 : (rien de prévu)",
      "dimanche 6 septembre 2026 : (rien de prévu)",
    ]);
  });

  it("ignore ce qui est hors fenêtre (passé, ou au-delà de l'horizon)", () => {
    const out = josianeHorizon(
      [
        ev({ id: "hier", start: "2026-09-03T09:00:00", end: "2026-09-03T10:00:00" }),
        ev({ id: "loin", start: "2026-10-20T09:00:00", end: "2026-10-20T10:00:00" }),
      ],
      now,
      15
    );
    expect(out).not.toContain("id=hier");
    expect(out).not.toContain("id=loin");
  });
});
