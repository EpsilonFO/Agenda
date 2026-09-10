import { describe, expect, it } from "vitest";
import { applyPending, enqueueOp, newOp, remapOps, type PendingOp } from "./offline";
import type { EventItem } from "./types";

/**
 * Logique de la file d'attente hors ligne (lib/offline.ts).
 * On teste les fonctions pures : pas de localStorage ni de fetch ici.
 */

function event(over: Partial<EventItem> = {}): EventItem {
  return {
    id: "srv-1",
    title: "Point équipe",
    start: "2026-09-10T09:00:00",
    end: "2026-09-10T10:00:00",
    category: "travail",
    color: "#6366f1",
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-01T08:00:00.000Z",
    ...over,
  };
}

const CREATE = {
  title: "Salle",
  start: "2026-09-11T18:00:00",
  end: "2026-09-11T19:30:00",
  category: "sport",
};

describe("enqueueOp", () => {
  it("fusionne deux déplacements successifs du même événement", () => {
    let ops: PendingOp[] = [];
    ops = enqueueOp(ops, newOp("update", "srv-1", { start: "2026-09-10T11:00:00" }));
    ops = enqueueOp(ops, newOp("update", "srv-1", { start: "2026-09-10T14:00:00" }));
    expect(ops).toHaveLength(1);
    expect(ops[0].payload?.start).toBe("2026-09-10T14:00:00");
  });

  it("absorbe la retouche d'un événement encore en attente de création", () => {
    let ops: PendingOp[] = [];
    ops = enqueueOp(ops, newOp("create", "local-1", CREATE));
    ops = enqueueOp(ops, newOp("update", "local-1", { title: "Salle + sauna" }));
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("create");
    expect(ops[0].payload?.title).toBe("Salle + sauna");
    expect(ops[0].payload?.start).toBe(CREATE.start);
  });

  it("ne fusionne pas par-dessus une écriture intercalée sur un autre événement", () => {
    let ops: PendingOp[] = [];
    ops = enqueueOp(ops, newOp("update", "srv-1", { title: "A" }));
    ops = enqueueOp(ops, newOp("update", "srv-2", { title: "B" }));
    ops = enqueueOp(ops, newOp("update", "srv-1", { title: "C" }));
    expect(ops.map((o) => o.eventId)).toEqual(["srv-1", "srv-2", "srv-1"]);
  });

  it("annule tout quand on supprime un événement jamais parti", () => {
    let ops: PendingOp[] = [];
    ops = enqueueOp(ops, newOp("create", "local-1", CREATE));
    ops = enqueueOp(ops, newOp("update", "local-1", { title: "Autre" }));
    ops = enqueueOp(ops, newOp("delete", "local-1"));
    expect(ops).toEqual([]);
  });

  it("remplace les retouches en attente par la suppression d'un événement du serveur", () => {
    let ops: PendingOp[] = [];
    ops = enqueueOp(ops, newOp("update", "srv-1", { title: "Autre" }));
    ops = enqueueOp(ops, newOp("delete", "srv-1"));
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("delete");
  });
});

describe("applyPending", () => {
  it("affiche un événement créé hors ligne, coloré par sa catégorie", () => {
    const out = applyPending([], [newOp("create", "local-1", CREATE)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "local-1",
      title: "Salle",
      category: "sport",
      color: "#f59e0b",
      pendingSync: true,
    });
  });

  it("ignore une création incomplète (l'API la refuserait)", () => {
    const out = applyPending([], [newOp("create", "local-1", { title: "Sans horaire" })]);
    expect(out).toEqual([]);
  });

  it("applique un déplacement par-dessus l'instantané serveur", () => {
    const out = applyPending(
      [event()],
      [newOp("update", "srv-1", { start: "2026-09-10T15:00:00", end: "2026-09-10T16:00:00" })]
    );
    expect(out[0].start).toBe("2026-09-10T15:00:00");
    expect(out[0].pendingSync).toBe(true);
  });

  it("recolore quand la catégorie change", () => {
    const out = applyPending([event()], [newOp("update", "srv-1", { category: "sport" })]);
    expect(out[0].color).toBe("#f59e0b");
  });

  it("masque un événement supprimé hors ligne", () => {
    const out = applyPending([event()], [newOp("delete", "srv-1")]);
    expect(out).toEqual([]);
  });

  it("ignore la retouche d'un événement disparu du serveur", () => {
    const out = applyPending([event()], [newOp("update", "srv-inconnu", { title: "X" })]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Point équipe");
  });

  it("rend la liste triée par début", () => {
    const out = applyPending(
      [event({ id: "srv-1", start: "2026-09-12T09:00:00", end: "2026-09-12T10:00:00" })],
      [newOp("create", "local-1", CREATE)]
    );
    expect(out.map((e) => e.id)).toEqual(["local-1", "srv-1"]);
  });

  it("transforme les emails saisis en invités affichables", () => {
    const out = applyPending(
      [],
      [newOp("create", "local-1", { ...CREATE, attendees: ["a@x.fr"] })]
    );
    expect(out[0].attendees).toEqual([{ email: "a@x.fr" }]);
  });
});

describe("remapOps", () => {
  it("rebaptise l'id provisoire une fois la création acceptée par le serveur", () => {
    const ops = [newOp("update", "local-1", { title: "X" }), newOp("delete", "srv-9")];
    const out = remapOps(ops, "local-1", "srv-42");
    expect(out[0].eventId).toBe("srv-42");
    expect(out[1].eventId).toBe("srv-9");
  });
});
