"use client";

type Option = { value: number; label: string };

/**
 * Sélecteur segmenté avec indicateur glissant.
 * Utilisé pour choisir le nombre de jours affichés (1 / 3 / 7).
 */
export default function SegmentedControl({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Option[];
  value: number;
  onChange: (value: number) => void;
  ariaLabel?: string;
}) {
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="relative flex rounded-xl border border-line bg-white/[0.06] p-1 shadow-soft backdrop-blur-md"
    >
      {/* Indicateur glissant — même largeur qu'un onglet (la zone de contenu
          vaut 100 % moins les 2 × 0.25rem de padding), décalé d'un onglet
          entier : il reste centré quel que soit l'index. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-1 left-1 rounded-lg bg-brand-gradient shadow-glow-sm transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
        style={{
          width: `calc((100% - 0.5rem) / ${options.length})`,
          transform: `translateX(${index * 100}%)`,
        }}
      />
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={`relative z-10 flex-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold tracking-wide transition-colors duration-200 sm:px-3 ${
              active ? "text-brand-ink" : "text-ink-soft hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
