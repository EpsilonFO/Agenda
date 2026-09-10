/**
 * Couleurs des catégories d'événements.
 *
 * Ce module ne dépend de rien (surtout pas de `fs`) : il est donc importable
 * aussi bien par le serveur (`store.ts`) que par le navigateur (agenda hors
 * ligne, qui doit colorier un événement créé sans réseau).
 */

const CATEGORY_COLORS: Record<string, string> = {
  travail: "#6366f1",
  perso: "#10b981",
  sport: "#f59e0b",
  santé: "#ef4444",
  sante: "#ef4444",
  famille: "#ec4899",
  loisir: "#06b6d4",
  delos: "#6366f1",
  monumia: "#8b5cf6",
  sortie: "#06b6d4",
  repas: "#22c55e",
  autre: "#94a3b8",
  trajet: "#f97316",
};

export function colorFor(category?: string): string {
  if (!category) return "#6366f1";
  return CATEGORY_COLORS[category.toLowerCase()] || "#6366f1";
}
