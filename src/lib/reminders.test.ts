import { describe, expect, it } from "vitest";
import { isDue, leadsFor, parseLeads } from "./reminders";

describe("parseLeads", () => {
  it("lit une liste de préavis, du plus lointain au plus proche", () => {
    expect(parseLeads("30,5,1")).toEqual([30, 5, 1]);
  });

  it("accepte une valeur seule (ancienne configuration)", () => {
    expect(parseLeads("20")).toEqual([20]);
  });

  it("trie et dédoublonne", () => {
    expect(parseLeads("5, 20, 5")).toEqual([20, 5]);
  });

  it("retombe sur 20 et 1 min sans configuration lisible", () => {
    expect(parseLeads(undefined)).toEqual([20, 1]);
    expect(parseLeads("")).toEqual([20, 1]);
    expect(parseLeads("abc")).toEqual([20, 1]);
    expect(parseLeads("-5,0")).toEqual([20, 1]);
  });
});

describe("leadsFor", () => {
  const leads = [20, 1];

  it("utilise les préavis globaux sans rappel personnalisé", () => {
    expect(leadsFor({}, leads)).toEqual([20, 1]);
    expect(leadsFor({ reminderMin: 0 }, leads)).toEqual([20, 1]);
  });

  it("remplace le préavis de préparation mais garde le dernier appel", () => {
    expect(leadsFor({ reminderMin: 60 }, leads)).toEqual([60, 1]);
  });

  it("ne double pas le dernier appel quand c'est le préavis demandé", () => {
    expect(leadsFor({ reminderMin: 1 }, leads)).toEqual([1]);
  });

  it("garde l'ordre décroissant même si le rappel demandé est plus court", () => {
    expect(leadsFor({ reminderMin: 2 }, [20, 5])).toEqual([5, 2]);
  });
});

describe("isDue", () => {
  it("déclenche dans la fenêtre du préavis", () => {
    expect(isDue(0, 1)).toBe(true);
    expect(isDue(0.5, 1)).toBe(true);
    expect(isDue(19, 20)).toBe(true);
  });

  it("tolère un passage périodique en retard", () => {
    expect(isDue(1.2, 1)).toBe(true);
  });

  it("ne déclenche pas trop tôt ni après le début", () => {
    expect(isDue(2, 1)).toBe(false);
    expect(isDue(25, 20)).toBe(false);
    expect(isDue(-0.5, 1)).toBe(false);
  });
});
