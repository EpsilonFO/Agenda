export type EventItem = {
  id: string;
  title: string;
  /** ISO 8601, ex: 2026-07-14T09:00:00 */
  start: string;
  /** ISO 8601 */
  end: string;
  description?: string;
  location?: string;
  /** Catégorie libre : "travail", "sport", "perso"... */
  category?: string;
  /** Couleur hex de la pastille, ex: #6366f1 */
  color?: string;
  /**
   * "plan" si créé par le Conseil (permet de réécrire une semaine sans doublon) ;
   * "google" si importé depuis Google Calendar (invitation reçue, événement
   * créé côté Google). Absent = créé à la main / par Josiane.
   */
  source?: "plan" | "google";
  /** Invités (emails). Non vide + `invite` = invitation Google envoyée. */
  attendees?: Attendee[];
  /** Invitation Google portée par cet événement local (compte qui envoie les mails). */
  invite?: InviteInfo;
  /** Lien vers l'événement Google d'origine (uniquement si source = "google"). */
  google?: GoogleOrigin;
  /** Préavis de rappel en minutes avant le début (ex: 60 = 1h avant). Si absent, utilise le défaut global REMINDER_LEAD_MIN. */
  reminderMin?: number;
  /**
   * Marqueur posé UNIQUEMENT côté navigateur : cet événement porte une
   * modification faite hors ligne, pas encore poussée au serveur (voir
   * lib/offline.ts). Jamais écrit dans data/events.json.
   */
  pendingSync?: boolean;
  createdAt: string;
  updatedAt: string;
};

/* ------------------------ Google Calendar --------------------------- */

export type AttendeeResponse = "needsAction" | "accepted" | "declined" | "tentative";

export type Attendee = {
  email: string;
  displayName?: string;
  responseStatus?: AttendeeResponse;
  /** true = c'est l'utilisateur lui-même (dans le calendrier Google concerné). */
  self?: boolean;
  organizer?: boolean;
  optional?: boolean;
};

/** Invitation envoyée DEPUIS l'agenda : quel compte Google porte l'événement. */
export type InviteInfo = {
  accountId: string;
  /** Renseignés par la synchro une fois la copie Google créée. */
  eventId?: string;
  htmlLink?: string;
  sentAt?: string;
};

/** Métadonnées d'un événement importé de Google Calendar. */
export type GoogleOrigin = {
  accountId: string;
  calendarId: string;
  eventId: string;
  etag?: string;
  /** Champ `updated` Google (ISO UTC) vu au dernier passage de synchro. */
  updated?: string;
  /** Horodatage (ISO UTC) du dernier sync qui a écrit cet événement localement. */
  syncedAt: string;
  htmlLink?: string;
  status?: "confirmed" | "tentative" | "cancelled";
  organizer?: { email?: string; displayName?: string; self?: boolean };
  /** Réponse de l'utilisateur à l'invitation (absent s'il est l'organisateur). */
  myResponse?: AttendeeResponse;
  recurringEventId?: string;
  iCalUID?: string;
};

export type MemoryItem = {
  id: string;
  content: string;
  createdAt: string;
};

/* ----------------------- Lieux & déplacements ----------------------- */

export type Place = {
  id: string;
  name: string;
  /** Type libre : domicile, travail, sport, famille… */
  type?: string;
  /** true pour le point de départ par défaut (domicile principal). */
  isHome?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TransportMode = "à pied" | "vélo" | "voiture" | "métro" | "train" | "bus";

export type TravelTime = {
  id: string;
  fromId: string;
  toId: string;
  minutes: number;
  mode: string;
  updatedAt: string;
};

/* -------------------------- Activités --------------------------------- */

export type SportInfo = {
  intensity: "low" | "moderate" | "high";
  /** Repos minimal conseillé après cette séance, en heures. */
  minRestHoursAfter: number;
  /** Groupes musculaires sollicités (optionnel, pour le coach). */
  muscleGroups?: string[];
};

/**
 * Une activité *flexible* que le planificateur peut caser dans la semaine
 * (salle, piscine, voir sa copine, heures de CDD…). Les activités *fixes*
 * (cours, sport de groupe) restent de simples événements dans events.json.
 */
export type Activity = {
  id: string;
  name: string;
  category?: string;
  placeId?: string;
  durationMin: number;
  /** Nombre de séances visées par semaine. */
  perWeek?: number;
  /** Créneaux préférés : "morning" | "afternoon" | "evening" | jour… (texte libre). */
  preferredWindows?: string[];
  /** Modes de transport possibles pour s'y rendre. */
  transportModes?: string[];
  /** Métadonnées de récupération si c'est du sport. */
  sport?: SportInfo;
  /** Heures d'ouverture du lieu (ex: salle, piscine) — HH:MM, appliquées chaque jour. */
  openingHours?: { open: string; close: string };
  createdAt: string;
  updatedAt: string;
};

export type TransportProfile = {
  /** Modes de transport dont l'utilisateur dispose par défaut. */
  transportModes: string[];
  /** true si la voiture est disponible par défaut (souvent non). */
  carDefault: boolean;
  /** Lieu de départ principal. */
  homePlaceId?: string;
  /** Objectif d'heures de travail flexible par semaine (CDD…). */
  workHoursTarget?: number;
  /** Aliments que l'utilisateur n'aime pas / à éviter (Simone les bannit). */
  dislikedFoods?: string[];
};

/* ------------------------ Les agents (chats) ------------------------- */

/** Les 5 agents nommés. Depuis la v5, ils ne participent plus à la
 *  planification : emilien/jannik/djimo/simone sont des chats 1-à-1
 *  (lecture seule), josiane gère l'agenda et la retouche. */
export type AgentName = "emilien" | "jannik" | "djimo" | "simone" | "josiane";

/** LEGACY (≤ v4) — un message de la délibération du Conseil. Plus jamais
 *  produit : conservé pour AFFICHER les plans historiques stockés. */
export type CouncilMessage = {
  from: AgentName;
  to: AgentName;
  text: string;
  /** Tour de délibération (0 = première passe, 1 = négociation…). */
  round: number;
};

/** LEGACY (≤ v4) — détail sportif d'une séance (exercices de Jannik).
 *  Plus jamais produit : lecture seule des plans historiques. */
export type WorkoutPlan = {
  /** start ISO de la séance concernée (clé de rapprochement). */
  sessionStart: string;
  title: string;
  intensity?: "low" | "moderate" | "high";
  /** Exercices concrets à faire pendant la séance. */
  exercises: string[];
  /** Conseils du coach (échauffement, récup, hydratation…). */
  tips: string[];
};

export type Ingredient = { name: string; qty?: string };

/** LEGACY (≤ v4) — un repas proposé par Simone. Plus jamais produit. */
export type MealPlan = {
  /** Jour concerné, YYYY-MM-DD. */
  day: string;
  /** Moment : "petit-déj" | "déjeuner" | "dîner" | "collation"… */
  slot: string;
  title: string;
  /** Étapes de la recette. */
  steps: string[];
  ingredients: Ingredient[];
  /** Pourquoi ce plat ce jour-là (lien avec la charge sportive/travail). */
  rationale?: string;
};

/** Liste de courses consolidée pour la semaine. */
export type GroceryList = {
  items: { name: string; qty?: string; aisle?: string }[];
};

/* ------------------------ Plan de semaine ---------------------------- */

/** Une séance proposée par le planificateur (non encore écrite dans l'agenda). */
export type PlannedSession = {
  /** id stable de session (v2) — utilisé par la retouche par opérations. */
  id?: string;
  activityId?: string;
  title: string;
  placeId?: string;
  /** Nom lisible du lieu (dénormalisé pour l'affichage). */
  placeName?: string;
  /** ISO local, ex: 2026-07-20T18:00:00 */
  start: string;
  end: string;
  category?: string;
  /** Mode de transport pour venir depuis la séance/lieu précédent. */
  transportMode?: string;
  /** Minutes de trajet depuis le point précédent. */
  travelFromPrevMin?: number;
  /** Justification courte du placement (trajet, récup…). */
  rationale?: string;
};

export type WeekPlan = {
  weekStart: string;
  /** Toutes les séances placées (travail, sport, loisir) par le solveur. */
  sessions: PlannedSession[];
  /** LEGACY (≤ v4) — plus jamais produits depuis la v5, conservés pour
   *  afficher les plans historiques stockés : */
  workouts?: WorkoutPlan[];
  meals?: MealPlan[];
  groceries?: GroceryList;
  transcript?: CouncilMessage[];
  coachNote?: string;
  /** Avertissements résiduels (récup, conflits, heures non casées…). */
  warnings?: string[];
  /** Règles ENCORE VIOLÉES par le meilleur candidat du solveur : un tel plan
   *  n'est pas appliqué automatiquement, l'utilisateur tranche. */
  blockingErrors?: string[];
  /** true une fois le plan écrit dans l'agenda. */
  committed?: boolean;
  /** La demande hebdo STRUCTURÉE qui a produit ce plan (v5.1) — c'est elle
   *  qu'une replanification (« décale ma muscu à jeudi ») patche puis
   *  re-résout. Absente sur les plans historiques. */
  input?: import("./planner/contracts").WeekInput;
  /** Résumé lisible du verdict du solveur (volumes, trajets, candidats). */
  summary?: string;
  /** Replanification qui n'a RIEN changé (patch vide ou plan identique) : le
   *  greffier doit le dire au lieu d'annoncer une correction fantôme. */
  unchanged?: boolean;
};

export type ChatMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** présent pour role=assistant quand le modèle appelle des outils */
  tool_calls?: unknown;
  /** présent pour role=tool */
  tool_call_id?: string;
  name?: string;
};

export type AgentResponse = {
  reply: string;
  /** Résumé lisible des actions menées sur l'agenda */
  actions: string[];
  /** true si l'agenda a été modifié et doit être rechargé côté client */
  changed: boolean;
  /** Plan de semaine proposé (à valider) — non encore écrit dans l'agenda. */
  plan?: WeekPlan;
};

/* ----------------------- Historique de conversation ------------------- */

/**
 * Un message persisté dans chat-history.json.
 * role "summary" = résumé automatique injecté en tête de contexte.
 */
export type ChatHistoryEntry = {
  role: "user" | "assistant" | "summary";
  content: string;
  /** Actions effectuées sur l'agenda (pour les messages assistant). */
  actions?: string[];
  /** ISO de l'envoi. */
  createdAt: string;
};

/* ----------------------------- Sessions -------------------------------- */

export type Session = {
  id: string;
  /** Mode auquel appartient cette session (ex: "agenda", "josiane"…). */
  mode: string;
  /** Titre généré automatiquement par l'IA au premier message. */
  title: string;
  createdAt: string;
  updatedAt: string;
};
