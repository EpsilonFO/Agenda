/**
 * Types du planificateur v2.
 *
 * Un plan de semaine = des sessions posées par Josiane + les événements fixes
 * déjà dans l'agenda (cours, événements créés à la main). Les guardrails
 * (guardrails.ts) vérifient l'ensemble contre la config de vie.
 */

/** Catégories de session que le planificateur peut poser. */
export type SessionCategory =
  | "delos"
  | "monumia"
  | "sport"
  | "sortie"
  | "repas"
  | "autre"
  /** Déplacement inter-zones (Orsay ↔ Paris), généré pour l'affichage. */
  | "trajet";

/** Une session posée par le planificateur (dates ISO locales sans fuseau). */
export type PlanSession = {
  id: string;
  title: string;
  category: SessionCategory;
  /** id d'activité sportive de la config (pour les sessions sport). */
  activityId?: string;
  /** id de lieu de la config. Absent = lieu libre (ex: course à pied). */
  placeId?: string;
  /** ISO local, ex: 2026-07-20T09:00:00 */
  start: string;
  end: string;
  /** true = autorisée à finir après normalEnd (échéance, semaine dense). */
  exceptional?: boolean;
  /** Justification courte du placement. */
  rationale?: string;
};

/** Un événement déjà fixé dans l'agenda (cours, rdv créé à la main). */
export type FixedItem = {
  id: string;
  title: string;
  start: string;
  end: string;
  /** id de lieu de la config si on sait le rattacher (ex: cours → fac). */
  placeId?: string;
  /** true = bloc d'INDISPONIBILITÉ (absence, chez les parents) : rien ne s'y
   *  pose, mais ce n'est pas du travail — il n'exige pas de pause déjeuner. */
  indispo?: boolean;
};

/** Identifiants des règles vérifiées par les guardrails. */
export type RuleId =
  | "overlap-fixed"
  | "overlap-internal"
  | "travel-time"
  | "transition-time"
  | "work-min-block"
  | "cluster-pingpong"
  | "bounds-start"
  | "bounds-end"
  | "bounds-exceptional-count"
  | "lunch-break"
  | "big-hole"
  | "delos-quota"
  | "delos-window"
  | "monumia-min"
  | "monumia-max"
  | "monumia-daily-max"
  | "sport-quota"
  | "sport-recovery"
  | "sport-opening-hours"
  | "sport-fixed-slot"
  | "sorties-quota"
  | "sortie-manquante"
  | "work-split"
  | "missing-place"
  | "delos-weekend"
  | "imprevu-deadline"
  | "engagement-place";

export type Violation = {
  rule: RuleId;
  /** error = doit être corrigé ; warn = signalé à l'utilisateur. */
  severity: "error" | "warn";
  message: string;
  /** Sessions concernées (ids), vide pour une violation globale (quota…). */
  sessionIds: string[];
};
