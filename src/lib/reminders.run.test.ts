import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import type { EventItem } from "./types";

/**
 * Frise horaire du passage périodique : deux rappels par événement, un seul
 * envoi par passage, aucun doublon.
 *
 * Les envois push sont capturés, et le module est importé APRÈS un changement
 * de répertoire courant : `data/notified.json` s'écrit dans un dossier
 * temporaire, jamais dans les données personnelles du dépôt.
 */

const sent: { title: string; body?: string; tag?: string }[] = [];

vi.mock("./push", () => ({
  sendToAll: async (payload: { title: string; body?: string; tag?: string }) => {
    sent.push(payload);
    return 1;
  },
}));

function event(over: Partial<EventItem>): EventItem {
  return {
    id: "ev",
    title: "Événement",
    start: "2026-09-08T09:00:00",
    end: "2026-09-08T10:00:00",
    createdAt: "2026-09-01T10:00:00",
    updatedAt: "2026-09-01T10:00:00",
    ...over,
  };
}

const events: EventItem[] = [
  event({
    id: "ev1",
    title: "Cours de statistiques",
    start: "2026-09-08T09:00:00",
    end: "2026-09-08T12:00:00",
    location: "Bâtiment 307",
  }),
  // Rappel personnalisé : préviens-moi 1 h avant.
  event({
    id: "ev2",
    title: "Natation",
    start: "2026-09-08T09:30:00",
    end: "2026-09-08T10:30:00",
    reminderMin: 60,
  }),
  // Jamais notifié avant son dernier appel (serveur arrêté entre-temps).
  event({
    id: "ev3",
    title: "Delos",
    start: "2026-09-08T14:00:00",
    end: "2026-09-08T17:00:00",
  }),
];

vi.mock("./store", () => ({ listEvents: async () => events }));

process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), "agenda-reminders-")));
const { runReminders } = await import("./reminders");

/** Passage à l'instant donné → uniquement les envois de ce passage. */
async function at(iso: string) {
  const before = sent.length;
  await runReminders(new Date(iso));
  return sent.slice(before);
}

describe("runReminders", () => {
  it("envoie le préavis puis le dernier appel, sans doublon", async () => {
    // 08:20 — trop tôt pour tout le monde (Natation ouvre sa fenêtre à 08:30).
    expect(await at("2026-09-08T08:20:00")).toEqual([]);

    // 08:31 — préavis personnalisé de Natation (60 min).
    expect((await at("2026-09-08T08:31:00")).map((e) => e.tag)).toEqual(["ev2#60"]);

    // 08:41 — préavis de préparation du cours (20 min).
    expect(await at("2026-09-08T08:41:00")).toEqual([
      {
        title: "Cours de statistiques",
        body: "Dans 19 min · 09:00 · Bâtiment 307",
        url: "/",
        tag: "ev1#20",
      },
    ]);

    // 08:50 — rien de neuf : aucun préavis échu qui n'ait déjà été envoyé.
    expect(await at("2026-09-08T08:50:00")).toEqual([]);

    // 08:59:20 — dernier appel du cours, avec son propre tag pour sonner.
    expect(await at("2026-09-08T08:59:20")).toEqual([
      {
        title: "Cours de statistiques",
        body: "Dans 1 min · 09:00 · Bâtiment 307",
        url: "/",
        tag: "ev1#1",
      },
    ]);

    // 08:59:50 — déjà notifié : on ne répète pas.
    expect(await at("2026-09-08T08:59:50")).toEqual([]);

    // 09:29:30 — Natation garde son dernier appel malgré son rappel perso.
    expect((await at("2026-09-08T09:29:30")).map((e) => e.tag)).toEqual(["ev2#1"]);

    // 09:31 — les deux événements ont commencé : plus rien à envoyer.
    expect(await at("2026-09-08T09:31:00")).toEqual([]);
  });

  it("n'enchaîne pas deux notifications quand les préavis sont dépassés ensemble", async () => {
    // Serveur redémarré 30 s avant le début : les deux préavis sont échus
    // d'un coup, seul le dernier appel part…
    expect((await at("2026-09-08T13:59:30")).map((e) => e.tag)).toEqual(["ev3#1"]);
    // … et le préavis dépassé ne partira pas au passage suivant.
    expect(await at("2026-09-08T13:59:50")).toEqual([]);
  });
});
