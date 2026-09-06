import { describe, expect, it } from "vitest";
import { testConfig as cfg } from "./__fixtures__/testConfig";
import { checkWeekPlan } from "./guardrails";
import type { FixedItem, PlanSession, RuleId } from "./types";

/** Semaine de test : lundi 2026-07-20 → dimanche 2026-07-26. */
const D = {
  lundi: "2026-07-20",
  mardi: "2026-07-21",
  mercredi: "2026-07-22",
  jeudi: "2026-07-23",
  vendredi: "2026-07-24",
  samedi: "2026-07-25",
  dimanche: "2026-07-26",
};

let seq = 0;
function s(
  day: string,
  start: string,
  end: string,
  category: PlanSession["category"],
  extra: Partial<PlanSession> = {}
): PlanSession {
  seq++;
  return {
    id: `s${seq}`,
    title: extra.title || `${category} ${seq}`,
    category,
    start: `${day}T${start}:00`,
    end: `${day}T${end}:00`,
    ...extra,
  };
}

function fx(day: string, start: string, end: string, placeId?: string): FixedItem {
  seq++;
  return {
    id: `f${seq}`,
    title: `Cours ${seq}`,
    start: `${day}T${start}:00`,
    end: `${day}T${end}:00`,
    placeId,
  };
}

function rules(sessions: PlanSession[], fixed: FixedItem[] = []): RuleId[] {
  return checkWeekPlan(cfg, sessions, fixed).map((v) => v.rule);
}

/**
 * Une semaine VALIDE de référence : 3 demi-journées Delos (jours Paris),
 * 20h de Monumia, 3 séances de sport espacées, 2 sorties Marine, déjeuners
 * préservés, pas de trous. Chaque test de violation part d'une déviation.
 */
function validWeek(): { sessions: PlanSession[]; fixed: FixedItem[] } {
  const fixed = [
    fx(D.mardi, "09:00", "12:00", "fac"),
    fx(D.vendredi, "09:00", "12:00", "fac"),
  ];
  const sessions = [
    // Lundi : journée Paris — Delos matin + après-midi (2 demi-journées).
    s(D.lundi, "09:00", "13:00", "delos", { placeId: "delos", title: "Delos matin" }),
    s(D.lundi, "14:00", "18:00", "delos", { placeId: "delos", title: "Delos aprem" }),
    // Mardi : cours le matin (fixe), Monumia à la bibli l'après-midi, salle le soir.
    s(D.mardi, "14:00", "18:00", "monumia", { placeId: "bibli" }),
    s(D.mardi, "18:30", "19:45", "sport", { placeId: "salle", activityId: "salle", title: "Salle" }),
    // Mercredi : journée Paris — Delos matin, Monumia à la maison, retour Orsay le soir.
    s(D.mercredi, "09:00", "13:00", "delos", { placeId: "delos", title: "Delos matin" }),
    s(D.mercredi, "14:00", "18:00", "monumia", { placeId: "maison" }),
    s(D.mercredi, "20:00", "22:30", "sortie", { placeId: "chez-marine" as string, title: "Soirée Marine" }),
    // Jeudi : Monumia + natation (créneau imposé 18h-19h).
    s(D.jeudi, "09:00", "12:00", "monumia", { placeId: "bibli" }),
    s(D.jeudi, "13:00", "17:30", "monumia", { placeId: "bibli" }),
    s(D.jeudi, "18:00", "19:00", "sport", { placeId: "piscine", activityId: "natation", title: "Natation" }),
    // Vendredi : cours le matin (fixe), Monumia l'après-midi.
    s(D.vendredi, "13:30", "18:00", "monumia", { placeId: "bibli" }),
    // Samedi (week-end : rien avant 10h) : course, Monumia avec déjeuner
    // préservé, après-midi libre puis sortie le soir.
    s(D.samedi, "10:00", "10:45", "sport", { activityId: "course", title: "Course" }),
    s(D.samedi, "11:00", "13:30", "monumia", { placeId: "bibli" }),
    s(D.samedi, "14:30", "16:00", "monumia", { placeId: "bibli" }),
    s(D.samedi, "20:00", "23:00", "sortie", { title: "Sortie Marine" }),
  ];
  // chez-marine n'existe pas dans la config de test → placeId inconnu toléré
  // (travelMinutes renvoie null, les règles de lieu passent leur tour).
  return { sessions, fixed };
}

describe("guardrails — semaine valide", () => {
  it("ne lève aucune erreur (les warns tolérés : aucun ici)", () => {
    const { sessions, fixed } = validWeek();
    const violations = checkWeekPlan(cfg, sessions, fixed);
    expect(violations).toEqual([]);
  });
});

describe("overlaps", () => {
  it("détecte un chevauchement avec un événement fixe", () => {
    const { sessions, fixed } = validWeek();
    sessions.push(s(D.mardi, "10:00", "11:00", "monumia", { placeId: "bibli" }));
    expect(rules(sessions, fixed)).toContain("overlap-fixed");
  });

  it("détecte un chevauchement entre deux sessions", () => {
    const { sessions, fixed } = validWeek();
    sessions.push(s(D.jeudi, "10:00", "11:00", "monumia", { placeId: "bibli" }));
    expect(rules(sessions, fixed)).toContain("overlap-internal");
  });
});

describe("trajets & clusters", () => {
  it("refuse un enchaînement Paris→Orsay sans le temps de trajet", () => {
    const { sessions, fixed } = validWeek();
    // Delos finit à 13h à Paris, salle à 13:30 à Orsay : impossible (≥35 min voiture).
    sessions.push(
      s(D.lundi, "13:30", "14:00", "sport", { placeId: "salle", activityId: "course" })
    );
    expect(rules(sessions, fixed)).toContain("travel-time");
  });

  it("vers Delos, la voiture interdite impose 70 min de transports", () => {
    // Bibli (Orsay) 9h-12h puis Delos à 12:50 : 50 min suffiraient en voiture,
    // mais la voiture est interdite à Delos → transports 70 min → violation.
    const sessions = [
      s(D.lundi, "09:00", "12:00", "monumia", { placeId: "bibli" }),
      s(D.lundi, "12:50", "16:50", "delos", { placeId: "delos" }),
    ];
    const found = checkWeekPlan(cfg, sessions, []).filter((v) => v.rule === "travel-time");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("70");
  });

  it("pas de voiture AU DÉPART de Delos non plus : 70 min pour en repartir", () => {
    // Delos 14h-18h puis bibli (Orsay) à 19h : 60 min suffiraient en voiture,
    // mais la voiture n'est pas à Delos → transports 70 min → violation.
    const sessions = [
      s(D.lundi, "14:00", "18:00", "delos", { placeId: "delos" }),
      s(D.lundi, "19:00", "20:00", "monumia", { placeId: "bibli" }),
    ];
    const found = checkWeekPlan(cfg, sessions, []).filter((v) => v.rule === "travel-time");
    expect(found).toHaveLength(1);
  });

  it("à travers un bloc sans lieu : seul l'INTERCALÉ compte, pas le bloc d'arrivée", () => {
    // Cours à la fac jusqu'à 12h, rdv de 15 min sans lieu à 13h, puis un bloc
    // à la maison (Paris) à 13h15 : 75 min de battement pour 35 min de voiture
    // + 15 min de rdv intercalé = 50 min requises → ça passe. L'exigence
    // incluait à tort la durée du bloc d'ARRIVÉE (75 min de plus), ce qui
    // rendait la semaine infaisable dès qu'un rendez-vous court s'intercalait.
    const fixed = [fx(D.lundi, "09:00", "12:00", "fac")];
    const ok = [
      s(D.lundi, "13:00", "13:15", "autre", { title: "Inscription SUAPS" }),
      s(D.lundi, "13:15", "14:15", "repas", { placeId: "maison" }),
    ];
    expect(rules(ok, fixed)).not.toContain("travel-time");

    // Mais un bloc sans lieu qui mange VRAIMENT le temps de route reste fautif :
    // 60 min de course intercalée ne laissent que 15 min pour 35 min de voiture.
    const trop = [
      s(D.lundi, "12:00", "13:00", "sport", { title: "Course" }),
      s(D.lundi, "13:15", "14:15", "repas", { placeId: "maison" }),
    ];
    expect(rules(trop, fixed)).toContain("travel-time");
  });

  it("trajet inter-zones sur le midi : il faut trajet + déjeuner", () => {
    // Delos finit à 13h, cours fixe à la fac (Orsay) à 14h30 : 90 min de pause,
    // mais il faut 70 (transports) + 30 (déjeuner) = 100 → violation.
    const fixed = [fx(D.lundi, "14:30", "17:00", "fac")];
    const tight = [s(D.lundi, "09:00", "13:00", "delos", { placeId: "delos" })];
    expect(rules(tight, fixed)).toContain("travel-time");

    // Avec 14h45 (105 min de pause), ça passe.
    const okFixed = [fx(D.lundi, "14:45", "17:00", "fac")];
    expect(rules(tight, okFixed)).not.toContain("travel-time");
  });

  it("changer de lieu sur le midi, même dans la même zone : trajet + déjeuner", () => {
    // Monumia à la bibli jusqu'à 12h30, cours à la fac à 13h : 30 min de
    // battement = 15 min de trajet + 15 min pour manger → violation.
    const fixed = [fx(D.lundi, "13:00", "17:00", "fac")];
    const tight = [s(D.lundi, "09:00", "12:30", "monumia", { placeId: "bibli" })];
    expect(rules(tight, fixed)).toContain("travel-time");

    // Avec le cours à 13h15 (45 min = 15 trajet + 30 déjeuner), ça passe.
    const okFixed = [fx(D.lundi, "13:15", "17:00", "fac")];
    expect(rules(tight, okFixed)).not.toContain("travel-time");
  });

  it("après le sport : 15 min de transition (douche) en plus du trajet", () => {
    // Salle finit à 18h15, Monumia à la bibli à 18h30 : 15 min = le trajet
    // seul, sans la douche → violation.
    const base = [
      s(D.lundi, "17:00", "18:15", "sport", { placeId: "salle", activityId: "salle" }),
      s(D.lundi, "18:30", "20:30", "monumia", { placeId: "bibli" }),
    ];
    expect(rules(base, [])).toContain("travel-time");

    // À 18h45 (30 min = 15 trajet + 15 douche), ça passe.
    const ok = [
      s(D.lundi, "17:00", "18:15", "sport", { placeId: "salle", activityId: "salle" }),
      s(D.lundi, "18:45", "20:45", "monumia", { placeId: "bibli" }),
    ];
    expect(rules(ok, [])).not.toContain("travel-time");
  });

  it("refuse le ping-pong Paris→Orsay→Paris dans la journée", () => {
    const sessions = [
      s(D.lundi, "09:00", "11:00", "delos", { placeId: "delos" }),
      s(D.lundi, "13:00", "15:00", "monumia", { placeId: "bibli" }),
      s(D.lundi, "17:00", "19:00", "monumia", { placeId: "maison" }),
    ];
    expect(rules(sessions, [])).toContain("cluster-pingpong");
  });
});

describe("bornes horaires", () => {
  it("refuse une session avant 8h", () => {
    const { sessions, fixed } = validWeek();
    sessions.push(s(D.mercredi, "07:00", "08:00", "sport", { activityId: "course" }));
    expect(rules(sessions, fixed)).toContain("bounds-start");
  });

  it("le week-end, rien avant 10h (fini la course à 8h le dimanche)", () => {
    const { sessions, fixed } = validWeek();
    sessions.push(s(D.dimanche, "08:30", "09:15", "sport", { activityId: "course" }));
    const found = checkWeekPlan(cfg, sessions, fixed).filter((v) => v.rule === "bounds-start");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("week-end");
    // La même heure un mercredi passe sans problème.
    const { sessions: s2, fixed: f2 } = validWeek();
    s2.push(s(D.mercredi, "08:30", "09:15", "sport", { activityId: "course" }));
    expect(rules(s2, f2)).not.toContain("bounds-start");
  });

  it("refuse du travail après 22h non marqué exceptionnel", () => {
    const { sessions, fixed } = validWeek();
    sessions.push(s(D.dimanche, "20:00", "22:30", "monumia", { placeId: "chambre" }));
    expect(rules(sessions, fixed)).toContain("bounds-end");
  });

  it("accepte du travail jusqu'à minuit si exceptionnel, dans la limite hebdo", () => {
    const { sessions, fixed } = validWeek();
    sessions.push(
      s(D.dimanche, "20:00", "23:30", "monumia", { placeId: "chambre", exceptional: true })
    );
    const r = rules(sessions, fixed);
    expect(r).not.toContain("bounds-end");
    expect(r).not.toContain("bounds-exceptional-count");
  });

  it("refuse plus de maxExceptionalPerWeek sessions tardives", () => {
    const { sessions, fixed } = validWeek();
    for (const day of [D.dimanche, D.lundi, D.mardi]) {
      sessions.push(
        s(day, "22:30", "23:30", "monumia", { placeId: "chambre", exceptional: true })
      );
    }
    expect(rules(sessions, fixed)).toContain("bounds-exceptional-count");
  });

  it("laisse une sortie finir après 22h sans rien signaler", () => {
    const { sessions, fixed } = validWeek();
    // La sortie du samedi finit déjà à 23h — la semaine valide passe sans bounds-end.
    expect(rules(sessions, fixed)).not.toContain("bounds-end");
  });
});

describe("pause déjeuner", () => {
  it("refuse une journée sans 30 min pour manger le midi", () => {
    const { sessions, fixed } = validWeek();
    // Jeudi : Monumia 9h-12h existe déjà ; on remplace le bloc 13h-17h30 par 12h-17h30.
    const jeudi = sessions.find((x) => x.start === `${D.jeudi}T13:00:00`)!;
    jeudi.start = `${D.jeudi}T12:00:00`;
    expect(rules(sessions, fixed)).toContain("lunch-break");
  });

  it("accepte une journée dont les activités laissent la fenêtre déjeuner ouverte", () => {
    const { sessions, fixed } = validWeek();
    expect(rules(sessions, fixed)).not.toContain("lunch-break");
  });
});

describe("trous", () => {
  it("signale un trou > 60 min entre deux blocs de travail (hors déjeuner et trajet)", () => {
    const sessions = [
      s(D.lundi, "09:00", "10:00", "monumia", { placeId: "bibli" }),
      s(D.lundi, "11:30", "12:30", "monumia", { placeId: "bibli" }),
    ];
    const found = checkWeekPlan(cfg, sessions, []).filter((v) => v.rule === "big-hole");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warn");
  });

  it("ne compte pas le temps libre avant une sortie comme un trou", () => {
    const sessions = [
      s(D.samedi, "09:00", "12:00", "monumia", { placeId: "bibli" }),
      s(D.samedi, "20:00", "23:00", "sortie", { title: "Soirée" }),
    ];
    expect(rules(sessions, [])).not.toContain("big-hole");
  });

  it("ne compte ni le trajet ni la pause déjeuner comme du trou", () => {
    // Delos 9h-13h (Paris) puis bibli 15h25 (Orsay) : 145 min de trou brut,
    // mais 35 min de trajet + 60 min de crédit déjeuner → 50 min effectives.
    const sessions = [
      s(D.lundi, "09:00", "13:00", "delos", { placeId: "delos" }),
      s(D.lundi, "15:25", "18:00", "monumia", { placeId: "bibli" }),
    ];
    expect(rules(sessions, [])).not.toContain("big-hole");
  });
});

describe("blocs de travail", () => {
  it("refuse un bloc de travail < 90 min (l'heure orpheline de Monumia)", () => {
    const { sessions, fixed } = validWeek();
    sessions.push(s(D.dimanche, "11:00", "12:00", "monumia", { placeId: "bibli" }));
    const found = checkWeekPlan(cfg, sessions, fixed).filter(
      (v) => v.rule === "work-min-block"
    );
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
  });

  it("accepte un bloc de 90 min pile (samedi de la semaine valide)", () => {
    const { sessions, fixed } = validWeek();
    expect(rules(sessions, fixed)).not.toContain("work-min-block");
  });
});

describe("blocs coupés & lieux manquants", () => {
  it("refuse un mini-trou entre deux blocs identiques au même endroit", () => {
    // Le cas réel : Monumia 12h45-15h45 puis re-Monumia 45 min après.
    const sessions = [
      s(D.lundi, "12:45", "15:45", "monumia", { placeId: "bibli" }),
      s(D.lundi, "16:30", "18:00", "monumia", { placeId: "bibli" }),
    ];
    expect(rules(sessions, [])).toContain("work-split");
  });

  it("laisse passer le trou qui sert de pause déjeuner", () => {
    const sessions = [
      s(D.lundi, "10:00", "13:00", "monumia", { placeId: "bibli" }),
      s(D.lundi, "14:00", "16:00", "monumia", { placeId: "bibli" }),
    ];
    expect(rules(sessions, [])).not.toContain("work-split");
  });

  it("refuse un bloc Monumia sans lieu (trajets invérifiables)", () => {
    const { sessions, fixed } = validWeek();
    sessions.push(s(D.dimanche, "10:30", "12:30", "monumia", {}));
    expect(rules(sessions, fixed)).toContain("missing-place");
  });

  it("refuse une séance de sport sans lieu quand l'activité en a un", () => {
    const sessions = [
      s(D.lundi, "18:00", "19:15", "sport", { activityId: "salle", title: "Salle" }),
    ];
    expect(rules(sessions, [])).toContain("missing-place");
    // La course à pied (aucun lieu défini) reste libre.
    const course = [
      s(D.lundi, "18:00", "18:45", "sport", { activityId: "course", title: "Course" }),
    ];
    expect(rules(course, [])).not.toContain("missing-place");
  });
});

describe("sorties demandées", () => {
  it("une sortie demandée absente du planning = erreur, même sans conflit", () => {
    const { sessions, fixed } = validWeek();
    const violations = checkWeekPlan(cfg, sessions, fixed, {
      requestedSorties: [{ label: "Soirée avec Tristan", day: D.jeudi }],
    });
    const found = violations.filter((v) => v.rule === "sortie-manquante");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
  });

  it("satisfaite dès qu'une sortie existe le jour demandé", () => {
    const { sessions, fixed } = validWeek();
    sessions.push(
      s(D.jeudi, "19:30", "23:00", "sortie", { title: "Soirée avec Tristan à Paris" })
    );
    const violations = checkWeekPlan(cfg, sessions, fixed, {
      requestedSorties: [{ label: "Soirée avec Tristan", day: D.jeudi }],
    });
    expect(violations.map((v) => v.rule)).not.toContain("sortie-manquante");
  });
});

describe("quotas travail", () => {
  it("réclame les demi-journées Delos manquantes", () => {
    const { sessions, fixed } = validWeek();
    const kept = sessions.filter((x) => x.title !== "Delos aprem");
    const found = checkWeekPlan(cfg, kept, fixed).filter((v) => v.rule === "delos-quota");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
  });

  it("refuse une demi-journée Delos hors gabarit (les créneaux, c'est 9-13 ou 14-18)", () => {
    const { sessions, fixed } = validWeek();
    const aprem = sessions.find((x) => x.title === "Delos aprem")!;
    aprem.start = `${D.lundi}T15:00:00`;
    aprem.end = `${D.lundi}T19:00:00`;
    const found = checkWeekPlan(cfg, sessions, fixed).filter(
      (v) => v.rule === "delos-window"
    );
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
  });

  it("tolère (warn) la 3e demi-journée coupée en 2×2h dans les gabarits", () => {
    const { sessions, fixed } = validWeek();
    // Remplace le Delos aprem du lundi par deux fractions de 2h dans le gabarit.
    const aprem = sessions.find((x) => x.title === "Delos aprem")!;
    aprem.start = `${D.lundi}T14:00:00`;
    aprem.end = `${D.lundi}T16:00:00`;
    sessions.push(
      s(D.lundi, "16:00", "18:00", "delos", { placeId: "delos", title: "Delos fin" })
    );
    const violations = checkWeekPlan(cfg, sessions, fixed);
    // Le quota en heures est atteint (12h) : pas d'erreur, juste des warns.
    expect(violations.filter((v) => v.severity === "error")).toEqual([]);
    const frac = violations.filter((v) => v.rule === "delos-window");
    expect(frac.length).toBeGreaterThan(0);
    expect(frac.every((v) => v.severity === "warn")).toBe(true);
  });

  it("réclame le plancher Monumia", () => {
    const { sessions, fixed } = validWeek();
    const kept = sessions.filter(
      (x) => !(x.category === "monumia" && x.start.startsWith(D.jeudi))
    );
    expect(rules(kept, fixed)).toContain("monumia-min");
  });

  it("refuse de dépasser le plafond hebdo de Monumia (les 36h, plus jamais)", () => {
    const { sessions, fixed } = validWeek();
    // +8h de Monumia le dimanche : 23,5h + 8h = 31,5h > plafond 30h.
    sessions.push(s(D.dimanche, "10:00", "13:00", "monumia", { placeId: "bibli" }));
    sessions.push(s(D.dimanche, "14:00", "19:00", "monumia", { placeId: "bibli" }));
    const found = checkWeekPlan(cfg, sessions, fixed).filter((v) => v.rule === "monumia-max");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
  });

  it("refuse plus de maxHoursPerDay de Monumia sur une journée", () => {
    const { sessions, fixed } = validWeek();
    sessions.push(s(D.dimanche, "08:00", "12:00", "monumia", { placeId: "chambre" }));
    sessions.push(s(D.dimanche, "14:00", "19:30", "monumia", { placeId: "chambre" }));
    expect(rules(sessions, fixed)).toContain("monumia-daily-max");
  });
});

describe("sport", () => {
  it("signale (warn) trop peu de séances", () => {
    const { sessions, fixed } = validWeek();
    const kept = sessions.filter((x) => x.category !== "sport");
    const found = checkWeekPlan(cfg, kept, fixed).filter((v) => v.rule === "sport-quota");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warn");
  });

  it("refuse deux séances de la même activité sans la récup minimale", () => {
    const { sessions, fixed } = validWeek();
    // Salle mardi 18h30 existe → une autre salle mercredi matin (< 48h de repos).
    sessions.push(
      s(D.mercredi, "10:00", "11:15", "sport", { placeId: "salle", activityId: "salle" })
    );
    expect(rules(sessions, fixed)).toContain("sport-recovery");
  });

  it("refuse une séance hors heures d'ouverture", () => {
    const { sessions, fixed } = validWeek();
    const natation = sessions.find((x) => x.title === "Natation")!;
    natation.start = `${D.jeudi}T19:30:00`;
    natation.end = `${D.jeudi}T20:30:00`; // piscine ferme à 20h
    expect(rules(sessions, fixed)).toContain("sport-opening-hours");
  });

  it("impose le créneau fixe de la natation", () => {
    const { sessions, fixed } = validWeek();
    const natation = sessions.find((x) => x.title === "Natation")!;
    natation.start = `${D.mardi}T18:00:00`; // mauvais jour
    natation.end = `${D.mardi}T19:00:00`;
    expect(rules(sessions, fixed)).toContain("sport-fixed-slot");
  });
});

describe("sorties", () => {
  it("rappelle (warn) les sorties Marine manquantes, sans les imposer", () => {
    const { sessions, fixed } = validWeek();
    const kept = sessions.filter((x) => x.category !== "sortie");
    const found = checkWeekPlan(cfg, kept, fixed).filter((v) => v.rule === "sorties-quota");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warn");
    expect(found[0].message).toContain("rien n'est ajouté automatiquement");
  });
});
