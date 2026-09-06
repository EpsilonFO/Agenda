/**
 * Les GUARDRAILS — le déterminisme du planificateur v2.
 *
 * Josiane (LLM) place les créneaux avec de la variété ; ces fonctions PURES
 * vérifient son planning contre la config de vie et les événements fixes.
 * Aucun LLM ici : même entrée → mêmes violations, toutes testées unitairement.
 *
 * Sémantique des gravités :
 *  - "error" → la boucle de réparation DOIT corriger (re-prompt ciblé, puis
 *    réparation mécanique) ;
 *  - "warn"  → simplement remonté à l'utilisateur.
 *
 * Choix notables :
 *  - Le trajet requis entre deux activités vient de travelMinutes(), qui
 *    respecte les modes interdits par lieu — l'interdiction de la voiture
 *    pour Delos est donc appliquée ici, sans règle séparée.
 *  - Les bornes de la journée sont LIBRES (commencer à 11h, finir à 18h) :
 *    on ne vérifie que les trous ENTRE activités, pas le remplissage.
 *  - Un trou n'existe qu'entre deux blocs COMPACTABLES (travail, cours,
 *    sport) : l'après-midi libre avant une sortie n'est pas un trou, c'est
 *    du temps à soi.
 *  - Fin de journée : normalEnd s'applique au travail et au sport ; les
 *    sorties et repas en sont exempts (un dîner ou une soirée peut finir tard).
 */

import type { LifeConfig, SportActivity } from "./config";
import { placeById, travelMinutes } from "./config";
import type { FixedItem, PlanSession, Violation } from "./types";

/* ----------------------------- Helpers temps ------------------------- */

const WEEKDAYS = [
  "dimanche",
  "lundi",
  "mardi",
  "mercredi",
  "jeudi",
  "vendredi",
  "samedi",
] as const;

function toDate(iso: string): Date {
  return new Date(iso);
}

/** Minutes depuis minuit d'un ISO local. */
function minOfDay(iso: string): number {
  const d = toDate(iso);
  return d.getHours() * 60 + d.getMinutes();
}

/** "HH:MM" → minutes depuis minuit. */
function hhmm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** "YYYY-MM-DD" décalée de `days` jours (peut être négatif). */
function addDaysIso(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function weekdayOf(iso: string): string {
  return WEEKDAYS[toDate(iso).getDay()];
}

function durationMin(s: { start: string; end: string }): number {
  return Math.round((toDate(s.end).getTime() - toDate(s.start).getTime()) / 60000);
}

function fmt(iso: string): string {
  return `${weekdayOf(iso)} ${iso.slice(11, 16)}`;
}

/** Chevauchement en minutes entre [aStart,aEnd] et [bStart,bEnd] (minutes du jour). */
function overlapMin(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/* --------------------------- Modèle interne -------------------------- */

/** Session ou événement fixe, unifiés pour les règles temporelles. */
type Item = {
  id: string;
  title: string;
  start: string;
  end: string;
  placeId?: string;
  fixed: boolean;
  /** Bloc d'indisponibilité : bloque la pose, n'exige pas de déjeuner. */
  indispo?: boolean;
  session?: PlanSession;
};

function toItems(sessions: PlanSession[], fixed: FixedItem[]): Item[] {
  return [
    ...sessions.map((s) => ({
      id: s.id,
      title: s.title,
      start: s.start,
      end: s.end,
      placeId: s.placeId,
      fixed: false,
      session: s,
    })),
    ...fixed.map((f) => ({
      id: f.id,
      title: f.title,
      start: f.start,
      end: f.end,
      placeId: f.placeId,
      fixed: true,
      indispo: f.indispo,
    })),
  ].sort((a, b) => a.start.localeCompare(b.start));
}

function byDay(items: Item[]): Map<string, Item[]> {
  const map = new Map<string, Item[]>();
  for (const it of items) {
    const key = dayKey(it.start);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(it);
  }
  return map;
}

/* ------------------------------- Règles ------------------------------ */

/** Sortie demandée par l'utilisateur — DOIT figurer au planning. */
export type RequestedSortie = { label: string; day?: string | null };

/** Imprévu/TP demandé — posé tôt dans la semaine, avec marge avant l'échéance. */
export type ImprevuRequest = { label: string; deadline?: string | null };
/** Un rendez-vous à heure fixe demandé pour la semaine (voir checkEngagements). */
export type EngagementRequest = { label: string; day: string; start: string };

type Ctx = {
  cfg: LifeConfig;
  sessions: PlanSession[];
  fixed: FixedItem[];
  items: Item[];
  days: Map<string, Item[]>;
  requestedSorties: RequestedSortie[];
  engagements: EngagementRequest[];
  out: Violation[];
};

/** Ce bloc est-il un rendez-vous à heure fixe demandé (et non du travail) ? */
function isEngagement(ctx: Ctx, s: PlanSession): boolean {
  const t = normText(s.title);
  return ctx.engagements.some((en) => {
    const label = normText(en.label);
    return t.includes(label) || label.includes(t);
  });
}

function normText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

function push(
  ctx: Ctx,
  rule: Violation["rule"],
  severity: Violation["severity"],
  message: string,
  sessionIds: string[] = []
): void {
  ctx.out.push({ rule, severity, message, sessionIds });
}

/** overlap-fixed / overlap-internal : aucun chevauchement. */
function checkOverlaps(ctx: Ctx): void {
  const items = ctx.items;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (b.start >= a.end) break; // triés par start
      if (a.fixed && b.fixed) continue; // l'existant ne nous regarde pas
      const ids = [a, b].filter((x) => !x.fixed).map((x) => x.id);
      if (a.fixed || b.fixed) {
        push(
          ctx,
          "overlap-fixed",
          "error",
          `« ${a.title} » et « ${b.title} » se chevauchent (${fmt(b.start)}) — l'événement fixe est intouchable.`,
          ids
        );
      } else {
        push(
          ctx,
          "overlap-internal",
          "error",
          `« ${a.title} » et « ${b.title} » se chevauchent (${fmt(b.start)}).`,
          ids
        );
      }
    }
  }
}

/**
 * travel-time : écart ≥ trajet requis entre lieux (modes interdits respectés
 * aux deux bouts — pas de voiture au départ de Delos), PLUS :
 *  - le déjeuner (minMinutes) si le battement tombe sur le créneau du midi —
 *    le trajet ne mange pas la pause (ex: Delos matin → Orsay aprem ≈ 70+30) ;
 *  - le tampon sport (douche, se changer) si on sort d'une séance.
 */
function checkTravel(ctx: Ctx): void {
  const lunch = ctx.cfg.schedule.lunchBreak;
  const buffer = ctx.cfg.sport.bufferAfterMin;
  const transition = ctx.cfg.schedule.transitionMin;
  // Catégories dont deux fractions contiguës au même endroit = même activité
  // (pas de battement dû). Déclaré ici : WORK_CATEGORIES, identique, vit plus bas.
  const WORK = new Set(["delos", "monumia", "autre"]);
  for (const items of ctx.days.values()) {
    // Crédit déjeuner sur un battement de midi : seulement si AUCUN repas n'est
    // posé ce jour-là — sinon on exigerait une 2e pause fantôme. MIROIR de
    // conflicts() côté solveur : les deux doivent juger pareil.
    const lunchTaken = items.some((it) => it.session?.category === "repas");
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1];
      const next = items[i];

      const gapStart = minOfDay(prev.end);
      const gapEnd = minOfDay(next.start);
      const gap = gapEnd - gapStart;

      let required = 0;
      const parts: string[] = [];
      let locSuffix = `« ${prev.title} » et « ${next.title} »`;

      // Trajet (+ déjeuner si le battement tombe à midi) : seulement quand les
      // deux lieux sont connus et diffèrent.
      if (prev.placeId && next.placeId && prev.placeId !== next.placeId) {
        const t = travelMinutes(ctx.cfg, prev.placeId, next.placeId);
        if (t) {
          required += t.minutes;
          parts.push(`${t.minutes} min de trajet en ${t.mode}`);
          if (!lunchTaken && overlapMin(gapStart, gapEnd, MIDDAY.start, MIDDAY.end) > 0) {
            required += lunch.minMinutes;
            parts.push(`${lunch.minMinutes} min pour déjeuner`);
          }
          const from = placeById(ctx.cfg, prev.placeId)?.name || prev.placeId;
          const to = placeById(ctx.cfg, next.placeId)?.name || next.placeId;
          locSuffix = `« ${prev.title} » (${from}) et « ${next.title} » (${to})`;
        }
      }
      // Tampon APRÈS une séance de sport (douche, se changer) : dû quel que soit
      // le lieu — même après la course en plein air, qui n'a pas de lieu.
      if (prev.session?.category === "sport") {
        required += buffer;
        parts.push(`${buffer} min de transition après le sport`);
      }

      // Battement minimal entre deux activités, MÊME au même endroit : un
      // cours qui finit à 17h45 n'enchaîne pas un bloc à 17h45 pile. Ne
      // s'applique pas autour des blocs « repas » (la pause EST la transition),
      // ni entre deux fractions du MÊME travail au même endroit (2×2h Delos
      // fractionné = une seule activité coupée). Un trajet déjà requis, plus
      // long, couvre le battement (max, pas somme).
      const NO_TRANSITION = new Set(["repas", "trajet"]);
      const prevCat = prev.session?.category ?? (prev.fixed ? "fixed" : undefined);
      const nextCat = next.session?.category ?? (next.fixed ? "fixed" : undefined);
      const sameWork =
        prevCat &&
        prevCat === nextCat &&
        WORK.has(prevCat) &&
        prev.session?.placeId &&
        prev.session.placeId === next.session?.placeId;
      if (
        transition > 0 &&
        required < transition &&
        !sameWork &&
        prevCat &&
        nextCat &&
        !NO_TRANSITION.has(prevCat) &&
        !NO_TRANSITION.has(nextCat)
      ) {
        required = transition;
        parts.length = 0;
        parts.push(`${transition} min de battement entre deux activités`);
      }

      if (required > 0 && gap < required) {
        push(
          ctx,
          "travel-time",
          "error",
          `${fmt(next.start)} : ${gap} min entre ${locSuffix}, il faut ≥ ${required} min (${parts.join(" + ")}).`,
          [prev, next].filter((x) => !x.fixed).map((x) => x.id)
        );
      }

      // À TRAVERS les blocs sans lieu : quand le voisin immédiat n'a pas de
      // lieu (course à pied, sortie sans zone), le trajet se mesure depuis le
      // dernier bloc LOCALISÉ, en déduisant le temps que les blocs sans lieu
      // occupent déjà (ils ne sont pas du temps de route). Vécu : cours à
      // Orsay → déjeuner « nulle part » → Delos à Paris à 14h, 60 min pour
      // 70 min de RER, invisible. MIROIR de conflicts() côté solveur.
      if (next.placeId && !prev.placeId) {
        let j = i - 1;
        while (j >= 0 && !items[j].placeId) j--;
        const anchor = j >= 0 ? items[j] : undefined;
        if (anchor && anchor.placeId !== next.placeId) {
          const t = travelMinutes(ctx.cfg, anchor.placeId!, next.placeId);
          if (t) {
            const spanS = minOfDay(anchor.end);
            const spanE = minOfDay(next.start);
            // Les blocs intercalés sont ceux qui vivent DANS le battement,
            // donc j+1..i-1 : `next` commence à la fin du span, sa propre durée
            // n'a rien à y faire. L'inclure gonflait l'exigence de la durée du
            // bloc suivant (miroir exact de busyBetween() côté solveur).
            let busy = 0;
            for (let k = j + 1; k < i; k++) busy += durationMin(items[k]);
            let need = t.minutes + busy;
            const chainParts = [`${t.minutes} min de trajet en ${t.mode}`, `${busy} min de blocs sans lieu intercalés`];
            if (!lunchTaken && overlapMin(spanS, spanE, MIDDAY.start, MIDDAY.end) > 0) {
              need += lunch.minMinutes;
              chainParts.push(`${lunch.minMinutes} min pour déjeuner`);
            }
            if (spanE - spanS < need) {
              const from = placeById(ctx.cfg, anchor.placeId!)?.name || anchor.placeId;
              const to = placeById(ctx.cfg, next.placeId)?.name || next.placeId;
              push(
                ctx,
                "travel-time",
                "error",
                `${fmt(next.start)} : ${spanE - spanS} min entre « ${anchor.title} » (${from}) et « ${next.title} » (${to}), il faut ≥ ${need} min (${chainParts.join(" + ")}).`,
                [anchor, next].filter((x) => !x.fixed).map((x) => x.id)
              );
            }
          }
        }
      }
    }
  }
}

/** work-min-block : pas de bloc de travail trop court pour être utile. */
function checkWorkBlocks(ctx: Ctx): void {
  const min = ctx.cfg.work.minBlockMinutes;
  for (const s of ctx.sessions) {
    if (s.category !== "delos" && s.category !== "monumia" && s.category !== "autre")
      continue;
    // Un rendez-vous n'est pas un bloc de travail : une inscription de 15 min
    // est exactement ce qui a été demandé, pas un créneau trop court.
    if (isEngagement(ctx, s)) continue;
    const dur = durationMin(s);
    if (dur < min) {
      push(
        ctx,
        "work-min-block",
        "error",
        `« ${s.title} » (${fmt(s.start)}) ne dure que ${dur} min — un bloc de travail fait au moins ${min} min, sinon on laisse le créneau libre.`,
        [s.id]
      );
    }
  }
}

/** cluster-pingpong : pas de Paris→Orsay→Paris dans la même journée. */
function checkPingpong(ctx: Ctx): void {
  for (const [day, items] of ctx.days) {
    const clusters: string[] = [];
    for (const it of items) {
      const c = placeById(ctx.cfg, it.placeId)?.cluster;
      if (c && clusters[clusters.length - 1] !== c) clusters.push(c);
    }
    const revisited = clusters.some((c, i) => clusters.indexOf(c) < i && clusters[i - 1] !== c);
    if (clusters.length >= 3 && revisited) {
      push(
        ctx,
        "cluster-pingpong",
        "error",
        `${weekdayOf(items[0].start)} ${day} : aller-retour entre clusters dans la même journée (${clusters.join(" → ")}) — regrouper les activités par zone.`,
        items.filter((x) => !x.fixed).map((x) => x.id)
      );
    }
  }
}

/** Catégories soumises à la fin de journée normale (les sorties/repas en sont exemptes). */
const BOUNDED_CATEGORIES = new Set(["delos", "monumia", "sport", "autre"]);

/** true si la date ISO tombe un samedi ou dimanche. */
function isWeekend(iso: string): boolean {
  const d = toDate(iso).getDay();
  return d === 0 || d === 6;
}

/** bounds-* : jamais avant dayStart (week-end : plus tard) ; travail/sport jamais après normalEnd sauf exceptionnel. */
function checkBounds(ctx: Ctx): void {
  const { schedule } = ctx.cfg;
  const normalEnd = hhmm(schedule.normalEnd);
  const exceptionalEnd = hhmm(schedule.exceptionalEnd);
  let exceptionalCount = 0;

  for (const s of ctx.sessions) {
    const weekend = isWeekend(s.start);
    const dayStartStr = weekend ? schedule.weekend.dayStart : schedule.dayStart;
    if (minOfDay(s.start) < hhmm(dayStartStr)) {
      push(
        ctx,
        "bounds-start",
        "error",
        `« ${s.title} » commence à ${s.start.slice(11, 16)} (${weekdayOf(s.start)}) — rien avant ${dayStartStr}${weekend ? " le week-end" : ""}.`,
        [s.id]
      );
    }
    if (!BOUNDED_CATEGORIES.has(s.category)) continue;
    const end = minOfDay(s.end);
    if (end > normalEnd) {
      if (s.exceptional) {
        exceptionalCount++;
        if (end > exceptionalEnd) {
          push(
            ctx,
            "bounds-end",
            "error",
            `« ${s.title} » finit à ${s.end.slice(11, 16)}, après la limite absolue ${schedule.exceptionalEnd}.`,
            [s.id]
          );
        }
      } else {
        push(
          ctx,
          "bounds-end",
          "error",
          `« ${s.title} » finit à ${s.end.slice(11, 16)} (${weekdayOf(s.end)}), après ${schedule.normalEnd} — à marquer exceptionnelle (et justifier) ou à recaler.`,
          [s.id]
        );
      }
    }
  }

  if (exceptionalCount > schedule.maxExceptionalPerWeek) {
    push(
      ctx,
      "bounds-exceptional-count",
      "error",
      `${exceptionalCount} sessions finissent après ${schedule.normalEnd} cette semaine (max ${schedule.maxExceptionalPerWeek}) — l'exceptionnel doit rester rare.`
    );
  }
}

/**
 * Plage structurelle du midi : « manger le midi » se joue autour de midi,
 * ce n'est pas une préférence configurable (la config ne fixe que les durées).
 */
export const MIDDAY = { start: 11 * 60 + 30, end: 14 * 60 + 30 };

/** lunch-break : chaque jour, un bloc libre CONTIGU ≥ minMinutes autour de midi. */
function checkLunch(ctx: Ctx): void {
  const { lunchBreak } = ctx.cfg.schedule;

  for (const [day, items] of ctx.days) {
    // Intervalles occupés dans la plage du midi. Les repas ne bloquent pas ;
    // les INDISPONIBILITÉS non plus : absent = pas un déjeuner à protéger.
    const busy: Array<[number, number]> = [];
    const covering: Item[] = [];
    for (const it of items) {
      if (it.session?.category === "repas" || it.indispo) continue;
      const s = Math.max(minOfDay(it.start), MIDDAY.start);
      const e = Math.min(minOfDay(it.end), MIDDAY.end);
      if (e > s) {
        busy.push([s, e]);
        covering.push(it);
      }
    }
    busy.sort((a, b) => a[0] - b[0]);

    // Plus grand trou libre contigu dans la plage.
    let cursor = MIDDAY.start;
    let maxFree = 0;
    for (const [s, e] of busy) {
      maxFree = Math.max(maxFree, s - cursor);
      cursor = Math.max(cursor, e);
    }
    maxFree = Math.max(maxFree, MIDDAY.end - cursor);

    if (maxFree < lunchBreak.minMinutes) {
      push(
        ctx,
        "lunch-break",
        "error",
        `${weekdayOf(items[0].start)} ${day} : aucun créneau libre de ${lunchBreak.minMinutes} min autour de midi pour déjeuner (plus grand créneau : ${maxFree} min).`,
        covering.filter((x) => !x.fixed).map((x) => x.id)
      );
    }
  }
}

/** Un bloc « compactable » participe à la densité de la journée de travail.
 *  Les sorties et repas n'en font pas partie : du temps libre avant une
 *  soirée n'est pas un trou. */
function isCompactable(it: Item): boolean {
  if (it.fixed) return true; // cours, rdv fixés
  const c = it.session!.category;
  return c === "delos" || c === "monumia" || c === "sport" || c === "autre";
}

/** big-hole : pas de trou > maxHoleMinutes ENTRE deux blocs compactables (trajet et déjeuner déduits). */
function checkHoles(ctx: Ctx): void {
  const { schedule } = ctx.cfg;
  const winStart = MIDDAY.start;
  const winEnd = MIDDAY.end;

  for (const items of ctx.days.values()) {
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1];
      const next = items[i];
      if (!isCompactable(prev) || !isCompactable(next)) continue;
      const gapStart = minOfDay(prev.end);
      const gapEnd = minOfDay(next.start);
      let gap = gapEnd - gapStart;
      if (gap <= 0) continue;
      // Déduire le trajet requis…
      if (prev.placeId && next.placeId && prev.placeId !== next.placeId) {
        const t = travelMinutes(ctx.cfg, prev.placeId, next.placeId);
        if (t) gap -= t.minutes;
      }
      // …et le crédit déjeuner si le trou touche la fenêtre.
      gap -= Math.min(
        overlapMin(gapStart, gapEnd, winStart, winEnd),
        schedule.lunchBreak.idealMinutes
      );
      if (gap > schedule.maxHoleMinutes) {
        push(
          ctx,
          "big-hole",
          "warn",
          `${fmt(prev.end)}→${next.start.slice(11, 16)} : ~${gap} min de trou entre « ${prev.title} » et « ${next.title} » (max ${schedule.maxHoleMinutes} min).`,
          [prev, next].filter((x) => !x.fixed).map((x) => x.id)
        );
      }
    }
  }
}

/**
 * delos-quota / delos-window : le volume attendu = presentielHalfDaysPerWeek gabarits + les heures à distance
 * COMPLETS (9h-13h ou 14h-18h). Le quota se compte en HEURES pour autoriser
 * le repli « 2 gabarits + la 3e coupée en 2×2h » — repli signalé (warn),
 * à éviter. Une session hors gabarits = erreur.
 */
function checkDelos(ctx: Ctx): void {
  const { delos } = ctx.cfg.work;
  const all = ctx.sessions.filter((s) => s.category === "delos");
  const windows = delos.halfDayWindows;
  const gabarits = windows.map((w) => `${w.start}-${w.end}`).join(" ou ");

  // Le présentiel se reconnaît au lieu : sur place = gabarits obligatoires ;
  // à distance = horaires libres, comme n'importe quel bloc de travail.
  const remotePlace = delos.remote?.placeId;
  const sessions = all.filter((s) => s.placeId !== remotePlace);
  const remoteSessions = remotePlace
    ? all.filter((s) => s.placeId === remotePlace)
    : [];

  const windowMin = windows.length
    ? hhmm(windows[0].end) - hhmm(windows[0].start)
    : 240;
  const presentielMin = delos.presentielHalfDaysPerWeek * windowMin;
  const remoteMin = Math.round((delos.remote?.hoursPerWeek ?? 0) * 60);
  const expectedMin = presentielMin + remoteMin;
  const totalMin = all.reduce((acc, s) => acc + durationMin(s), 0);

  if (totalMin < expectedMin) {
    push(
      ctx,
      "delos-quota",
      "error",
      `${(totalMin / 60).toFixed(1)}h de Delos posées sur ${expectedMin / 60}h attendues (${delos.presentielHalfDaysPerWeek} demi-journées de présentiel ${gabarits}${remoteMin ? ` + ${remoteMin / 60}h à distance` : ""}).`
    );
  } else if (totalMin > expectedMin) {
    push(
      ctx,
      "delos-quota",
      "warn",
      `${(totalMin / 60).toFixed(1)}h de Delos posées — ${expectedMin / 60}h suffisent, pas besoin de faire plus.`
    );
  }

  // Delos le week-end : interdit par défaut ; weekendOk (config ou override
  // hebdo) le tolère en dernier recours — signalé en warn, plus en erreur.
  const weekendSeverity = delos.weekendOk ? "warn" : "error";
  const weekendMsg = (s: { title: string; start: string }) =>
    delos.weekendOk
      ? `« ${s.title} » (${fmt(s.start)}) tombe un week-end — toléré cette semaine (weekendOk), mais ça reste un dernier recours.`
      : `« ${s.title} » (${fmt(s.start)}) tombe un week-end — Delos se pose en semaine, le week-end reste à Monumia/perso.`;

  // Les heures à distance : pas de gabarit, mais le week-end reste encadré.
  for (const s of remoteSessions) {
    if (isWeekend(s.start)) {
      push(ctx, "delos-weekend", weekendSeverity, weekendMsg(s), [s.id]);
    }
  }

  for (const s of sessions) {
    const sMin = minOfDay(s.start);
    const eMin = minOfDay(s.end);
    if (isWeekend(s.start)) {
      push(ctx, "delos-weekend", weekendSeverity, weekendMsg(s), [s.id]);
    }
    const exact = windows.some(
      (w) => sMin === hhmm(w.start) && eMin === hhmm(w.end)
    );
    if (exact) continue;
    const insideWindow = windows.some(
      (w) => sMin >= hhmm(w.start) && eMin <= hhmm(w.end)
    );
    if (insideWindow) {
      push(
        ctx,
        "delos-window",
        "warn",
        `« ${s.title} » (${fmt(s.start)}–${s.end.slice(11, 16)}) est une FRACTION de demi-journée Delos — repli à éviter, préfère les gabarits complets (${gabarits}).`,
        [s.id]
      );
    } else {
      push(
        ctx,
        "delos-window",
        "error",
        `« ${s.title} » (${fmt(s.start)}–${s.end.slice(11, 16)}) sort des gabarits Delos (${gabarits}) — les demi-journées se posent sur ces créneaux.`,
        [s.id]
      );
    }
  }
}

/** monumia-min / monumia-daily-max : plancher hebdo et plafond quotidien. */
function checkMonumia(ctx: Ctx): void {
  const { monumia } = ctx.cfg.work;
  const sessions = ctx.sessions.filter((s) => s.category === "monumia");

  const totalH = sessions.reduce((acc, s) => acc + durationMin(s), 0) / 60;
  if (totalH < monumia.minHoursPerWeek) {
    push(
      ctx,
      "monumia-min",
      "error",
      `${totalH.toFixed(1)}h de Monumia dans la semaine — minimum ${monumia.minHoursPerWeek}h.`
    );
  }
  if (totalH > monumia.maxHoursPerWeek) {
    push(
      ctx,
      "monumia-max",
      "error",
      `${totalH.toFixed(1)}h de Monumia dans la semaine — plafond ${monumia.maxHoursPerWeek}h : maximiser ne veut pas dire saturer, retire des blocs.`
    );
  }

  const perDay = new Map<string, number>();
  for (const s of sessions) {
    const key = dayKey(s.start);
    perDay.set(key, (perDay.get(key) || 0) + durationMin(s));
  }
  for (const [day, minutes] of perDay) {
    if (minutes / 60 > monumia.maxHoursPerDay) {
      push(
        ctx,
        "monumia-daily-max",
        "error",
        `${day} : ${(minutes / 60).toFixed(1)}h de Monumia sur une journée (max ${monumia.maxHoursPerDay}h).`,
        sessions.filter((s) => dayKey(s.start) === day).map((s) => s.id)
      );
    }
  }
}

/** sport-* : quotas, récupération, heures d'ouverture, créneau imposé. */
function checkSport(ctx: Ctx): void {
  const { sport } = ctx.cfg;
  const sessions = ctx.sessions
    .filter((s) => s.category === "sport")
    .sort((a, b) => a.start.localeCompare(b.start));

  if (sessions.length < sport.sessionsPerWeekMin) {
    push(
      ctx,
      "sport-quota",
      "warn",
      `${sessions.length} séance(s) de sport sur ${sport.sessionsPerWeekMin}-${sport.sessionsPerWeekMax} visées.`
    );
  } else if (sessions.length > sport.sessionsPerWeekMax) {
    push(
      ctx,
      "sport-quota",
      "warn",
      `${sessions.length} séances de sport — le max est ${sport.sessionsPerWeekMax}.`
    );
  }

  const activityOf = (s: PlanSession): SportActivity | undefined =>
    ctx.cfg.sport.activities.find((a) => a.id === s.activityId);

  // Récupération : entre deux séances de la MÊME activité.
  const byActivity = new Map<string, PlanSession[]>();
  for (const s of sessions) {
    if (!s.activityId) continue;
    if (!byActivity.has(s.activityId)) byActivity.set(s.activityId, []);
    byActivity.get(s.activityId)!.push(s);
  }
  for (const [actId, list] of byActivity) {
    const act = ctx.cfg.sport.activities.find((a) => a.id === actId);
    if (!act) continue;
    for (let i = 1; i < list.length; i++) {
      const restH =
        (toDate(list[i].start).getTime() - toDate(list[i - 1].end).getTime()) / 3600000;
      if (restH < act.minRestHours) {
        push(
          ctx,
          "sport-recovery",
          "error",
          `${act.name} : ${restH.toFixed(0)}h de repos entre ${fmt(list[i - 1].start)} et ${fmt(list[i].start)} — minimum ${act.minRestHours}h.`,
          [list[i - 1].id, list[i].id]
        );
      }
    }
  }

  for (const s of sessions) {
    const act = activityOf(s);
    if (!act) continue;

    if (act.openingHours) {
      const open = hhmm(act.openingHours.open);
      const close = hhmm(act.openingHours.close);
      if (minOfDay(s.start) < open || minOfDay(s.end) > close) {
        push(
          ctx,
          "sport-opening-hours",
          "error",
          `« ${s.title} » (${fmt(s.start)}–${s.end.slice(11, 16)}) sort des heures d'ouverture (${act.openingHours.open}–${act.openingHours.close}).`,
          [s.id]
        );
      }
    }

    if (act.fixedSlot) {
      const ok =
        weekdayOf(s.start) === act.fixedSlot.weekday &&
        s.start.slice(11, 16) === act.fixedSlot.start &&
        s.end.slice(11, 16) === act.fixedSlot.end;
      if (!ok) {
        push(
          ctx,
          "sport-fixed-slot",
          "error",
          `${act.name} a un créneau imposé (${act.fixedSlot.weekday} ${act.fixedSlot.start}-${act.fixedSlot.end}) — « ${s.title} » est posée ${fmt(s.start)}.`,
          [s.id]
        );
      }
    }
  }
}

/** work-split : pas de mini-trou entre deux blocs identiques au même endroit
 *  (« autant tout faire d'une traite ») — sauf si le trou sert de pause déjeuner. */
const WORK_CATEGORIES = new Set(["delos", "monumia", "autre"]);

function checkWorkSplit(ctx: Ctx): void {
  const { schedule } = ctx.cfg;
  for (const items of ctx.days.values()) {
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1];
      const next = items[i];
      const a = prev.session;
      const b = next.session;
      if (!a || !b) continue;
      if (a.category !== b.category || !WORK_CATEGORIES.has(a.category)) continue;
      if (!a.placeId || a.placeId !== b.placeId) continue;
      const gapStart = minOfDay(prev.end);
      const gapEnd = minOfDay(next.start);
      const gap = gapEnd - gapStart;
      if (gap <= 0 || gap > schedule.maxHoleMinutes) continue;
      // Un trou qui offre le déjeuner autour de midi est légitime.
      if (overlapMin(gapStart, gapEnd, MIDDAY.start, MIDDAY.end) >= schedule.lunchBreak.minMinutes)
        continue;
      push(
        ctx,
        "work-split",
        "error",
        `${fmt(prev.end)}→${next.start.slice(11, 16)} : ${gap} min de trou entre deux blocs « ${a.title} » au même endroit — autant tout faire d'une traite (fusionne) ou espace franchement.`,
        [a.id, b.id]
      );
    }
  }
}

/** missing-place : un bloc de travail (ou un sport à lieu défini) sans placeId
 *  rend les contrôles de trajet AVEUGLES — interdit. */
function checkMissingPlace(ctx: Ctx): void {
  for (const s of ctx.sessions) {
    if (s.placeId) continue;
    if (s.category === "delos" || s.category === "monumia") {
      push(
        ctx,
        "missing-place",
        "error",
        `« ${s.title} » (${fmt(s.start)}) n'a pas de lieu — indique le placeId (les trajets ne peuvent pas être vérifiés sans).`,
        [s.id]
      );
    } else if (s.category === "sport" && s.activityId) {
      const act = ctx.cfg.sport.activities.find((a) => a.id === s.activityId);
      if (act && act.placeIds.length > 0) {
        push(
          ctx,
          "missing-place",
          "error",
          `« ${s.title} » (${fmt(s.start)}) n'a pas de lieu alors que ${act.name} se pratique à : ${act.placeIds.join(", ")}.`,
          [s.id]
        );
      }
    }
  }
}

/** sortie-manquante : une sortie DEMANDÉE doit figurer au planning, point. */
function checkRequestedSorties(ctx: Ctx): void {
  const sorties = ctx.sessions.filter((s) => s.category === "sortie");
  for (const r of ctx.requestedSorties) {
    const found = sorties.some((s) => {
      if (r.day) return s.start.slice(0, 10) === r.day;
      const a = normText(s.title);
      const b = normText(r.label);
      return a.includes(b) || b.includes(a);
    });
    if (!found) {
      push(
        ctx,
        "sortie-manquante",
        "error",
        `La sortie demandée « ${r.label} »${r.day ? ` (${r.day})` : ""} n'est PAS au planning — elle doit y figurer, elle ne se négocie pas.`
      );
    }
  }
}

/**
 * sorties-quota : l'objectif de sorties est un RAPPEL (warn), pas une raison
 * d'inventer des soirées — sauf si autoPlace est activé dans la config.
 */
function checkSorties(ctx: Ctx): void {
  const { copine } = ctx.cfg.sorties;
  const count = ctx.sessions.filter((s) => s.category === "sortie").length;
  if (count < copine.perWeekMin) {
    push(
      ctx,
      "sorties-quota",
      copine.autoPlace ? "error" : "warn",
      copine.autoPlace
        ? `${count} sortie(s) posée(s) — minimum ${copine.perWeekMin} par semaine avec ${copine.name}.`
        : `${count} sortie(s) cette semaine — pense à en caler ${copine.perWeekMin} avec ${copine.name} (rien n'est ajouté automatiquement).`
    );
  }
}

/**
 * imprevu-deadline : un TP/imprévu à échéance doit être bouclé avec de la
 * MARGE — jamais posé le jour J ni la veille au soir. On repère les blocs par
 * leur titre (le titre d'un bloc imprévu = le label de la demande).
 */
function checkImprevus(ctx: Ctx, imprevus: ImprevuRequest[]): void {
  const margin = ctx.cfg.work.imprevus.marginDaysMin;
  for (const im of imprevus) {
    if (!im.deadline) continue;
    const limit = addDaysIso(im.deadline, -margin);
    const label = normText(im.label);
    const blocks = ctx.sessions.filter(
      (s) =>
        s.category === "autre" &&
        (normText(s.title).includes(label) || label.includes(normText(s.title)))
    );
    if (blocks.length === 0) {
      push(
        ctx,
        "imprevu-deadline",
        "error",
        `L'imprévu « ${im.label} » (pour le ${im.deadline}) n'est posé nulle part — il passe avant Monumia et le sport.`
      );
      continue;
    }
    for (const s of blocks) {
      if (dayKey(s.start) > limit) {
        push(
          ctx,
          "imprevu-deadline",
          "error",
          `« ${s.title} » (${fmt(s.start)}) est posé trop près de son échéance du ${im.deadline} — finir au plus tard le ${limit} pour gérer les imprévus.`,
          [s.id]
        );
      }
    }
  }
}

/**
 * engagement-place : un rendez-vous à heure FIXE (inscription, rdv médecin,
 * appel) doit être posé le bon jour à la bonne heure. C'est la règle qui
 * manquait : sans elle, un rendez-vous mal traduit se retrouvait un autre jour
 * et rien ne le signalait — ni au solveur, ni à l'utilisateur.
 */
function checkEngagements(ctx: Ctx): void {
  for (const en of ctx.engagements) {
    const label = normText(en.label);
    const blocks = ctx.sessions.filter(
      (s) => normText(s.title).includes(label) || label.includes(normText(s.title))
    );
    if (blocks.length === 0) {
      push(
        ctx,
        "engagement-place",
        "error",
        `Le rendez-vous « ${en.label} » (${en.day} à ${en.start}) n'est posé nulle part.`
      );
      continue;
    }
    const onTime = blocks.some(
      (s) => dayKey(s.start) === en.day && s.start.slice(11, 16) === en.start
    );
    if (!onTime) {
      push(
        ctx,
        "engagement-place",
        "error",
        `Le rendez-vous « ${en.label} » est demandé le ${en.day} à ${en.start} mais posé ${blocks
          .map((s) => fmt(s.start))
          .join(", ")} — un rendez-vous ne se déplace pas.`,
        blocks.map((s) => s.id)
      );
    }
  }
}

/* ------------------------------ Entrée ------------------------------- */

/**
 * Vérifie un plan de semaine complet. `fixed` = les événements déjà dans
 * l'agenda pour la même semaine (cours, rdv manuels). `opts.requestedSorties`
 * = les sorties explicitement demandées cette semaine (obligatoires).
 * `opts.imprevus` = les TP/imprévus demandés (blocs « autre » attendus tôt).
 * `opts.engagements` = les rendez-vous à heure fixe (posés à l'heure dite).
 */
export function checkWeekPlan(
  cfg: LifeConfig,
  sessions: PlanSession[],
  fixed: FixedItem[],
  opts?: {
    requestedSorties?: RequestedSortie[];
    imprevus?: ImprevuRequest[];
    engagements?: EngagementRequest[];
  }
): Violation[] {
  // Les trajets sont des blocs d'AFFICHAGE dérivés (générés après le verdict) :
  // ni lieu, ni quota — ils ne sont pas soumis aux règles. On les écarte pour
  // que la revue et la retouche d'un plan déjà posé ne trébuchent pas dessus.
  sessions = sessions.filter((s) => s.category !== "trajet");
  const items = toItems(sessions, fixed);
  const ctx: Ctx = {
    cfg,
    sessions,
    fixed,
    items,
    days: byDay(items),
    requestedSorties: opts?.requestedSorties ?? [],
    engagements: opts?.engagements ?? [],
    out: [],
  };

  checkOverlaps(ctx);
  checkTravel(ctx);
  checkWorkBlocks(ctx);
  checkWorkSplit(ctx);
  checkMissingPlace(ctx);
  checkPingpong(ctx);
  checkBounds(ctx);
  checkLunch(ctx);
  checkHoles(ctx);
  checkDelos(ctx);
  checkMonumia(ctx);
  checkSport(ctx);
  checkSorties(ctx);
  checkRequestedSorties(ctx);
  checkImprevus(ctx, opts?.imprevus ?? []);
  checkEngagements(ctx);

  // Les erreurs d'abord (pour la boucle de réparation), puis les warns.
  return ctx.out.sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1
  );
}
