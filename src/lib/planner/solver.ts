/**
 * Le SOLVEUR déterministe — le cœur du planificateur v3.
 *
 * v2 laissait Josiane (LLM) faire le tetris et les guardrails la corrigeaient.
 * Résultat : du « légal mais idiot » à répétition (déjeuner de 30 min, salle en
 * plein samedi, Delos oublié) — parce que « idiot » n'est pas une règle qu'on
 * peut écrire, et qu'aucun modèle ne devine ce qu'on n'a pas encodé.
 *
 * v3 inverse : le CODE place, en phases déterministes, chaque pose validée en
 * direct contre les mêmes contraintes que les guardrails (overlap, trajet,
 * bornes). Ce qui rendait le solveur coûteux existe déjà : la config, le modèle
 * de trajets par clusters, travelMinutes(). Les défauts des runs LLM deviennent
 * STRUCTURELLEMENT impossibles :
 *   - déjeuner = un bloc `repas` de 60 min réservé avant tout remplissage ;
 *   - Delos posé sur les gabarits EXACTS (9-13 / 14-18) ;
 *   - salle jamais le week-end en pleine journée (règle de pose) ;
 *   - Monumia étalé en semaine, le week-end reste chill.
 *
 * La VARIÉTÉ (une feature voulue) est préservée par un RNG seedé (par défaut
 * sur weekStart) : quels jours deviennent des jours Paris, course le matin ou
 * le soir… varient d'une semaine à l'autre, mais restent reproductibles pour
 * un même seed. L'optimiseur v5 (optimize.ts) dérive K seeds et garde le
 * meilleur plan au score.
 *
 * v5 : plus aucun brief LLM. Le choix des sports vient de la rotation config
 * (perWeek par activité) surchargée par WeekInput.sport ; les imprévus et les
 * sorties viennent de la demande hebdo structurée (WeekInput). Le crochet
 * `decisions` survit comme entrée PURE (tests, pilotage) — plus aucun
 * producteur LLM.
 *
 * L'oracle final reste checkWeekPlan() : le solveur construit pour passer, les
 * tests le prouvent sur de nombreuses semaines. Zéro LLM ici.
 */

import { addDays, toLocalIso } from "../dates";
import type { LifeConfig, SportActivity, TransportMode } from "./config";
import { placeById, travelMinutes } from "./config";
import { checkWeekPlan, MIDDAY } from "./guardrails";
import type {
  DelosDecision,
  SolverDecisions as FullDecisions,
  SortieDecision,
  SportDecision,
  WeekInput,
} from "./contracts";
import type { PlacementOptions, PlacementResult } from "./josiane";
import type { FixedItem, PlanSession, SessionCategory } from "./types";

// Les décisions vivent dans les contrats (le greffier les remplit depuis la
// demande) ; ré-exportées d'ici pour les tests et le pilotage. Version
// PARTIELLE : chaque famille est optionnelle quand on pilote à la main.
export type { DelosDecision, SortieDecision, SportDecision };
export type SolverDecisions = Partial<FullDecisions>;

/* ------------------------------ Helpers ----------------------------- */

const WEEKDAYS = [
  "dimanche",
  "lundi",
  "mardi",
  "mercredi",
  "jeudi",
  "vendredi",
  "samedi",
] as const;

/** Les 7 dates (YYYY-MM-DD) de la semaine commençant à weekStart (lundi). */
function weekDates(weekStart: string): string[] {
  const monday = new Date(`${weekStart}T12:00:00`);
  return Array.from({ length: 7 }, (_, i) =>
    toLocalIso(addDays(monday, i)).slice(0, 10)
  );
}

/** "HH:MM" → minutes depuis minuit. */
function hhmm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

/**
 * jour + minutes → ISO local "YYYY-MM-DDTHH:MM:00".
 *
 * Les minutes ≥ 1440 basculent sur le(s) jour(s) suivant(s). Sans ça, un trajet
 * de veille parti à 23:59 pour 70 min produisait "T25:09" : une date INVALIDE
 * (`new Date` → NaN), qui cassait le rendu du calendrier et faisait tourner en
 * rond le modèle de retouche à qui on l'affichait telle quelle.
 */
function iso(day: string, minutes: number): string {
  const dayShift = Math.floor(minutes / 1440);
  const rest = ((minutes % 1440) + 1440) % 1440;
  const d = dayShift === 0 ? day : addDaysIso(day, dayShift);
  const h = String(Math.floor(rest / 60)).padStart(2, "0");
  const m = String(rest % 60).padStart(2, "0");
  return `${d}T${h}:${m}:00`;
}

/** "YYYY-MM-DD" + n jours → "YYYY-MM-DD" (calcul en UTC, sans dérive de fuseau). */
function addDaysIso(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayIdx(day: string): number {
  return new Date(`${day}T12:00:00`).getDay();
}

function isWeekendDay(day: string): boolean {
  const d = weekdayIdx(day);
  return d === 0 || d === 6;
}

function labelOf(day: string): string {
  return `${WEEKDAYS[weekdayIdx(day)]} ${day}`;
}

/** Chevauchement en minutes entre deux intervalles. */
function overlap(aS: number, aE: number, bS: number, bE: number): number {
  return Math.max(0, Math.min(aE, bE) - Math.max(aS, bS));
}

/* ------------------------------- RNG --------------------------------- */

/** RNG seedé (mulberry32 + FNV-1a) : même seed → même suite. */
function makeRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* --------------------------- Modèle interne -------------------------- */

/** Un intervalle occupé dans une journée (session posée ou événement fixe). */
type Occ = {
  start: number;
  end: number;
  placeId?: string;
  category: SessionCategory | "fixed";
  sessionId?: string;
};

/** L'état d'une journée pendant la construction. */
type Day = {
  date: string;
  idx: number; // 0..6 dans l'ordre de la semaine (lundi=0)
  weekend: boolean;
  dayStart: number;
  occ: Occ[];
  cluster: string; // cluster « de base » de la journée
};

/* ------------------------- Primitives de pose ------------------------ */

/**
 * true si poser [s,e] (lieu `place`, catégorie `cat`) entre en conflit avec
 * l'existant : dépassement de dayStart, chevauchement, ou trajet/transition
 * insuffisants avec les voisins. C'est la MÊME logique que
 * checkTravel/checkOverlaps/checkBounds — poser uniquement via cette fonction
 * garantit que ces guardrails ne lèveront jamais.
 *
 * Le trajet se mesure entre blocs LOCALISÉS : un bloc sans lieu intercalé
 * (course à pied, sortie sans zone) ne coupe pas la chaîne — on regarde le
 * voisin localisé le plus proche, en déduisant le temps que les blocs sans
 * lieu occupent déjà. Vécu : cours à Orsay → déjeuner « nulle part » → Delos à
 * Paris à 14h passait avec 60 min pour 70 min de RER. MIROIR : checkTravel.
 */
function conflicts(
  cfg: LifeConfig,
  day: Day,
  s: number,
  e: number,
  place: string | undefined,
  cat: SessionCategory,
  opts: {
    /** true = le déjeuner sera réservé juste APRÈS ce bloc (pose transactionnelle,
     *  voir placeCreux) : pas de crédit déjeuner sur le battement d'avant. */
    skipLunchCredit?: boolean;
  } = {}
): boolean {
  if (s < day.dayStart) return true;
  for (const o of day.occ) if (s < o.end && o.start < e) return true;

  const buffer = cfg.sport.bufferAfterMin;
  const transition = cfg.schedule.transitionMin;
  // Crédit déjeuner sur un battement de midi : seulement si AUCUN repas n'est
  // déjà posé ce jour-là (sinon on exigeait une 2e pause fantôme) — et jamais
  // quand c'est le repas lui-même qu'on pose : il EST la pause.
  const lunch =
    cat === "repas" || opts.skipLunchCredit || day.occ.some((o) => o.category === "repas")
      ? 0
      : cfg.schedule.lunchBreak.minMinutes;

  // Minutes requises entre deux lieux différents : trajet, + déjeuner si le
  // battement touche midi, + `busy` = ce que les blocs sans lieu intercalés
  // occupent déjà (ils ne sont pas du temps de route).
  const travelReq = (from: string, to: string, gapS: number, gapE: number, busy: number): number => {
    const t = travelMinutes(cfg, from, to);
    if (!t) return 0;
    let req = t.minutes + busy;
    if (overlap(gapS, gapE, MIDDAY.start, MIDDAY.end) > 0) req += lunch;
    return req;
  };
  const busyBetween = (lo: number, hi: number) =>
    day.occ
      .filter((o) => !o.placeId && o.start >= lo && o.end <= hi)
      .reduce((acc, o) => acc + (o.end - o.start), 0);

  // Voisin immédiat AVANT (le bloc dont la fin est la plus proche de s).
  const beforeAll = day.occ.filter((o) => o.end <= s).sort((a, b) => b.end - a.end);
  const before = beforeAll[0];
  if (before) {
    let req = 0;
    // Trajet + déjeuner : seulement si les deux lieux sont connus et diffèrent.
    if (before.placeId && place && before.placeId !== place)
      req += travelReq(before.placeId, place, before.end, s, 0);
    // Douche/transition APRÈS une séance de sport : dûe quel que soit le lieu
    // (même la course en plein air, sans lieu, réclame ses 15 min).
    if (before.category === "sport") req += buffer;
    // Battement minimal entre deux activités, même au même endroit (un cours
    // qui finit à 17h45 n'enchaîne pas à 17h45 pile). Ni avant ni après un
    // repas : la pause EST la transition. Le trajet, plus long, la couvre.
    if (req < transition && before.category !== "repas" && cat !== "repas")
      req = transition;
    if (req > 0 && s - before.end < req) return true;
    // À TRAVERS les blocs sans lieu : le dernier bloc localisé avant nous.
    if (place && !before.placeId) {
      const anchor = beforeAll.find((o) => o.placeId);
      if (anchor && anchor.placeId !== place) {
        const need = travelReq(anchor.placeId!, place, anchor.end, s, busyBetween(anchor.end, s));
        if (s - anchor.end < need) return true;
      }
    }
  }

  // Voisin immédiat APRÈS.
  const afterAll = day.occ.filter((o) => o.start >= e).sort((a, b) => a.start - b.start);
  const after = afterAll[0];
  if (after) {
    let req = 0;
    if (after.placeId && place && after.placeId !== place)
      req += travelReq(place, after.placeId, e, after.start, 0);
    // On sort de NOTRE séance de sport → la suite doit laisser le buffer.
    if (cat === "sport") req += buffer;
    // Même battement minimal vers l'activité suivante.
    if (req < transition && after.category !== "repas" && cat !== "repas")
      req = transition;
    if (req > 0 && after.start - e < req) return true;
    if (place && !after.placeId) {
      const anchor = afterAll.find((o) => o.placeId);
      if (anchor && anchor.placeId !== place) {
        const need = travelReq(place, anchor.placeId!, e, anchor.start, busyBetween(e, anchor.start));
        if (anchor.start - e < need) return true;
      }
    }
  }

  // Un bloc SANS lieu posé entre deux blocs localisés de zones différentes ne
  // doit pas manger le temps de route (une course à pied de 45 min entre le
  // cours d'Orsay et Delos à Paris rendrait le trajet impossible).
  if (!place) {
    const anchorB = beforeAll.find((o) => o.placeId);
    const anchorA = afterAll.find((o) => o.placeId);
    if (anchorB && anchorA && anchorB.placeId !== anchorA.placeId) {
      const busy = busyBetween(anchorB.end, anchorA.start) + (e - s);
      const need = travelReq(anchorB.placeId!, anchorA.placeId!, anchorB.end, anchorA.start, busy);
      if (anchorA.start - anchorB.end < need) return true;
    }
  }
  return false;
}

/**
 * Cherche le premier créneau libre de `dur` minutes pour (place, cat) dans
 * [lo, hi] (hi = fin AU PLUS TARD). Renvoie la minute de début, ou null.
 */
function findSlot(
  cfg: LifeConfig,
  day: Day,
  dur: number,
  place: string | undefined,
  cat: SessionCategory,
  lo: number,
  hi: number,
  fromEnd = false,
  opts: { skipLunchCredit?: boolean } = {}
): number | null {
  const start = Math.max(lo, day.dayStart);
  const cands: number[] = [];
  for (let s = start; s + dur <= hi; s += 15) cands.push(s);
  if (fromEnd) cands.reverse();
  for (const s of cands) if (!conflicts(cfg, day, s, s + dur, place, cat, opts)) return s;
  return null;
}

/** Créneau libre au sens strict (chevauchement seul), pour le déjeuner sans lieu. */
function findFreeSlot(day: Day, dur: number, lo: number, hi: number): number | null {
  for (let s = Math.max(lo, day.dayStart); s + dur <= hi; s += 15) {
    if (!day.occ.some((o) => s < o.end && o.start < s + dur)) return s;
  }
  return null;
}

/* ------------------------- Décisions qualitatives -------------------- */

/**
 * Les CHOIX QUALITATIFS de la semaine (schémas dans contracts.ts) : quels
 * jours deviennent jours Paris, quel jour/moment pour chaque sport, quel soir
 * pour une sortie sans date. Ils viennent de la demande (WeekInput.decisions,
 * remplie par le greffier depuis les MOTS de l'utilisateur) ou de
 * `args.decisions` (tests, pilotage). Tout le reste (déjeuner, équilibrage
 * Monumia, trajets, imprévus) reste mécanique. Chaque décision est VALIDÉE en
 * direct par les mêmes primitives que les guardrails ; une décision
 * infaisable est rejetée (avec sa raison, remontée à l'utilisateur) et le
 * solveur retombe sur son heuristique seedée.
 */

/** Une décision que le solveur n'a pas pu honorer, avec la raison. */
export type RejectedDecision = {
  kind: "delos" | "sport" | "sortie";
  /** Référence lisible de la décision (date, label, ou activityId@date). */
  ref: string;
  reason: string;
};

/**
 * Génère les blocs de TRAJET inter-zones (Orsay ↔ Paris) pour l'affichage, en
 * suivant la POSITION et la VOITURE au fil de la semaine.
 *
 * - Passe intra-jour : entre deux blocs LOCALISÉS consécutifs de zones
 *   différentes, un trajet calé pour arriver juste à l'heure. Les blocs sans
 *   lieu (course à pied, sortie sans zone) ne coupent pas la chaîne : le trajet
 *   recule devant eux.
 * - Trajet de la VEILLE : quand la journée se termine dans une autre zone que
 *   celle où commence le lendemain, on part la veille au soir — à partir de
 *   eveningTravelStart (après le dîner) ou dès la fin du dernier bloc. Il
 *   EXISTE TOUJOURS : si la soirée court jusqu'à 23h59, la dernière session
 *   est raccourcie du temps de trajet (on part avant la fin). Un trajet « du
 *   matin » n'est jamais proposé : dormir sur place et partir à l'aube n'est
 *   pas une option voulue. Si la veille est un jour vide, le trajet s'y pose à
 *   l'heure habituelle.
 * - La voiture ne se téléporte pas : elle est là où on l'a laissée. Aller à
 *   Delos (voiture interdite) depuis Orsay = RER, et la voiture reste à Orsay :
 *   le retour du soir se fait en RER (70 min), pas en 35. Le solveur, lui,
 *   raisonne par lieu sans suivre la voiture : un trajet plus long que le
 *   battement qu'il a réservé est affiché quand même et signalé dans `notes`.
 *
 * Les trajets INTRA-zone (≤ 15 min) ne sont pas matérialisés. Les trajets déjà
 * présents dans `sessions` sont ignorés (retouche : on régénère tout). Seule
 * mutation : le raccourcissement d'une session pour le trajet de veille.
 */
export function buildTravelEvents(
  cfg: LifeConfig,
  sessions: PlanSession[],
  fixed: FixedItem[],
  notes: string[] = []
): PlanSession[] {
  const clusterOf = (placeId?: string) => (placeId ? placeById(cfg, placeId)?.cluster : undefined);
  const clusterName = (id: string) => cfg.clusters.find((c) => c.id === id)?.name ?? id;
  const ownsCar = cfg.ownedModes.includes("voiture");
  const eveningStart = hhmm(cfg.schedule.eveningTravelStart);

  type Node = { start: number; end: number; placeId?: string; title: string; session?: PlanSession };
  const byDay = new Map<string, Node[]>();
  const push = (day: string, n: Node) => {
    const list = byDay.get(day);
    if (list) list.push(n);
    else byDay.set(day, [n]);
  };
  for (const s of sessions) {
    if (s.category === "trajet") continue;
    push(s.start.slice(0, 10), {
      start: hhmm(s.start.slice(11, 16)),
      end: hhmm(s.end.slice(11, 16)),
      placeId: s.placeId,
      title: s.title,
      session: s,
    });
  }
  for (const f of fixed) {
    push(f.start.slice(0, 10), {
      start: hhmm(f.start.slice(11, 16)),
      end: hhmm(f.end.slice(11, 16)),
      placeId: f.placeId,
      title: f.title,
    });
  }
  const dates = [...byDay.keys()].sort();
  for (const d of dates) byDay.get(d)!.sort((a, b) => a.start - b.start);

  const trajets: PlanSession[] = [];
  let seq = 0;

  // Position courante et zone où se trouve la voiture. Au départ : là où la
  // semaine commence (premier bloc localisé), voiture comprise.
  let pos: { cluster: string; placeId: string } | undefined;
  let carCluster: string | undefined;
  for (const d of dates) {
    const first = byDay.get(d)!.find((n) => clusterOf(n.placeId));
    if (first) {
      pos = { cluster: clusterOf(first.placeId)!, placeId: first.placeId! };
      carCluster = pos.cluster;
      break;
    }
  }
  // La BASE d'une zone : où l'on dort et où la voiture est garée (chambre à
  // Bures, appart des parents à Paris). Un trajet de veille y mène (on ne dort
  // pas à Delos) ; et si le lieu de départ interdit la voiture (Delos) alors
  // qu'elle est dans la zone, on la récupère à la base (saut intra-zone compris).
  const baseOf = (cluster: string) =>
    cfg.places.find((p) => p.cluster === cluster && p.sleepable)?.id;
  const trip = (
    fromPlace: string,
    toPlace: string,
    sleepover: boolean
  ): { minutes: number; mode: TransportMode; to: string } | null => {
    const fromC = clusterOf(fromPlace)!;
    const toC = clusterOf(toPlace)!;
    const to = (sleepover ? baseOf(toC) : undefined) ?? toPlace;
    const carHere = ownsCar && carCluster === fromC;
    let best = travelMinutes(cfg, fromPlace, to, { carAvailable: carHere });
    const base = baseOf(fromC);
    if (carHere && base && base !== fromPlace && placeById(cfg, fromPlace)?.forbiddenModes.includes("voiture")) {
      const viaBase = travelMinutes(cfg, base, to, { carAvailable: true });
      if (viaBase?.mode === "voiture") {
        const intra = cfg.clusters.find((c) => c.id === fromC)?.intraTravelMin ?? 0;
        const total = viaBase.minutes + intra;
        if (!best || total < best.minutes) best = { mode: "voiture", minutes: total };
      }
    }
    return best ? { ...best, to } : null;
  };
  const arrive = (toPlace: string, mode: TransportMode) => {
    const c = clusterOf(toPlace)!;
    if (mode === "voiture") carCluster = c;
    pos = { cluster: c, placeId: toPlace };
  };
  const emitTrajet = (
    day: string,
    s: number,
    from: string,
    to: string,
    t: { mode: TransportMode; minutes: number },
    veille: boolean
  ) => {
    seq++;
    trajets.push({
      id: `sol-trajet-${seq}`,
      title: `Trajet ${clusterName(from)} → ${clusterName(to)} (${t.mode}, ${t.minutes} min${veille ? ", veille" : ""})`,
      category: "trajet",
      start: iso(day, s),
      end: iso(day, s + t.minutes),
      rationale: veille
        ? "Déplacement la veille pour être sur place le lendemain matin."
        : "Déplacement entre deux zones.",
    });
  };

  for (let di = 0; di < dates.length; di++) {
    const day = dates[di];
    const nodes = byDay.get(day)!;
    const placed = nodes.filter((n) => clusterOf(n.placeId));

    // Passe intra-jour : entre deux blocs localisés consécutifs.
    for (let i = 0; i + 1 < placed.length; i++) {
      const a = placed[i];
      const b = placed[i + 1];
      const ca = clusterOf(a.placeId)!;
      const cb = clusterOf(b.placeId)!;
      if (ca === cb) continue;
      const t = trip(a.placeId!, b.placeId!, false);
      if (!t || t.minutes <= 0) continue;
      // Calé pour arriver juste à l'heure, en reculant devant les blocs sans
      // lieu intercalés (on ne roule pas pendant la course à pied).
      let s = b.start - t.minutes;
      const between = nodes.filter((n) => n !== a && n !== b && n.start >= a.end && n.end <= b.start);
      for (let guard = 0; guard <= between.length; guard++) {
        const hit = between.find((n) => s < n.end && n.start < s + t.minutes);
        if (!hit) break;
        s = hit.start - t.minutes;
      }
      if (s < a.end) {
        // Le solveur a réservé un battement plus court (il raisonne par lieu,
        // sans savoir où est la voiture) : affiché quand même, collé au bloc
        // précédent, et signalé.
        s = a.end;
        notes.push(
          `${labelOf(day)} : le trajet ${clusterName(ca)} → ${clusterName(cb)} (${t.mode}, ${t.minutes} min) avant « ${b.title} » est plus long que le battement prévu — la voiture n'est pas sur place.`
        );
      }
      emitTrajet(day, s, ca, cb, t, false);
      arrive(b.placeId!, t.mode);
    }
    if (placed.length > 0) {
      const last = placed[placed.length - 1];
      pos = { cluster: clusterOf(last.placeId)!, placeId: last.placeId! };
    }

    // Trajet de la VEILLE vers le prochain jour localisé.
    const nextDay = dates
      .slice(di + 1)
      .find((d) => byDay.get(d)!.some((n) => clusterOf(n.placeId)));
    if (!nextDay || !pos) continue;
    const firstNext = byDay.get(nextDay)!.find((n) => clusterOf(n.placeId))!;
    const cNext = clusterOf(firstNext.placeId)!;
    if (cNext === pos.cluster) continue;
    const t = trip(pos.placeId, firstNext.placeId!, true);
    if (!t || t.minutes <= 0) continue;

    const veille = addDaysIso(nextDay, -1);
    let s: number;
    if (veille !== day) {
      // La veille est un jour vide : on part à l'heure habituelle.
      s = eveningStart;
    } else {
      const lastEnd = Math.max(0, ...nodes.map((n) => n.end));
      s = Math.max(lastEnd, eveningStart);
      if (s + t.minutes > 24 * 60) {
        // La soirée court trop tard : on part AVANT la fin. La dernière
        // session (jamais un événement fixe) est raccourcie du temps de trajet.
        s = 24 * 60 - t.minutes;
        for (const n of nodes) {
          if (n.end <= s) continue;
          if (n.start >= s) {
            notes.push(
              `${labelOf(day)} : « ${n.title} » tombe pendant le trajet de veille (${t.mode}, ${t.minutes} min) vers ${clusterName(cNext)} — incompatible avec le lendemain matin.`
            );
            continue;
          }
          if (!n.session) {
            notes.push(
              `${labelOf(day)} : quitter « ${n.title} » à ${iso(day, s).slice(11, 16)} pour le trajet de veille (${t.mode}, ${t.minutes} min).`
            );
            continue;
          }
          n.end = s;
          n.session.end = iso(day, s);
          n.session.rationale = [
            n.session.rationale,
            `Écourtée pour le trajet de veille (${t.mode}, ${t.minutes} min).`,
          ]
            .filter(Boolean)
            .join(" ");
        }
      }
    }
    emitTrajet(veille, s, pos.cluster, cNext, t, true);
    arrive(t.to, t.mode);
  }

  return trajets;
}

/* ----------------------------- Le solveur ---------------------------- */

export type SolveArgs = {
  input: WeekInput;
  fixed: FixedItem[];
  /** Choix qualitatifs imposés au solveur (tests, pilotage) — sinon tout est seedé au RNG. */
  decisions?: SolverDecisions;
  /** Seed du RNG (défaut : dérivé de weekStart). L'optimiseur en dérive K. */
  seed?: string;
  /** Volume Monumia visé (heures/semaine), borné au [plancher, plafond] de la
   *  config. Absent : plafond si maximize, sinon plancher + 2h. L'optimiseur
   *  en explore une grille et laisse le score trancher. */
  monumiaTargetHours?: number;
  /**
   * Plan PRÉCÉDENT (replanification). Tout ce qu'aucune décision n'impose y est
   * repris de préférence : jours Delos, jour de chaque sport. Sans ça, une
   * re-résolution tirait ces jours au RNG et « déplace Delos vendredi →
   * mercredi » déplaçait aussi celui du jeudi (vécu). Le solveur reste
   * déterministe : `previous` n'est qu'un ordre de préférence.
   */
  previous?: PlanSession[];
};

/** Résultat du solveur : un PlacementResult + les décisions LLM rejetées. */
export type SolveResult = PlacementResult & { rejected: RejectedDecision[] };

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Construit la semaine de façon déterministe. `cfg` est déjà la config avec les
 * overrides hebdo appliqués (voir applyOverrides), `fixed` inclut déjà les
 * indisponibilités. `args.decisions` (optionnel) porte les choix qualitatifs de
 * Josiane : honorés s'ils sont faisables, rejetés (dans `rejected`) sinon, avec
 * repli sur l'heuristique seedée. Renvoie un SolveResult (attempts=0, pas de LLM).
 */
export function solveWeek(
  cfg: LifeConfig,
  args: SolveArgs,
  opts: PlacementOptions = {}
): SolveResult {
  const { input, fixed } = args;
  // Décisions : celles du pilotage (tests) priment, sinon celles de la demande.
  const decisions: SolverDecisions = args.decisions ?? input.decisions;
  const rejected: RejectedDecision[] = [];
  const rng = makeRng(args.seed ?? `${input.weekStart}|v5`);
  const dates = weekDates(input.weekStart);
  const normalEnd = hhmm(cfg.schedule.normalEnd);
  const minBlock = cfg.work.minBlockMinutes;
  const notes: string[] = [];

  const emit = (kind: Parameters<NonNullable<PlacementOptions["onEvent"]>>[1], msg: string) =>
    opts.onEvent?.("solveur", kind, msg);

  // 1) Journées, amorcées avec les événements fixes.
  const days: Day[] = dates.map((date, idx) => {
    const weekend = isWeekendDay(date);
    const day: Day = {
      date,
      idx,
      weekend,
      dayStart: hhmm(weekend ? cfg.schedule.weekend.dayStart : cfg.schedule.dayStart),
      occ: [],
      cluster: "orsay",
    };
    for (const f of fixed) {
      if (f.start.slice(0, 10) !== date) continue;
      day.occ.push({
        start: hhmm(f.start.slice(11, 16)),
        end: hhmm(f.end.slice(11, 16)),
        placeId: f.placeId,
        category: "fixed",
      });
    }
    return day;
  });
  const dayByDate = new Map(days.map((d) => [d.date, d]));

  // Ce que le plan précédent avait posé — préférence, jamais contrainte.
  const prevDelosDates = (remote: boolean): Set<string> =>
    new Set(
      (args.previous ?? [])
        .filter((p) => p.category === "delos" && (p.placeId === cfg.work.delos.placeId) !== remote)
        .map((p) => p.start.slice(0, 10))
    );
  const prevPresentielDates = prevDelosDates(false);
  const prevRemoteDates = prevDelosDates(true);
  const prevSportDates = new Map<string, Set<string>>();
  for (const p of args.previous ?? []) {
    if (p.category !== "sport" || !p.activityId) continue;
    const set = prevSportDates.get(p.activityId) ?? new Set<string>();
    set.add(p.start.slice(0, 10));
    prevSportDates.set(p.activityId, set);
  }

  // Normalisation de label (comparaison insensible aux accents/casse).
  const normLabel = (s: string) =>
    s
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .trim();

  // Monumia se pose UNIQUEMENT dans le cluster de la journée : pas de lieu de
  // travail parisien un jour Orsay et inversement. Sans lieu adapté → pas de
  // Monumia ce jour-là (évite un trajet inter-cluster fantôme masqué par le déj).
  const monPlace = (day: Day): string | null =>
    cfg.work.monumia.preferredPlaceIds.find(
      (p) => placeById(cfg, p)?.cluster === day.cluster
    ) ?? null;

  const out: PlanSession[] = [];
  let seq = 0;
  let monumiaWeekTotal = 0; // hebdo Monumia, suivi dès la phase 2 (imprévus exclus)
  const monumiaPerDay = new Map<string, number>();
  const add = (
    day: Day,
    cat: SessionCategory,
    s: number,
    e: number,
    fieldsOrPlace: { title: string; placeId?: string; activityId?: string; rationale?: string; exceptional?: boolean }
  ): PlanSession => {
    seq++;
    const sess: PlanSession = {
      id: `sol-${seq}-${cat}`,
      title: fieldsOrPlace.title,
      category: cat,
      activityId: fieldsOrPlace.activityId,
      placeId: fieldsOrPlace.placeId,
      start: iso(day.date, s),
      end: iso(day.date, e),
      exceptional: fieldsOrPlace.exceptional || undefined,
      rationale: fieldsOrPlace.rationale,
    };
    out.push(sess);
    day.occ.push({ start: s, end: e, placeId: fieldsOrPlace.placeId, category: cat, sessionId: sess.id });
    if (cat === "monumia") {
      monumiaWeekTotal += e - s;
      monumiaPerDay.set(day.date, (monumiaPerDay.get(day.date) ?? 0) + (e - s));
    }
    return sess;
  };
  /** Retire une session (hors Monumia) posée à l'essai — voir placeCreux. */
  const removeSession = (day: Day, sess: PlanSession): void => {
    const i = out.indexOf(sess);
    if (i >= 0) out.splice(i, 1);
    const oi = day.occ.findIndex((o) => o.sessionId === sess.id);
    if (oi >= 0) day.occ.splice(oi, 1);
  };

  /* ------------------------ Réservation du déjeuner --------------------- */

  const lunchIdeal = cfg.schedule.lunchBreak.idealMinutes;
  const lunchMin = cfg.schedule.lunchBreak.minMinutes;

  // Réserve un vrai déjeuner (idéalement 60 min, jamais moins que le minimum)
  // dans le créneau du midi. Idempotent : un seul par jour. Le repas porte le
  // LIEU du bloc qu'il prolonge (on mange là où on est) : sans lieu, il coupait
  // la chaîne des trajets — cours à Orsay, déjeuner « nulle part », Delos à
  // Paris à 14h : 60 min pour 70 min de RER, et aucun trajet affiché. Chaque
  // pose passe par conflicts() : si le trajet qui suit ne tient plus, le
  // déjeuner se raccourcit (pas de 15 min jusqu'à minMinutes) ou glisse après
  // le trajet (on mange en arrivant). Appelé en 1re passe AVANT Delos distant
  // et le sport (sinon ils se collent « au plus tôt » après un cours et il ne
  // reste que 30 min pour manger), en 2e passe pour les jours devenus chargés,
  // et RAPPELÉ au premier bloc Monumia du jour.
  const lunchDurations: number[] = [];
  for (let d = lunchIdeal; d > lunchMin; d -= 15) lunchDurations.push(d);
  lunchDurations.push(lunchMin);

  const reserveLunch = (day: Day): void => {
    if (day.occ.some((o) => o.category === "repas")) return;
    const tryLunch = (s: number, place: string | undefined, rationale: string): boolean => {
      for (const dur of lunchDurations) {
        const e = s + dur;
        // Le repas peut déborder un peu de la plage (séance au creux de midi
        // puis déjeuner 13h45-14h45) : le guardrail lunch-break, lui, ne
        // regarde que le temps libre dans la plage, qui reste suffisant.
        if (e > MIDDAY.end + 30) continue;
        if (conflicts(cfg, day, s, e, place, "repas")) continue;
        add(day, "repas", s, e, { title: "Déjeuner", placeId: place, rationale });
        return true;
      }
      return false;
    };
    // 0) Collé à la FIN du bloc du matin (un cours qui finit à midi → on mange
    //    en sortant, sur place). Sans ça, le déjeuner s'ancrait « avant
    //    l'après-midi » et laissait poireauter une heure. Après une séance de
    //    SPORT, le buffer douche reste dû avant de manger.
    //    Un bloc qui COMMENCE après 12h30 n'est pas le bloc du matin : le
    //    déjeuner se prend avant lui, pas collé derrière. Vécu : inscription
    //    SUAPS 13h-13h15 → déjeuner 13h15-14h15, alors que 12h-13h était libre
    //    en sortant du cours.
    const morningBlock = day.occ
      .filter(
        (o) =>
          o.category !== "sortie" &&
          o.start < 12 * 60 + 30 &&
          o.end >= 11 * 60 + 30 &&
          o.end <= 13 * 60 + 30
      )
      .sort((a, b) => b.end - a.end)[0];
    if (morningBlock) {
      const s = morningBlock.end + (morningBlock.category === "sport" ? cfg.sport.bufferAfterMin : 0);
      // On ne déjeune pas à la salle de sport : après une séance, le repas se
      // prend au bloc localisé voisin (hors sport), sinon là où on bosse.
      const place =
        morningBlock.category !== "sport"
          ? morningBlock.placeId
          : (day.occ
              .filter((o) => o.placeId && o.category !== "sport" && o !== morningBlock)
              .sort((a, b) => Math.abs(a.end - s) - Math.abs(b.end - s))[0]?.placeId ??
            monPlace(day) ??
            undefined);
      if (tryLunch(s, place, "Déjeuner en sortant du bloc du matin.")) return;
      // Après une séance, changer de lieu pour manger coûte 15 min de trajet en
      // plus de la douche : si ça ne tient plus (séance au creux de midi, Delos
      // juste après), on mange SUR PLACE (le campus) — un déjeuner entier plutôt
      // qu'un repas de 30 min repoussé à 14h.
      if (
        morningBlock.category === "sport" &&
        morningBlock.placeId &&
        place !== morningBlock.placeId &&
        tryLunch(s, morningBlock.placeId, "Déjeuner sur place après la séance.")
      )
        return;
    }
    // 1) Collé juste AVANT un bloc d'après-midi déjà posé (cours, Delos aprem),
    //    sur le lieu de ce bloc : le matin enchaîne jusqu'au déjeuner sans
    //    trou, et si on change de zone entre les deux, on mange en arrivant.
    const anchor = day.occ
      .filter((o) => o.start >= 12 * 60 && o.start <= 14 * 60)
      .sort((a, b) => a.start - b.start)[0];
    if (anchor) {
      for (const dur of lunchDurations) {
        const s = anchor.start - dur;
        if (s < day.dayStart) continue;
        if (conflicts(cfg, day, s, anchor.start, anchor.placeId, "repas")) continue;
        add(day, "repas", s, anchor.start, {
          title: "Déjeuner",
          placeId: anchor.placeId,
          rationale: "Déjeuner calé juste avant l'après-midi (pas de temps mort).",
        });
        return;
      }
    }
    // 2) Sinon : un vrai déjeuner à partir de MIDI (pas 11h45 — un jour vide
    //    donnait « Monumia 10h-11h45, déjeuner 11h45 »), au plus tôt, là où on
    //    se trouve : lieu du dernier bloc localisé du matin, sinon du premier
    //    de l'après-midi, sinon libre. findSlot respecte les transitions
    //    (après une séance de sport, le déjeuner laisse le buffer douche).
    //    On ne déjeune pas à la piscine : les lieux de sport sont écartés ; sans
    //    autre repère, on mange là où on bossera (lieu Monumia du jour).
    const eatable = (o: Occ) => o.placeId && o.category !== "sport";
    const near =
      day.occ.filter((o) => eatable(o) && o.end <= MIDDAY.end).sort((a, b) => b.end - a.end)[0] ??
      day.occ.filter((o) => eatable(o) && o.start >= 12 * 60).sort((a, b) => a.start - b.start)[0];
    const lunchPlace = near?.placeId ?? monPlace(day) ?? undefined;
    for (const dur of lunchDurations) {
      const lo = dur < lunchIdeal ? MIDDAY.start : 12 * 60;
      const hi = dur < lunchIdeal ? MIDDAY.end : 14 * 60;
      const s = findSlot(cfg, day, dur, lunchPlace, "repas", lo, hi);
      if (s !== null) {
        add(day, "repas", s, s + dur, {
          title: "Déjeuner",
          placeId: lunchPlace,
          rationale: "Pause déjeuner réservée.",
        });
        return;
      }
    }
    // Midi saturé (cours) : lunch-break signalera un warn.
  };

  /** Lieu représentatif d'une zone (pour ancrer un bloc dont on ne connaît que
   *  la zone : une sortie, un rendez-vous). */
  const clusterPlaceId = (cluster?: string): string | undefined =>
    cluster ? cfg.places.find((p) => p.cluster === cluster)?.id : undefined;

  /* ------ 1 bis) Rendez-vous à heure FIXE (inscription, rdv, appel) ------- */

  // Posés AVANT tout le reste, à l'heure dite, sans négociation : ce sont des
  // obligations datées, pas des heures à caser. Ils occupent la journée, donc
  // imprévus, sport, Delos et Monumia les contournent d'eux-mêmes. Les faire
  // passer pour des imprévus (faute de champ) donnait un bloc d'1h30 posé un
  // autre jour « pour garder de la marge » — l'inverse de ce qui est demandé.
  for (const en of input.engagements) {
    const day = dayByDate.get(en.day);
    if (!day) {
      notes.push(`Rendez-vous « ${en.label} » : le ${en.day} n'est pas dans la semaine — non posé.`);
      continue;
    }
    if (en.zone && !cfg.clusters.some((c) => c.id === en.zone)) {
      notes.push(`Rendez-vous « ${en.label} » : zone « ${en.zone} » inconnue de la config — ignorée.`);
    }
    const s = hhmm(en.start);
    const fromDuration = s + (en.durationMin ?? 30);
    const e = Math.min(en.end && hhmm(en.end) > s ? hhmm(en.end) : fromDuration, 24 * 60 - 1);
    add(day, "autre", s, e, {
      title: en.label,
      placeId: clusterPlaceId(en.zone),
      rationale: `Rendez-vous à heure fixe${en.note ? ` — ${en.note}` : ""}.`,
    });
  }

  /* --------- 2) Imprévus / TP — la PRIORITÉ, avant sport et Monumia ------- */

  // Un TP à rendre passe AVANT Monumia et le sport : on le pose en premier,
  // tôt dans la semaine, et TOUJOURS avec de la marge — fini la veille de
  // l'échéance au plus tard (marginDaysMin), idéalement plusieurs jours avant.
  // Source de vérité : input.imprevus (la demande) ; sans volume précisé,
  // la config donne le défaut (work.imprevus.defaultHours).
  const monumiaDailyMax = cfg.work.monumia.maxHoursPerDay * 60;
  {
    for (const im of input.imprevus) {
      let remaining = Math.max(
        minBlock,
        Math.round((im.hoursNeeded ?? cfg.work.imprevus.defaultHours) * 60)
      );
      const deadline = im.deadline ?? dates[dates.length - 1];
      // Fenêtre de pose : jamais le jour J ni la veille (marge min) — la marge
      // idéale ordonne les jours candidats (tôt d'abord).
      const limit = dates.filter((d) => d <= deadline).at(-1);
      const margin = cfg.work.imprevus.marginDaysMin;
      const lastOk = toLocalIso(addDays(new Date(`${deadline}T12:00:00`), -margin)).slice(0, 10);
      let pool = days
        .filter((d) => d.date <= lastOk)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (pool.length === 0 && limit) {
        pool = days.filter((d) => d.date <= limit);
        notes.push(
          `« ${im.label} » : marge de ${margin} j avant l'échéance impossible à tenir — posé au plus près quand même.`
        );
      }
      for (const d of pool) {
        if (remaining < minBlock) break;
        if ((monumiaPerDay.get(d.date) ?? 0) >= monumiaDailyMax) continue;
        const place = monPlace(d);
        if (!place) continue;
        const s = findSlot(cfg, d, minBlock, place, "autre", d.dayStart, normalEnd);
        if (s === null) continue;
        let e = s + minBlock;
        const cap = Math.min(normalEnd, s + remaining);
        while (e + 15 <= cap && !conflicts(cfg, d, s, e + 15, place, "autre")) e += 15;
        add(d, "autre", s, e, {
          title: im.label,
          placeId: place,
          rationale: `Imprévu/TP — pour le ${deadline}, posé tôt pour garder de la marge.`,
        });
        remaining -= e - s;
      }
      if (remaining >= minBlock) {
        notes.push(
          `« ${im.label} » : ${(remaining / 60).toFixed(1)}h n'ont pas pu être casées avant l'échéance.`
        );
      }
    }
  }

  /* --------- 3) Sorties DEMANDÉES (obligatoires, ne se négocient pas) ------ */

  const eveningDefaults = ["20:00", "23:00"];
  const weekdayEveningPref = [4, 5, 6, 3]; // vendredi, samedi, dimanche, jeudi (idx)
  const eveningFree = (d: Day) => !d.occ.some((o) => o.start < 23 * 60 && o.end > 20 * 60);

  // Lieu d'une sortie : on ne connaît pas le lieu exact, mais on connaît la ZONE
  // habituelle (Marine → Orsay, amis → Paris). Rattacher la sortie à un lieu
  // représentatif de cette zone suffit à faire respecter le trajet autour d'elle
  // (ex: dîner amis à Paris ⇒ temps de transport depuis Orsay imposé au travail
  // qui précède). Pour « autre », on INFÈRE la zone depuis le libellé (« …à
  // Paris », « …à Orsay ») puis depuis les notes de la demande ; sans indice,
  // la sortie reste sans lieu (zone inconnue, aucun trajet forcé).
  // Mots-clés de zone, construits depuis la config (noms de clusters ET de
  // lieux : « Paris », « Orsay / Saclay », « Bibliothèque (Orsay) »…). Un mot
  // générique partagé par tous les clusters (« maison »…) n'est retenu que s'il
  // est distinctif (sinon on l'ignore : il ne discrimine rien).
  const clusterKeywords = cfg.clusters.map((c) => {
    const words = new Set<string>();
    const addWords = (text: string) => {
      for (const w of normLabel(text).split(/[^a-z]+/)) {
        if (w.length >= 4) words.add(w); // « paris », « orsay », « saclay »…
      }
    };
    addWords(c.name);
    for (const p of cfg.places.filter((p) => p.cluster === c.id)) addWords(p.name);
    return { cluster: c.id, words: [...words] };
  });
  const wordCount = new Map<string, number>();
  for (const { words } of clusterKeywords)
    for (const w of words) wordCount.set(w, (wordCount.get(w) ?? 0) + 1);
  const inferClusterFromText = (text: string): string | undefined => {
    if (!text) return undefined;
    const t = normLabel(text);
    for (const { cluster, words } of clusterKeywords) {
      if (words.some((w) => (wordCount.get(w) ?? 0) === 1 && t.includes(w))) return cluster;
    }
    return undefined;
  };
  const sortiePlaceId = (withWhom: string, label: string, zone?: string): string | undefined => {
    // Zone EXPLICITE (le greffier l'a demandée ou l'utilisateur l'a dite) :
    // elle prime sur l'entourage et sur l'inférence par libellé.
    if (zone && cfg.clusters.some((c) => c.id === zone)) return clusterPlaceId(zone);
    if (withWhom === "marine") return clusterPlaceId(cfg.sorties.copine.usualCluster);
    if (withWhom === "amis") return clusterPlaceId(cfg.sorties.amis.usualCluster);
    const inferred = inferClusterFromText(label) ?? inferClusterFromText(input.notes ?? "");
    return inferred ? clusterPlaceId(inferred) : undefined;
  };

  // Décisions de Josiane pour les sorties sans date imposée (par label).
  const sortieDecisions = new Map<string, SortieDecision>();
  for (const sd of decisions?.sorties ?? []) sortieDecisions.set(sd.label, sd);

  for (const r of input.sortiesDatees) {
    let day = r.day ? dayByDate.get(r.day) : undefined;
    const dec = !day ? sortieDecisions.get(r.label) : undefined;
    if (!day && dec) {
      // Jour choisi par Josiane : honoré si la soirée y est encore libre.
      const chosen = dayByDate.get(dec.date);
      if (chosen && eveningFree(chosen)) day = chosen;
      else
        rejected.push({
          kind: "sortie",
          ref: r.label,
          reason: chosen ? `soirée du ${dec.date} déjà occupée` : `jour ${dec.date} hors semaine`,
        });
    }
    if (!day) {
      // Sans jour : un soir de fin de semaine encore libre en soirée.
      for (const wi of weekdayEveningPref) {
        const d = days[wi];
        if (d && eveningFree(d)) {
          day = d;
          break;
        }
      }
      day = day ?? days[4];
    }
    const sMin = hhmm(r.start ?? dec?.start ?? eveningDefaults[0]);
    const eMin = r.end ? hhmm(r.end) : Math.min(sMin + 180, 23 * 60 + 59);
    if (r.zone && !cfg.clusters.some((c) => c.id === r.zone)) {
      notes.push(`Sortie « ${r.label} » : zone « ${r.zone} » inconnue de la config — ignorée.`);
    }
    const placeId = sortiePlaceId(r.withWhom, r.label, r.zone);
    add(day, "sortie", sMin, eMin, {
      title: r.label,
      placeId,
      rationale: "Sortie demandée cette semaine.",
    });
    // Une soirée ancrée dans une AUTRE zone (ex : Tristan à Paris un jour
    // Orsay) bascule le cluster de la journée : le travail de fin de journée se
    // pose alors dans la zone de la soirée (Monumia à Paris), ce qui déclenche
    // le trajet dans la journée plutôt qu'un aller tardif. MAIS pas si le jour
    // est DÉJÀ ancré dans sa zone d'origine par un bloc fixe (cours, rdv) : un
    // cours à Orsay le matin + une soirée à Paris, c'est un trajet de fin de
    // journée Orsay → Paris, pas une journée « Paris » (sinon Monumia se pose à
    // Paris en pleine journée Orsay → ping-pong).
    const sc = placeId ? placeById(cfg, placeId)?.cluster : undefined;
    const anchoredInBase = day.occ.some(
      (o) => o.category === "fixed" && o.placeId && placeById(cfg, o.placeId)?.cluster === day.cluster
    );
    if (sc && sc !== day.cluster && sMin >= 17 * 60 && !anchoredInBase) day.cluster = sc;
  }

  /* --------------------- 3 bis) Demi-journées Delos --------------------- */

  const delosPlace = cfg.work.delos.placeId;
  const nHalf = cfg.work.delos.presentielHalfDaysPerWeek;
  const windows = cfg.work.delos.halfDayWindows.map((w) => ({
    s: hhmm(w.start),
    e: hhmm(w.end),
    label: `${w.start}-${w.end}`,
  }));
  const delosDates = new Set<string>();

  // Jours où un sport a un créneau IMPOSÉ (ex: natation le jeudi) : on évite d'y
  // poser Delos, sinon le sport (Orsay) et Delos (Paris) se disputent la journée.
  const fixedSportWeekdays = new Set(
    cfg.sport.activities
      .filter((a) => a.fixedSlot && a.status !== "optionnel")
      .map((a) => a.fixedSlot!.weekday)
  );

  if (nHalf > 0 && windows.length > 0) {
    let placed = 0;
    const usedDates = new Set<string>();

    // Pose une liste de gabarits sur un jour (chacun validé contre l'existant),
    // marque le jour « Paris ». Renvoie le nombre de demi-journées effectivement
    // posées (au plus maxN). Poser via conflicts() garantit qu'aucun guardrail
    // ne lèvera.
    const placeDelos = (
      day: Day,
      wins: { s: number; e: number }[],
      rationale: string,
      maxN = wins.length
    ): number => {
      let n = 0;
      for (const w of wins) {
        if (n >= maxN || placed + n >= nHalf) break;
        if (conflicts(cfg, day, w.s, w.e, delosPlace, "delos")) continue;
        add(day, "delos", w.s, w.e, { title: "Delos (présentiel)", placeId: delosPlace, rationale });
        n++;
      }
      if (n > 0) {
        day.cluster = "paris";
        delosDates.add(day.date);
        usedDates.add(day.date);
      }
      return n;
    };

    const winsFor = (gabarit: DelosDecision["gabarit"]): { s: number; e: number }[] => {
      if (gabarit === "journee") return windows.slice(0, 2);
      if (gabarit === "apres-midi" && windows[1]) return [windows[1]];
      return [windows[0]];
    };

    // 3a) Décisions de Josiane d'abord — un jour Paris peut désormais porter un
    // fixe compatible (validé par conflicts()), là où l'heuristique exigeait un
    // jour vierge.
    for (const d of decisions?.delos ?? []) {
      // Un bloc à distance se décide plus bas (4 bis), pas ici.
      if (d.modalite === "distance") continue;
      // Quota dépassé : on le DIT au lieu d'ignorer en silence — sinon la
      // demi-journée disparaît du plan sans que personne ne sache pourquoi.
      if (placed >= nHalf) {
        rejected.push({
          kind: "delos",
          ref: d.date,
          reason: `quota de ${nHalf} demi-journée(s) de présentiel déjà atteint`,
        });
        continue;
      }
      const day = dayByDate.get(d.date);
      if (!day) {
        rejected.push({ kind: "delos", ref: d.date, reason: "jour hors semaine" });
        continue;
      }
      if (day.weekend && !cfg.work.delos.weekendOk) {
        rejected.push({ kind: "delos", ref: d.date, reason: "Delos ne se pose pas le week-end" });
        continue;
      }
      if (usedDates.has(d.date)) continue;
      const n = placeDelos(day, winsFor(d.gabarit), "Demi-journée Delos (jour demandé).");
      if (n === 0) {
        rejected.push({ kind: "delos", ref: d.date, reason: "créneau Delos en conflit (fixe/trajet)" });
      }
      placed += n;
    }

    // 3b) Complément seedé pour ce qui reste à poser. Tout jour où un gabarit
    // passe conflicts() est candidat — PAS seulement les jours vierges : une
    // semaine de cours tous les matins doit quand même recevoir ses
    // demi-journées (l'après-midi 14-18 passe très bien après un cours 9-12).
    // Vécu : l'ancien filtre « jour vierge » posait 0/2 en semaine de rentrée.
    if (placed < nHalf) {
      const weekendOk = cfg.work.delos.weekendOk;
      const candidates = shuffled(
        days.filter((d) => (!d.weekend || weekendOk) && !usedDates.has(d.date)),
        rng
      ).sort((a, b) => delosDayKey(a) - delosDayKey(b));
      // Par défaut on empile en journées COMPLÈTES (2 gabarits) : « 2 demi-journées
      // le même jour = journée Paris », donc un seul aller-retour. groupHalfDays
      // à false les étale sur des jours distincts (1 gabarit max par jour).
      let ci = 0;
      while (placed < nHalf && ci < candidates.length) {
        const day = candidates[ci++];
        const maxN = cfg.work.delos.groupHalfDays ? nHalf - placed : 1;
        placed += placeDelos(
          day,
          windows,
          maxN >= 2 ? "Demi-journée Delos (gabarit complet)." : "Demi-journée Delos.",
          maxN
        );
      }
    }

    // Ordre de préférence des jours du repli : semaine avant week-end (même
    // toléré, il reste un dernier recours), jours sans créneau sportif imposé,
    // puis jours vides (une journée Paris complète y tient sans découpage).
    function delosDayKey(d: Day): number {
      return (
        (d.weekend ? 100 : 0) +
        (fixedSportWeekdays.has(WEEKDAYS[weekdayIdx(d.date)]) ? 10 : 0) +
        (d.occ.length > 0 ? 1 : 0) -
        // Replanification : là où Delos était déjà, avant tout autre jour.
        (prevPresentielDates.has(d.date) ? 20 : 0)
      );
    }

    if (placed < nHalf) {
      notes.push(
        `Seulement ${placed}/${nHalf} demi-journées Delos ont pu être posées (aucun gabarit ne passe sur les jours restants). À voir avec le reste de l'agenda.`
      );
      emit("info", `delos: ${placed}/${nHalf} posées`);
    }
  }

  /* ---------------------------- 4) Sport ------------------------------- */

  const acts = cfg.sport.activities;
  const actById = new Map(acts.map((a) => [a.id, a]));

  // Liste désirée : ROTATION CONFIG (v5). Pour chaque activité, le nombre de
  // séances visées est : `fois` de input.sport.imposer si présent, sinon
  // perWeek (config). Les « impose » figurent toujours (au moins 1 fois,
  // exclusion hebdo ignorée) ; les « optionnel » ne se placent QUE via
  // imposer ; les « voulu » exclues cette semaine tombent à 0. On complète
  // ensuite au minimum hebdo avec les « voulu », plafonné au max.
  const excluded = new Set(input.sport.exclure);
  for (const id of input.sport.exclure) {
    if (!actById.has(id)) notes.push(`Sport à exclure « ${id} » inconnu de la config — ignoré.`);
  }
  const forcedCount = new Map<string, number>();
  for (const req of input.sport.imposer) {
    if (!actById.has(req.activityId)) {
      notes.push(`Sport demandé « ${req.activityId} » inconnu de la config — ignoré.`);
      continue;
    }
    forcedCount.set(req.activityId, (forcedCount.get(req.activityId) ?? 0) + req.fois);
  }
  const desiredCount = (a: SportActivity): number => {
    const forced = forcedCount.get(a.id) ?? 0;
    if (a.status === "impose") {
      if (excluded.has(a.id))
        notes.push(`${a.name} est imposée par la config — l'exclusion de la semaine est ignorée.`);
      return Math.max(a.perWeek, 1, forced);
    }
    if (a.status === "optionnel") return forced;
    if (excluded.has(a.id)) return 0;
    return forced > 0 ? forced : a.perWeek;
  };
  const desired: SportActivity[] = [];
  for (const a of acts) {
    for (let i = 0; i < desiredCount(a); i++) desired.push(a);
  }
  const voulu = acts.filter((a) => a.status === "voulu" && !excluded.has(a.id));
  let vi = 0;
  while (desired.length < cfg.sport.sessionsPerWeekMin && voulu.length > 0) {
    desired.push(voulu[vi % voulu.length]);
    vi++;
  }
  // Les activités à créneau IMPOSÉ (natation avec la fac) réservent leur slot
  // en premier : une séance flexible (salle) ne viendra pas le leur voler.
  const wantSport = desired
    .sort((a, b) => (a.fixedSlot ? 0 : 1) - (b.fixedSlot ? 0 : 1))
    .slice(0, cfg.sport.sessionsPerWeekMax);

  // Suivi de récupération (minutes absolues sur la semaine).
  const sportAbs: Array<{ actId: string; s: number; e: number }> = [];
  const restOk = (act: SportActivity, dayIdx: number, s: number, e: number): boolean => {
    const min = act.minRestHours * 60;
    const as = dayIdx * 1440 + s;
    const ae = dayIdx * 1440 + e;
    return sportAbs
      .filter((p) => p.actId === act.id)
      .every((p) => as - p.e >= min || p.s - ae >= min);
  };

  const clusterOfPlace = (id?: string) => (id ? placeById(cfg, id)?.cluster : undefined);

  const eligibleForSport = (act: SportActivity, day: Day): boolean => {
    // Le week-end reste léger : pas d'activité « à lieu » (salle/piscine), seule
    // la course (sans lieu, dehors) est tolérée le matin.
    if (day.weekend && act.placeIds.length > 0) return false;
    // Jour Paris : seules les activités praticables à Paris (ou sans lieu).
    if (delosDates.has(day.date) && act.placeIds.length > 0) {
      if (clusterOfPlace(act.placeIds[0]) !== "paris") return false;
    }
    return true;
  };

  // Décisions sport de Josiane, groupées par activité (file consommée dans
  // l'ordre : une décision par instance de séance désirée).
  const sportDecisionQueue = new Map<string, SportDecision[]>();
  for (const sd of decisions?.sport ?? []) {
    const q = sportDecisionQueue.get(sd.activityId) ?? [];
    q.push(sd);
    sportDecisionQueue.set(sd.activityId, q);
  }

  // Tente de poser une séance à un moment donné. « matin » = fenêtre du matin
  // (idéalement tôt, mais pour une activité à lieu un jour de cours, on accepte
  // la FIN DE MATINÉE — collée à la fin du dernier bloc du matin, le déjeuner
  // glisse après) ; « fin-apres-midi » ∈ [16:30,hi]. Renvoie true si posée.
  // Créneau de sport HORS heure de pointe d'abord (config `rushHours`, ex : la
  // salle 17h-19h30), la pointe en dernier recours. Le score pénalise aussi la
  // pointe : entre candidats, ceux qui l'évitent gagnent.
  const findSportSlot = (
    act: SportActivity,
    d: Day,
    dur: number,
    place: string | undefined,
    lo: number,
    hi: number,
    opts: { skipLunchCredit?: boolean } = {}
  ): number | null => {
    if (act.rushHours) {
      const rs = hhmm(act.rushHours.start);
      const re = hhmm(act.rushHours.end);
      const before = findSlot(cfg, d, dur, place, "sport", lo, Math.min(hi, rs), false, opts);
      if (before !== null) return before;
      const after = findSlot(cfg, d, dur, place, "sport", Math.max(lo, re), hi, false, opts);
      if (after !== null) return after;
    }
    return findSlot(cfg, d, dur, place, "sport", lo, hi, false, opts);
  };

  // CREUX DE MIDI pour une activité à lieu « pas le matin » (la salle) : collée
  // au dernier bloc du matin, entre 10h30 et 13h45 au plus tard — l'après-midi
  // reste libre pour un grand bloc de travail et on évite l'heure de pointe.
  // Un cours qui finit à midi ne l'empêche plus (vécu : Delos distant 13h15-
  // 17h15 puis salle 17h30 en pleine cohue, alors que « salle 12h15, déjeuner
  // 13h45, Delos 15h-19h » convient très bien — le Delos distant est souple).
  // Le déjeuner SUIT la séance : pose TRANSACTIONNELLE — sans crédit déjeuner
  // sur le battement d'avant, puis réservation immédiate du repas ; si aucun
  // repas ne peut suivre, la séance est annulée (le crédit redevient dû).
  const placeCreux = (
    act: SportActivity,
    d: Day,
    dur: number,
    place: string | undefined,
    lo: number,
    hi: number,
    rationale: string,
    // true = creux de midi DEMANDÉ (décision « midi ») : vaut pour n'importe
    // quelle activité, avec ou sans lieu — pas seulement la salle.
    explicit = false
  ): boolean => {
    if (!explicit && (act.morningOk || !place)) return false;
    if (d.occ.some((o) => o.category === "repas")) return false;
    const lastMorningEnd = Math.max(
      d.dayStart,
      ...d.occ.filter((o) => o.category !== "sortie" && o.start < 14 * 60).map((o) => o.end)
    );
    if (lastMorningEnd > 12 * 60 + 30) return false;
    const cLo = Math.max(lo, 10 * 60 + 30, lastMorningEnd);
    const cHi = Math.min(hi, 13 * 60 + 45);
    const s = findSportSlot(act, d, dur, place, cLo, cHi, { skipLunchCredit: true });
    if (s === null || !restOk(act, d.idx, s, s + dur)) return false;
    const sess = add(d, "sport", s, s + dur, { title: act.name, activityId: act.id, placeId: place, rationale });
    reserveLunch(d);
    if (!d.occ.some((o) => o.category === "repas")) {
      removeSession(d, sess);
      return false;
    }
    sportAbs.push({ actId: act.id, s: d.idx * 1440 + s, e: d.idx * 1440 + s + dur });
    return true;
  };

  const placeSportAt = (
    act: SportActivity,
    d: Day,
    dur: number,
    place: string | undefined,
    moment: SportDecision["moment"],
    lo: number,
    hi: number
  ): boolean => {
    let s: number | null = null;
    if (moment === "matin") {
      // Une activité « pas le matin » (morningOk=false, ex: la salle) honorée en
      // « matin » ne démarre jamais au petit matin : on vise la fin de matinée…
      const matinLo = act.morningOk ? lo : Math.max(lo, 10 * 60 + 30);
      s = findSportSlot(act, d, dur, place, matinLo, Math.min(11 * 60 + 30, hi));
      // …ou le creux de midi collé au dernier bloc du matin, déjeuner juste après.
      if (s === null && placeCreux(act, d, dur, place, lo, hi, "Séance (créneau demandé, creux de midi)."))
        return true;
    } else if (moment === "midi") {
      // « Avant de manger » : collée au dernier bloc du matin, déjeuner juste
      // après. Pose transactionnelle (voir placeCreux) : sans repas possible
      // derrière, la séance n'est pas posée et la décision est rejetée.
      return placeCreux(act, d, dur, place, lo, hi, "Séance (créneau demandé, avant le déjeuner).", true);
    } else {
      s = findSportSlot(act, d, dur, place, Math.max(lo, 16 * 60 + 30), hi);
    }
    if (s === null || !restOk(act, d.idx, s, s + dur)) return false;
    add(d, "sport", s, s + dur, { title: act.name, activityId: act.id, placeId: place, rationale: "Séance (créneau demandé)." });
    sportAbs.push({ actId: act.id, s: d.idx * 1440 + s, e: d.idx * 1440 + s + dur });
    return true;
  };

  for (const act of wantSport) {
    const dur = act.durationMin;
    const place = act.placeIds[0]; // undefined pour la course

    // Créneau imposé (ex: natation avec la fac) : jour + heure figés. Une
    // décision dessus ne peut pas être honorée — on le DIT plutôt que de la
    // laisser tomber en silence (vécu en test : « natation lundi midi » sans
    // trace, ni séance ni refus).
    if (act.fixedSlot) {
      const ignored = sportDecisionQueue.get(act.id)?.shift();
      if (ignored) {
        rejected.push({
          kind: "sport",
          ref: `${act.id}@${ignored.date}`,
          reason: `${act.name} a un créneau imposé par la config (${act.fixedSlot.weekday} ${act.fixedSlot.start}) : il ne se déplace pas`,
        });
      }
      const target = days.find((d) => WEEKDAYS[weekdayIdx(d.date)] === act.fixedSlot!.weekday);
      if (target) {
        const s = hhmm(act.fixedSlot.start);
        const e = hhmm(act.fixedSlot.end);
        if (!conflicts(cfg, target, s, e, place, "sport") && restOk(act, target.idx, s, e)) {
          add(target, "sport", s, e, { title: act.name, activityId: act.id, placeId: place, rationale: "Créneau imposé." });
          sportAbs.push({ actId: act.id, s: target.idx * 1440 + s, e: target.idx * 1440 + e });
        } else {
          notes.push(`${act.name} : créneau imposé (${act.fixedSlot.weekday} ${act.fixedSlot.start}) indisponible cette semaine.`);
        }
      }
      continue;
    }

    // Fenêtre praticable (heures d'ouverture ∩ bornes de journée).
    const open = act.openingHours ? hhmm(act.openingHours.open) : 0;
    const close = act.openingHours ? hhmm(act.openingHours.close) : normalEnd;

    // Décision de Josiane pour cette instance de séance : jour + moment choisis,
    // honorés si faisables ; sinon rejetée avec raison et repli sur le scoring.
    const dec = sportDecisionQueue.get(act.id)?.shift();
    if (dec) {
      const d = dayByDate.get(dec.date);
      if (!d) {
        rejected.push({ kind: "sport", ref: `${act.id}@${dec.date}`, reason: "jour hors semaine" });
      } else if (!eligibleForSport(act, d)) {
        rejected.push({ kind: "sport", ref: `${act.id}@${dec.date}`, reason: "jour non éligible (week-end ou jour Paris pour une activité hors Paris)" });
      } else if (dec.moment === "matin" && !act.morningOk && !place) {
        // « Pas le matin » ne vaut que pour une activité SANS lieu (course de
        // nuit…) : une activité à lieu peut honorer « matin » en FIN DE MATINÉE
        // (créneau creux, collé au dernier bloc du matin) — placeSportAt gère.
        rejected.push({ kind: "sport", ref: `${act.id}@${dec.date}`, reason: `${act.name} ne se pratique pas le matin` });
      } else {
        const lo = Math.max(open, d.dayStart);
        const hi = Math.min(close, normalEnd);
        if (placeSportAt(act, d, dur, place, dec.moment, lo, hi)) continue;
        rejected.push({ kind: "sport", ref: `${act.id}@${dec.date}`, reason: "aucun créneau libre au moment choisi (conflit ou récupération)" });
      }
    }

    // Jours éligibles, triés pour étaler : moins de sport d'abord, puis loin de
    // TOUTE séance déjà posée (même activité comptée double), tie-break seedé.
    // ⚠ dist doit rester FINIE : avec Infinity (aucune séance posée), toutes
    // les clés valaient -Infinity et le tri ne triait rien — le choix du jour
    // était le pur hasard du shuffle (vécu : 2 sports le même jour alors que
    // d'autres jours étaient vides).
    const lastSame = sportAbs.filter((p) => p.actId === act.id).map((p) => p.s);
    const allSport = sportAbs.map((p) => p.s);
    const distTo = (d: Day, points: number[]) =>
      points.length
        ? Math.min(...points.map((x) => Math.abs(d.idx * 1440 - x))) / 1440
        : 7; // aucune référence : distance neutre max (en jours)
    const scored = shuffled(days, rng)
      .filter((d) => eligibleForSport(act, d))
      .map((d) => {
        const sportCount = d.occ.filter((o) => o.category === "sport").length;
        // Étalement : loin des séances de la même activité (récup) ET des
        // autres séances (pas deux sports le même jour si évitable).
        const spread = distTo(d, lastSame) + distTo(d, allSport);
        // Replanification : le jour où cette séance était déjà passe devant
        // tout autre critère hors week-end — on ne redistribue pas ce que
        // l'utilisateur n'a pas demandé de bouger.
        const kept = prevSportDates.get(act.id)?.has(d.date) ? -1e5 : 0;
        // On privilégie la semaine (week-end pénalisé pour keepLight).
        return { d, key: sportCount * 1000 - spread + kept + (d.weekend ? 1e6 : 0) };
      })
      .sort((a, b) => a.key - b.key);

    let done = false;
    for (const { d } of scored) {
      const lo = Math.max(open, d.dayStart);
      const hi = Math.min(close, normalEnd);
      let s: number | null = null;
      // Le sport se fait AVANT LE DÉJEUNER, par principe : le matin quand
      // l'activité s'y prête, sinon au creux de midi, collé au dernier bloc du
      // matin, le déjeuner juste après — l'après-midi reste un grand bloc de
      // travail et on évite l'heure de pointe. Vécu : la natation tombait à
      // 14h30 par défaut les jours de cours, alors que 12h15 en sortant du
      // cours était exactement ce que voulait l'utilisateur.
      if (act.morningOk) {
        s = findSportSlot(act, d, dur, place, lo, Math.min(11 * 60 + 30, hi));
      }
      if (s === null && placeCreux(act, d, dur, place, lo, hi, "Séance de la semaine (creux de midi).", true)) {
        done = true;
        break;
      }
      if (s === null) {
        // Fin d'après-midi, AU PLUS TÔT : la séance se colle juste après le
        // travail (pas de séance à 21h qui laisse un trou béant en soirée).
        // Jamais sur le créneau du midi : une course à 12h15 après un bloc du
        // matin repoussait le déjeuner à 13h15 (vécu, semaine vide).
        const eveLo = act.morningOk ? Math.max(lo, MIDDAY.end) : Math.max(lo, 16 * 60 + 30);
        s = findSportSlot(act, d, dur, place, eveLo, hi);
      }
      if (s === null) {
        // Dernier recours : n'importe où dans la fenêtre praticable.
        s = findSportSlot(act, d, dur, place, lo, hi);
      }
      if (s === null) continue;
      if (!restOk(act, d.idx, s, s + dur)) continue;
      add(d, "sport", s, s + dur, { title: act.name, activityId: act.id, placeId: place, rationale: "Séance de la semaine." });
      sportAbs.push({ actId: act.id, s: d.idx * 1440 + s, e: d.idx * 1440 + s + dur });
      done = true;
      break;
    }
    if (!done) emit("info", `sport: impossible de caser ${act.name} cette semaine`);
  }

  /* ---------- Déjeuner (1re passe) : après le sport, AVANT Delos distant ---
   * Le Delos distant se pose « au plus tôt » : sans réservation préalable, il
   * se collait à 12h45 après un cours (trajet + crédit déjeuner) et il ne
   * restait que le fallback de 30 min pour manger. On fige d'abord un vrai
   * déjeuner sur les jours dont la matinée est occupée (le sport, lui, a déjà
   * réservé le sien quand il a pris le creux de midi). */
  for (const day of days) {
    const busyMidday = day.occ.some(
      (o) => o.category !== "sortie" && o.start < 15 * 60 && o.end > day.dayStart
    );
    if (busyMidday) reserveLunch(day);
  }

  /* ------------------ 4 bis) Heures Delos à distance -------------------- */

  // Bloc SOUPLE : horaires libres (comme tout bloc de travail), hors Paris —
  // posé APRÈS le sport, qui a des créneaux précis à respecter (creux de midi,
  // heure de pointe), là où une demi-journée distante peut aussi bien faire
  // 15h-19h que 13h-17h. Vécu : posé avant, il prenait 13h15-17h15 et
  // repoussait la salle à 17h30, en pleine cohue. Le découpage
  // n'est PAS choisi par un modèle : on essaie les gabarits déclarés du plus
  // simple au plus fractionné et on garde le premier qui rentre entièrement.
  const remoteCfg = cfg.work.delos.remote;
  if (remoteCfg && remoteCfg.hoursPerWeek > 0) {
    const totalMin = Math.round(remoteCfg.hoursPerWeek * 60);
    const remotePlace = remoteCfg.placeId;
    // Ordre des jours MÉLANGÉ par le RNG : les K candidats explorent des jours
    // différents et le score tranche (un first-fit figé posait le bloc de 4h à
    // 18h-22h le lundi dans TOUS les candidats — vécu). Semaine avant week-end,
    // qui n'est candidat que si weekendOk (dernier recours).
    // Replanification : les jours du plan précédent d'abord (à égalité de
    // week-end) — on ne redistribue pas ce que personne n'a demandé de bouger.
    const weekdays = shuffled(
      days.filter((d) => !d.weekend || cfg.work.delos.weekendOk),
      rng
    ).sort(
      (a, b) =>
        Number(a.weekend) - Number(b.weekend) ||
        Number(!prevRemoteDates.has(a.date)) - Number(!prevRemoteDates.has(b.date))
    );

    /** Ce découpage rentre-t-il en entier ? (simulation, sans rien poser) */
    const fits = (blockMin: number): boolean => {
      const count = totalMin / blockMin;
      if (!Number.isInteger(count) || count < 1) return false;
      const taken = new Set<string>();
      for (let i = 0; i < count; i++) {
        const day = weekdays.find(
          (d) =>
            !taken.has(d.date) &&
            findSlot(cfg, d, blockMin, remotePlace, "delos", d.dayStart, normalEnd) !== null
        );
        if (!day) return false;
        taken.add(day.date);
      }
      return true;
    };

    const blockMin =
      remoteCfg.blockHours.map((h) => Math.round(h * 60)).find(fits) ??
      Math.round(remoteCfg.blockHours[remoteCfg.blockHours.length - 1] * 60);

    let remoteDone = 0;
    const usedRemote = new Set<string>();

    // Décisions « distance » d'abord (et TOUTES les décisions Delos quand la
    // semaine n'a aucun présentiel : « Delos mercredi » n'a alors qu'un sens).
    // Honorées si un bloc tient dans le gabarit demandé, rejetées avec raison
    // sinon — jamais ignorées en silence.
    const remoteWindow = (d: Day, gabarit: DelosDecision["gabarit"]): [number, number] =>
      gabarit === "matin"
        ? [d.dayStart, 13 * 60]
        : gabarit === "apres-midi"
          ? [13 * 60, normalEnd]
          : [d.dayStart, normalEnd];
    for (const dec of decisions?.delos ?? []) {
      if (dec.modalite !== "distance" && nHalf > 0) continue;
      if (remoteDone + blockMin > totalMin) {
        rejected.push({ kind: "delos", ref: dec.date, reason: "volume Delos à distance déjà atteint" });
        continue;
      }
      const d = dayByDate.get(dec.date);
      if (!d) {
        rejected.push({ kind: "delos", ref: dec.date, reason: "jour hors semaine" });
        continue;
      }
      if (usedRemote.has(d.date) || delosDates.has(d.date)) continue;
      const [lo, hi] = remoteWindow(d, dec.gabarit);
      const s = findSlot(cfg, d, blockMin, remotePlace, "delos", lo, hi);
      if (s === null) {
        rejected.push({
          kind: "delos",
          ref: dec.date,
          reason: `aucun créneau de ${blockMin / 60}h à distance ce jour-là (${dec.gabarit})`,
        });
        continue;
      }
      add(d, "delos", s, s + blockMin, {
        title: "Delos (à distance)",
        placeId: remotePlace,
        rationale: `Heures Delos à distance (${blockMin / 60}h, jour demandé).`,
      });
      usedRemote.add(d.date);
      remoteDone += blockMin;
    }

    while (remoteDone + blockMin <= totalMin) {
      let posed = false;
      for (const d of weekdays) {
        if (usedRemote.has(d.date)) continue;
        const s = findSlot(cfg, d, blockMin, remotePlace, "delos", d.dayStart, normalEnd);
        if (s === null) continue;
        add(d, "delos", s, s + blockMin, {
          title: "Delos (à distance)",
          placeId: remotePlace,
          rationale: `Heures Delos à distance (${blockMin / 60}h).`,
        });
        usedRemote.add(d.date);
        remoteDone += blockMin;
        posed = true;
        break;
      }
      if (!posed) break;
    }

    if (remoteDone < totalMin) {
      notes.push(
        `${(remoteDone / 60).toFixed(1)}h de Delos à distance posées sur ${(totalMin / 60).toFixed(1)}h attendues — pas assez de créneaux libres hors Paris.`
      );
      emit("info", `delos distant : ${remoteDone / 60}h/${totalMin / 60}h`);
    }
  }

  /* -------------- 5) Déjeuner (2e passe, avant Monumia) ----------------- */

  // Les jours devenus chargés au midi depuis la 1re passe (sport posé sur le
  // créneau de midi) reçoivent leur déjeuner maintenant, avant le remplissage.
  for (const day of days) {
    const busyMidday = day.occ.some(
      (o) => o.category !== "sortie" && o.start < 15 * 60 && o.end > day.dayStart
    );
    if (busyMidday) reserveLunch(day);
  }

  /* --------------------------- 6) Monumia ------------------------------ */

  const mon = cfg.work.monumia;
  const dailyMax = mon.maxHoursPerDay * 60;
  const weekMax = mon.maxHoursPerWeek * 60;
  const weekMin = mon.minHoursPerWeek * 60;
  // Cible : imposée par l'optimiseur (grille de cibles — c'est le score qui
  // décide du volume, Monumia est la variable d'ajustement), sinon plafond si
  // maximize, sinon plancher + 2h de marge (le pas de minBlock ne doit jamais
  // nous faire retomber SOUS le plancher).
  const target = clamp(
    args.monumiaTargetHours !== undefined
      ? Math.round(args.monumiaTargetHours * 60)
      : mon.maximize
        ? weekMax
        : weekMin + 120,
    Math.min(weekMin + 120, weekMax),
    weekMax
  );
  const chunk = 240; // on pose par blocs ≤ 4h pour étaler la charge

  // Suivi hebdo/quotidien partagé avec la phase imprévus (monPlace, compteurs
  // initialisés plus haut — les blocs « autre » ne comptent pas dans Monumia).
  const perDay = monumiaPerDay;
  let weekTotal = monumiaWeekTotal;

  // Pose un bloc Monumia sur `day` (le plus tôt possible), renvoie les min posées.
  const addMonumiaBlock = (day: Day, maxDur: number): number => {
    if (maxDur < minBlock) return 0;
    const place = monPlace(day);
    if (!place) return 0;
    reserveLunch(day); // garantit un midi libre avant de remplir la journée
    const s = findSlot(cfg, day, minBlock, place, "monumia", day.dayStart, normalEnd);
    if (s === null) return 0;
    let e = s + minBlock;
    const cap = Math.min(normalEnd, s + maxDur);
    while (e + 15 <= cap && !conflicts(cfg, day, s, e + 15, place, "monumia")) e += 15;
    add(day, "monumia", s, e, { title: "Monumia", placeId: place, rationale: "Bloc de travail Monumia." });
    return e - s;
  };

  /* --------- 6b) Fusion des blocs Monumia adjacents ------------------------
   * Les phases 2 (imprévus) et 6 plafonnent chaque pose (chunk ≤ 4h, cap
   * horaire) : un même fil de Monumia au même endroit peut sortir en plusieurs
   * blocs séparés du seul battement de 15 min (13:00→17:00 puis 17:15→19:00).
   * Or le battement sert à CHANGER d'activité — pas à s'interrompre au même
   * endroit sur le même travail : on fusionne en un bloc continu (plafonné à
   * maxHoursPerDay/jour). Sans ça, le guardrail work-split lève une erreur.
   * À appeler APRÈS chaque phase de pose (imprévus, fills). */
  const mergeAdjacentMonumia = () => {
    const transition = cfg.schedule.transitionMin;
    const perDayCap = mon.maxHoursPerDay * 60;
    const minOf = (ts: string) => hhmm(ts.slice(11, 16));
    const removeBlock = (day: Day, sess: PlanSession) => {
      out.splice(out.indexOf(sess), 1);
      const oi = day.occ.findIndex((o) => o.sessionId === sess.id);
      if (oi >= 0) day.occ.splice(oi, 1);
    };
    for (const day of days) {
      const blocks = out
        .filter((s) => s.category === "monumia" && s.start.startsWith(day.date))
        .sort((a, b) => a.start.localeCompare(b.start));
      for (let i = 1; i < blocks.length; i++) {
        const prev = blocks[i - 1];
        const next = blocks[i];
        if (prev.placeId !== next.placeId) continue;
        const gap = minOf(next.start) - minOf(prev.end);
        if (gap < 0 || gap > transition) continue;
        const prevDur = minOf(prev.end) - minOf(prev.start);
        const nextDur = minOf(next.end) - minOf(next.start);
        // Plafond journalier : le bloc fusionné ne peut pas dépasser perDayCap
        // (les autres blocs du jour comptent aussi). On rogne la QUEUE du bloc
        // suivant (jamais le précédent, posé en premier = prioritaire) : seules
        // les minutes au-delà du plafond sautent — c'est exactement le trop-
        // plein produit par la passe 3 (weekdayComfort → dailyMax).
        const others = (perDay.get(day.date) ?? 0) - prevDur - nextDur;
        const merged = Math.min(prevDur + nextDur, Math.max(perDayCap - others, 0));
        if (merged <= 0) continue;
        const removed = prevDur + nextDur - merged;
        prev.end = iso(day.date, minOf(prev.start) + merged);
        const occPrev = day.occ.find((o) => o.sessionId === prev.id);
        if (occPrev) occPrev.end = minOf(prev.end);
        removeBlock(day, next);
        blocks.splice(i, 1);
        perDay.set(day.date, others + merged);
        weekTotal -= removed;
        i--; // le bloc fusionné peut être contigu au suivant
      }
    }
  };
  mergeAdjacentMonumia(); // fusionne déjà les blocs posés par la phase imprévus

  // Remplit un ensemble de jours en équilibrant (le jour le moins chargé
  // d'abord), jusqu'à `until` minutes hebdo, sans dépasser `cap`/jour.
  const fill = (pool: Day[], until: number, capPerDay: number) => {
    const stuck = new Set<string>();
    while (weekTotal < until) {
      let best: Day | null = null;
      let bestVal = Infinity;
      for (const d of pool) {
        if (stuck.has(d.date)) continue;
        const cur = perDay.get(d.date) ?? 0;
        if (cur >= capPerDay) continue;
        if (cur < bestVal) {
          bestVal = cur;
          best = d;
        }
      }
      if (!best) break;
      // Taille bornée par le plafond DUR (weekMax) et le plafond quotidien — pas
      // par la cible molle `until` : sinon le dernier bloc, rogné sous le bloc
      // minimal, serait rejeté et on resterait coincé sous le plancher.
      const room = Math.min(chunk, capPerDay - bestVal, weekMax - weekTotal);
      const placed = addMonumiaBlock(best, room);
      if (placed <= 0) {
        stuck.add(best.date);
        continue;
      }
      perDay.set(best.date, bestVal + placed);
      weekTotal += placed;
    }
  };

  const weekdayPool = days.filter((d) => !d.weekend);
  // Le week-end se remplit UN JOUR À LA FOIS, samedi d'abord : une demi-journée
  // le samedi et un dimanche LIBRE valent mieux que 2h chaque jour — le jour
  // off compte dans le score, l'équilibrage entre samedi et dimanche non. Et
  // rentrer d'un vendredi à Paris pour bosser samedi à Orsay, c'est le trajet
  // du vendredi soir, pas un samedi entier chez les parents.
  const weekendPool = days.filter((d) => d.weekend);
  const fillWeekend = (until: number) => {
    for (const d of weekendPool) {
      if (weekTotal >= until) break;
      fill([d], until, weekendCap);
    }
  };

  // Monumia est le travail le plus DÉPLAÇABLE : la semaine porte l'essentiel,
  // puis une SOUPAPE week-end (plafonnée à weekendMaxHoursPerDay/jour) absorbe
  // ce qui rendrait les journées de semaine trop denses — avant de pousser la
  // semaine au plafond dur (maxHoursPerDay). keepLight = week-end réservé au
  // strict plancher non atteignable autrement.
  const weekendCap = Math.min(mon.weekendMaxHoursPerDay * 60, dailyMax);
  // Seuil « confort » en semaine (config) : au-delà, on préfère déborder sur
  // le week-end plutôt que densifier — des journées à 8h de Monumia après 3h
  // de cours, c'est légal mais invivable. Plancher weekMin/5 : le confort ne
  // descend jamais sous ce que la semaine seule doit pouvoir porter.
  const weekdayComfort = Math.min(
    dailyMax,
    Math.max(weekMin / 5, Math.round(mon.weekdayComfortHoursPerDay * 60))
  );
  if (weekendCap > 0 && !cfg.schedule.weekend.keepLight) {
    fill(weekdayPool, target, weekdayComfort);
    if (weekTotal < target) fillWeekend(target);
    if (weekTotal < target) fill(weekdayPool, target, dailyMax);
  } else {
    fill(weekdayPool, target, dailyMax);
  }
  if (weekTotal < weekMin) fillWeekend(weekMin);
  mergeAdjacentMonumia(); // fusionne les blocs fractionnés par les fills

  if (weekTotal < weekMin) {
    notes.push(
      `Monumia : seulement ${(weekTotal / 60).toFixed(1)}h ont pu être casées sur ${(weekMin / 60)}h minimum — semaine trop contrainte (cours, indisponibilités).`
    );
  }

  /* ------------- 7) Déjeuners sans lieu : là où on se trouve -------------- */

  // Un déjeuner réservé sur une journée encore vide n'avait pas de lieu ; les
  // blocs posés depuis le situent (on mange là où on bosse). Validé par
  // conflicts() sans le repas lui-même : un lieu qui exigerait un trajet
  // impossible n'est pas attribué (le repas reste libre).
  for (const day of days) {
    for (const o of day.occ) {
      if (o.category !== "repas" || o.placeId) continue;
      const eatable = (x: Occ) => x.placeId && x.category !== "sport" && x !== o;
      const before = day.occ.filter((x) => eatable(x) && x.end <= o.start).sort((a, b) => b.end - a.end)[0];
      const after = day.occ.filter((x) => eatable(x) && x.start >= o.end).sort((a, b) => a.start - b.start)[0];
      const cands = [before?.placeId, after?.placeId, monPlace(day) ?? undefined].filter(
        (p, i, arr): p is string => !!p && arr.indexOf(p) === i
      );
      const idx = day.occ.indexOf(o);
      day.occ.splice(idx, 1);
      const place = cands.find((p) => !conflicts(cfg, day, o.start, o.end, p, "repas"));
      day.occ.splice(idx, 0, o);
      if (!place) continue;
      o.placeId = place;
      const sess = out.find((x) => x.id === o.sessionId);
      if (sess) sess.placeId = place;
    }
  }

  /* --------------------------- 8) Verdict ------------------------------ */

  out.sort((a, b) => a.start.localeCompare(b.start));
  const violations = checkWeekPlan(cfg, out, fixed, {
    requestedSorties: input.sortiesDatees,
    imprevus: input.imprevus,
    engagements: input.engagements,
  });
  emit(
    "violations",
    violations.filter((v) => v.severity === "error").map((v) => `- [${v.rule}] ${v.message}`).join("\n") ||
      "(aucune erreur)"
  );

  const warns = violations.filter((v) => v.severity === "warn").map((v) => v.message);
  const unresolved = violations
    .filter((v) => v.severity === "error")
    .map((v) => `Non résolu : ${v.message}`);

  // Trajets inter-zones : générés APRÈS le verdict (blocs d'affichage, non
  // soumis aux règles) puis fondus dans la sortie triée.
  const withTravel = [...out, ...buildTravelEvents(cfg, out, fixed, notes)].sort((a, b) =>
    a.start.localeCompare(b.start)
  );

  return {
    sessions: withTravel,
    violations,
    warnings: [...notes, ...warns, ...unresolved],
    attempts: 0,
    rejected,
  };
}
