/**
 * Les CONTRATS du planificateur v5 : le LLM ne fait plus que REMPLIR ces JSON,
 * validés par zod. Une sortie invalide déclenche un retry (voir llm.ts) —
 * jamais de parse silencieux.
 *
 * - WeekInput : la demande hebdomadaire STRUCTURÉE (imprévus, sorties datées,
 *   indisponibilités, surcharge sport, exceptions aux quotas). Le greffier du
 *   chat la construit depuis la conversation ; le solveur déterministe fait
 *   tout le reste.
 * - RetouchOp / JosianeRetouchOut : les opérations minimales de retouche d'un
 *   plan en place (par id de session), re-validées par les guardrails.
 */

import { z } from "zod";
import { IsoDateSchema } from "./config";

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "format HH:MM attendu");

/**
 * Catégorie de session, tolérante aux libellés naturels du modèle de retouche :
 * « déjeuner »/« repas » → repas, « cours » → autre, « travail » → monumia.
 */
const SessionCategorySchema = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const n = v
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
  if (["delos", "monumia", "sport", "sortie", "autre", "repas", "trajet"].includes(n))
    return n;
  if (n.includes("trajet") || n.includes("deplacement")) return "trajet";
  if (n.includes("dej") || n.includes("repas") || n.includes("lunch") || n.includes("diner"))
    return "repas";
  if (n.includes("cours") || n.includes("class")) return "autre";
  if (n.includes("travail") || n === "work") return "monumia";
  if (n.includes("loisir") || n.includes("perso") || n.includes("soiree")) return "sortie";
  return n;
  // "trajet" est produit par le solveur (blocs inter-zones) : le contrat doit
  // l'accepter, sinon une retouche portant sur un trajet est rejetée.
}, z.enum(["delos", "monumia", "sport", "sortie", "autre", "repas", "trajet"]));

/* ------------------------- Décisions qualitatives -------------------- */

/**
 * Les CHOIX QUALITATIFS qu'on peut imposer au solveur : quels jours Delos,
 * jour + moment d'une séance de sport, soir d'une sortie sans date. Tout le
 * reste (déjeuner, Monumia, trajets) reste mécanique. Chaque décision est
 * validée par le solveur ; infaisable → rejetée AVEC sa raison (remontée dans
 * les warnings) et repli sur l'heuristique seedée. C'est la seule voie pour
 * dire « Delos mardi et jeudi » ou « muscu jeudi soir » — le greffier la
 * remplit depuis les mots de l'utilisateur, jamais de lui-même.
 */
export const DelosDecisionSchema = z.object({
  /** Jour (YYYY-MM-DD) où poser du Delos. */
  date: IsoDateSchema,
  /** journee = 2 gabarits (journée Paris) ; matin/apres-midi = un seul. */
  gabarit: z.enum(["journee", "matin", "apres-midi"]).default("journee"),
  /**
   * presentiel (défaut) = demi-journée sur place ; distance = un bloc d'heures
   * Delos à distance ce jour-là. Sans ça, une semaine tout-distanciel n'avait
   * AUCUN moyen d'être pilotée : le solveur retirait les jours au hasard à
   * chaque replanification (vécu : « Delos vendredi → mercredi » déplaçait
   * aussi celui du jeudi).
   */
  modalite: z.enum(["presentiel", "distance"]).optional(),
});
export type DelosDecision = z.infer<typeof DelosDecisionSchema>;

export const SportDecisionSchema = z.object({
  /** id d'activité de la config. */
  activityId: z.string().min(1),
  date: IsoDateSchema,
  /**
   * midi = au creux de midi, collée au dernier bloc du matin, déjeuner juste
   * après — « avant de manger », « entre le cours et le déjeuner ». Sans cette
   * valeur, « natation avant de manger » n'avait pas de traduction et finissait
   * en fin d'après-midi (vécu).
   */
  moment: z.enum(["matin", "midi", "fin-apres-midi"]).default("fin-apres-midi"),
});
export type SportDecision = z.infer<typeof SportDecisionSchema>;

export const SortieDecisionSchema = z.object({
  /** label EXACT de la sortie demandée (sortiesDatees) sans jour. */
  label: z.string().min(1),
  date: IsoDateSchema,
  start: HHMM.optional(),
});
export type SortieDecision = z.infer<typeof SortieDecisionSchema>;

export const SolverDecisionsSchema = z.object({
  delos: z.array(DelosDecisionSchema).default([]),
  sport: z.array(SportDecisionSchema).default([]),
  sorties: z.array(SortieDecisionSchema).default([]),
});
export type SolverDecisions = z.infer<typeof SolverDecisionsSchema>;

const EMPTY_DECISIONS: SolverDecisions = { delos: [], sport: [], sorties: [] };

/* --------------------------- Demande hebdo --------------------------- */

export const WeekInputSchema = z.object({
  /** Lundi de la semaine visée, YYYY-MM-DD. */
  weekStart: IsoDateSchema,
  /** Reste de la demande en texte libre (contexte, humeur, précisions). */
  notes: z.string().default(""),
  /** TP, projets, urgences de la semaine — l'ex-système de deadlines. */
  imprevus: z
    .array(
      z.object({
        label: z.string().min(1),
        hoursNeeded: z.number().positive().optional(),
        deadline: IsoDateSchema.optional(),
        note: z.string().optional(),
      })
    )
    .default([]),
  /** Sorties déjà connues (dîner vendredi, soirée amis samedi…). */
  sortiesDatees: z
    .array(
      z.object({
        label: z.string().min(1),
        withWhom: z.enum(["marine", "amis", "autre"]).default("autre"),
        /**
         * Zone de la sortie (id de cluster : paris, orsay…). ESSENTIELLE pour
         * les trajets : sans elle, une sortie « autre » n'ancre rien et le
         * déplacement autour d'elle n'est ni exigé ni affiché. Marine/amis ont
         * une zone habituelle en config ; « autre » sans zone reste libre.
         */
        zone: z.string().optional(),
        day: IsoDateSchema.optional(),
        start: HHMM.optional(),
        end: HHMM.optional(),
        note: z.string().optional(),
      })
    )
    .default([]),
  /**
   * RENDEZ-VOUS à heure FIXE de la semaine : inscription, rdv médecin, appel,
   * réunion… Ce ne sont ni des imprévus (des HEURES de travail à caser avant
   * une échéance, que le solveur place où il veut) ni des sorties (le soir, et
   * comptées dans les quotas de vie perso) : ce sont des blocs posés à l'heure
   * dite, ni négociés ni déplacés. Sans ce champ, le greffier n'avait d'autre
   * choix que de les faire passer pour des imprévus — vécu : « inscription
   * SUAPS mercredi 13h, 15 min » posée le lundi en bloc d'1h30.
   */
  engagements: z
    .array(
      z.object({
        label: z.string().min(1),
        day: IsoDateSchema,
        start: HHMM,
        /** Fin explicite ; sinon start + durationMin. */
        end: HHMM.optional(),
        /** Durée en minutes si `end` est absent (défaut 30). */
        durationMin: z.number().int().positive().max(600).optional(),
        /** Zone (id de cluster) quand le rdv est ailleurs que la zone du jour. */
        zone: z.string().optional(),
        note: z.string().optional(),
      })
    )
    .default([]),
  /** Plages où RIEN ne doit être posé (week-end chez les parents, absence…). */
  indisponibilites: z
    .array(
      z.object({
        day: IsoDateSchema,
        from: HHMM.optional(),
        to: HHMM.optional(),
        reason: z.string().optional(),
      })
    )
    .default([]),
  /** Voiture disponible cette semaine. */
  voitureDispo: z.boolean().default(true),
  /**
   * Surcharge hebdo du sport (v5) : par défaut le solveur suit la rotation de
   * la config (perWeek par activité). Ici on peut écarter une activité cette
   * semaine (« pas de natation ») ou en imposer (« 2 courses », escalade —
   * seule voie pour placer une activité « optionnel »). Un activityId inconnu
   * de la config n'est PAS une erreur de schéma : le solveur l'ignore avec un
   * warning (le greffier LLM peut se tromper, ça ne bloque pas la semaine).
   */
  sport: z
    .object({
      exclure: z.array(z.string()).default([]),
      imposer: z
        .array(
          z.object({
            activityId: z.string().min(1),
            fois: z.number().int().min(1).max(4).default(1),
          })
        )
        .default([]),
    })
    .default({ exclure: [], imposer: [] }),
  /** Choix qualitatifs imposés au solveur (voir SolverDecisionsSchema). */
  decisions: SolverDecisionsSchema.default(EMPTY_DECISIONS),
  /**
   * Exceptions ponctuelles aux quotas SOUPLES de la config (ex: Marine absente
   * → sortiesMarineMin 0). Le QUOTA Delos n'est PAS ici : les demi-journées
   * sont une RÈGLE non négociable (le CDD), jamais un volume qu'on ajuste à la
   * semaine — une semaine réellement empêchée passe par les indisponibilités.
   * En revanche le PLACEMENT Delos, lui, se surcharge (regroupement, week-end).
   */
  overrides: z
    .object({
      // Marine peut légitimement tomber à 0 (semaine où elle est absente) —
      // c'est un rappel doux, jamais une obligation vidée.
      sortiesMarineMin: z.number().int().min(0).optional(),
      // Sport et Monumia gardent un plancher : les zéroter était l'hallucination
      // qui vidait la semaine. On peut réduire, pas supprimer.
      sportSessionsMax: z.number().int().min(2).optional(),
      monumiaMinHours: z.number().min(20).optional(),
      // « Semaine légère » : plafonne les cibles Monumia que l'optimiseur
      // explore (jamais sous le plancher de la config).
      monumiaMaxHours: z.number().min(20).optional(),
      // PLACEMENT Delos (le quota reste intouchable) : regrouper ou non les
      // demi-journées sur une même journée ; autoriser le week-end en dernier
      // recours (« semaine impossible autrement »).
      delosGroupHalfDays: z.boolean().optional(),
      delosWeekendOk: z.boolean().optional(),
      // MODALITÉ Delos : combien de demi-journées se font SUR PLACE cette
      // semaine. Le VOLUME total ne bouge pas — ce qui quitte le présentiel
      // rebascule automatiquement en heures à distance (voir applyOverrides).
      // C'est la seule façon de dire « cette semaine je fais tout à distance »
      // sans toucher au CDD.
      delosPresentielHalfDays: z.number().int().min(0).max(6).optional(),
    })
    .default({}),
});
export type WeekInput = z.infer<typeof WeekInputSchema>;

/* ---------------------- Replanification (re-solve) ------------------- */

/**
 * Retouche PAR LE SOLVEUR : au lieu de déplacer des blocs à la main, le LLM
 * traduit la demande en un PATCH de la demande hebdo d'origine (décisions,
 * ajouts/retraits d'imprévus, de sorties, d'indisponibilités, surcharge sport,
 * exceptions) ; la semaine est ENTIÈREMENT re-résolue par le solveur, qui
 * recale déjeuner, Monumia et trajets de façon cohérente. Ne renvoyer que ce
 * qui change : tout le reste de la demande d'origine est conservé.
 */
export const ReplanPatchSchema = z.object({
  decisions: SolverDecisionsSchema.default(EMPTY_DECISIONS),
  imprevusAjoutes: WeekInputSchema.shape.imprevus,
  imprevusSupprimes: z.array(z.string()).default([]),
  sortiesAjoutees: WeekInputSchema.shape.sortiesDatees,
  sortiesSupprimees: z.array(z.string()).default([]),
  indisponibilitesAjoutees: WeekInputSchema.shape.indisponibilites,
  engagementsAjoutes: WeekInputSchema.shape.engagements,
  engagementsSupprimes: z.array(z.string()).default([]),
  sport: WeekInputSchema.shape.sport.optional(),
  overrides: WeekInputSchema.shape.overrides.optional(),
  voitureDispo: z.boolean().optional(),
  notes: z.string().optional(),
  /** Ce que le modèle n'a pas su traduire (remonté à l'utilisateur). */
  warnings: z.array(z.string()).default([]),
});
export type ReplanPatch = z.infer<typeof ReplanPatchSchema>;

function sameLabel(a: string, b: string): boolean {
  const n = (x: string) => x.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
  return n(a) === n(b) || n(a).includes(n(b)) || n(b).includes(n(a));
}

/** Demande d'origine + patch → nouvelle demande (pur). Les décisions du patch
 *  REMPLACENT celles d'origine par famille (delos/sport/sorties) quand elles
 *  sont non vides ; les listes s'ajoutent/retranchent par label. */
export function applyReplanPatch(input: WeekInput, patch: ReplanPatch): WeekInput {
  const next: WeekInput = JSON.parse(JSON.stringify(input));
  next.imprevus = [
    ...next.imprevus.filter((im) => !patch.imprevusSupprimes.some((l) => sameLabel(im.label, l))),
    ...patch.imprevusAjoutes,
  ];
  next.sortiesDatees = [
    ...next.sortiesDatees.filter((so) => !patch.sortiesSupprimees.some((l) => sameLabel(so.label, l))),
    ...patch.sortiesAjoutees,
  ];
  next.indisponibilites = [...next.indisponibilites, ...patch.indisponibilitesAjoutees];
  // Un rendez-vous re-daté (« non, c'était mercredi ») arrive en « ajouté »
  // sans que le modèle pense à supprimer l'ancien : même label = même
  // rendez-vous, la version du patch remplace celle d'origine. Sans ça, la
  // correction produisait un doublon lundi + mercredi.
  next.engagements = [
    ...next.engagements.filter(
      (en) =>
        !patch.engagementsSupprimes.some((l) => sameLabel(en.label, l)) &&
        !patch.engagementsAjoutes.some((a) => sameLabel(a.label, en.label))
    ),
    ...patch.engagementsAjoutes,
  ];
  if (patch.sport) next.sport = patch.sport;
  if (patch.overrides) next.overrides = { ...next.overrides, ...patch.overrides };
  if (patch.voitureDispo !== undefined) next.voitureDispo = patch.voitureDispo;
  if (patch.notes) next.notes = [next.notes, patch.notes].filter(Boolean).join("\n");
  next.decisions = {
    delos: patch.decisions.delos.length ? patch.decisions.delos : next.decisions.delos,
    sport: patch.decisions.sport.length ? patch.decisions.sport : next.decisions.sport,
    sorties: patch.decisions.sorties.length ? patch.decisions.sorties : next.decisions.sorties,
  };
  return WeekInputSchema.parse(next);
}

/* -------------------- Josiane (mode retouche) ------------------------ */

/**
 * Retouche d'un plan déjà en place : Josiane renvoie des OPÉRATIONS minimales
 * ciblant les sessions par ID — jamais un planning complet réécrit.
 */
export const RetouchOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("move"),
    sessionId: z.string().min(1),
    day: IsoDateSchema,
    start: HHMM,
    end: HHMM,
  }),
  z.object({
    op: z.literal("remove"),
    sessionId: z.string().min(1),
  }),
  z.object({
    op: z.literal("add"),
    session: z.object({
      title: z.string().min(1),
      category: SessionCategorySchema,
      activityId: z.string().nullable().default(null),
      placeId: z.string().nullable().default(null),
      day: IsoDateSchema,
      start: HHMM,
      end: HHMM,
      exceptional: z.boolean().default(false),
      rationale: z.string().default(""),
    }),
  }),
]);
export type RetouchOp = z.infer<typeof RetouchOpSchema>;

export const JosianeRetouchOutSchema = z.object({
  operations: z.array(RetouchOpSchema).default([]),
  warnings: z.array(z.string()).default([]),
});
export type JosianeRetouchOut = z.infer<typeof JosianeRetouchOutSchema>;
