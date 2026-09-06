"use client";

import { useEffect, useRef } from "react";
import { AgentChat, ChatMsg } from "@/lib/useAgentChat";
import type {
  WeekPlan,
  PlannedSession,
  WorkoutPlan,
  MealPlan,
  CouncilMessage,
  AgentName,
} from "@/lib/types";
import { parseIso, formatFullDate, formatTime } from "@/lib/dates";
import { AGENT_META } from "@/lib/agents";
import { CheckIcon, PinIcon } from "@/components/icons";
import Markdown from "@/components/Markdown";

/* ---------------------------- Les agents ---------------------------- */

function AgentChip({ name }: { name: AgentName }) {
  const a = AGENT_META[name];
  return (
    <span className="inline-flex items-center gap-1 font-semibold" style={{ color: a.color }}>
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: a.color }}
      />
      {a.label}
    </span>
  );
}

/** La délibération visible entre les 5 agents. */
function CouncilTranscript({ messages }: { messages: CouncilMessage[] }) {
  if (!messages || messages.length === 0) return null;
  return (
    <details className="group rounded-xl border border-line bg-white/[0.04]" open>
      <summary className="cursor-pointer list-none px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
        La délibération du Conseil
      </summary>
      <ul className="space-y-1.5 px-2.5 pb-2.5">
        {messages.map((m, i) => (
          <li key={i} className="text-[11px] leading-relaxed text-ink-soft">
            <span className="inline-flex flex-wrap items-center gap-1">
              <AgentChip name={m.from} />
              <span className="text-ink-faint">→</span>
              <AgentChip name={m.to} />
              <span className="text-ink-faint">:</span>
            </span>{" "}
            <Markdown content={m.text} className="inline text-ink [&>*]:inline" />

          </li>
        ))}
      </ul>
    </details>
  );
}

/* --------------------------- Le planning ---------------------------- */

function SessionItem({
  session,
  workout,
}: {
  session: PlannedSession;
  workout?: WorkoutPlan;
}) {
  return (
    <li className="rounded-xl border border-line bg-white/[0.05] px-2.5 py-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold tabular-nums text-ink">
          {formatTime(parseIso(session.start))}–{formatTime(parseIso(session.end))}
        </span>
        <span className="text-xs text-ink">{session.title}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-soft">
        {session.placeName && (
          <span className="inline-flex items-center gap-0.5">
            <PinIcon size={11} />
            {session.placeName}
          </span>
        )}
        {session.transportMode && (
          <span>
            {session.transportMode}
            {session.travelFromPrevMin ? ` · ${session.travelFromPrevMin} min` : ""}
          </span>
        )}
      </div>
      {session.rationale && (
        <p className="mt-0.5 text-[11px] italic text-ink-faint">{session.rationale}</p>
      )}
      {workout && (workout.exercises.length > 0 || workout.tips.length > 0) && (
        <details className="mt-1">
          <summary className="cursor-pointer list-none text-[11px] font-medium text-amber-500">
            Séance de Jannik
          </summary>
          {workout.exercises.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {workout.exercises.map((e, i) => (
                <li key={i} className="text-[11px] text-ink-soft">
                  • {e}
                </li>
              ))}
            </ul>
          )}
          {workout.tips.length > 0 && (
            <p className="mt-1 text-[11px] italic text-ink-faint">
              {workout.tips.join(" · ")}
            </p>
          )}
        </details>
      )}
    </li>
  );
}

function MealItem({ meal }: { meal: MealPlan }) {
  return (
    <details className="rounded-xl border border-line bg-white/[0.05] px-2.5 py-1.5">
      <summary className="cursor-pointer list-none">
        <span className="text-[11px] font-medium uppercase tracking-wide text-pink-400">
          {meal.slot}
        </span>{" "}
        <span className="text-xs text-ink">{meal.title}</span>
      </summary>
      {meal.rationale && (
        <p className="mt-1 text-[11px] italic text-ink-faint">{meal.rationale}</p>
      )}
      {meal.ingredients.length > 0 && (
        <p className="mt-1 text-[11px] text-ink-soft">
          <span className="font-medium">Ingrédients : </span>
          {meal.ingredients
            .map((ing) => `${ing.name}${ing.qty ? ` (${ing.qty})` : ""}`)
            .join(", ")}
        </p>
      )}
      {meal.steps.length > 0 && (
        <ol className="mt-1 list-decimal space-y-0.5 pl-4">
          {meal.steps.map((s, i) => (
            <li key={i} className="text-[11px] text-ink-soft">
              {s}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

/** Carte de proposition du Conseil (à valider / ajuster). */
function PlanCard({
  plan,
  committed,
  onValidate,
  onAdjust,
  disabled,
}: {
  plan: WeekPlan;
  committed?: boolean;
  onValidate: () => void;
  onAdjust: () => void;
  disabled?: boolean;
}) {
  // Séances groupées par jour.
  const byDay = new Map<string, PlannedSession[]>();
  for (const s of plan.sessions) {
    const key = s.start.slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(s);
  }
  const days = Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const workoutByStart = new Map((plan.workouts || []).map((w) => [w.sessionStart, w]));

  // Repas groupés par jour.
  const mealsByDay = new Map<string, MealPlan[]>();
  for (const m of plan.meals || []) {
    if (!mealsByDay.has(m.day)) mealsByDay.set(m.day, []);
    mealsByDay.get(m.day)!.push(m);
  }
  const mealDays = Array.from(mealsByDay.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  const groceries = plan.groceries?.items || [];

  return (
    <div className="mt-2 space-y-3 border-t border-line pt-3">
      {/* Délibération du Conseil */}
      {plan.transcript && plan.transcript.length > 0 && (
        <CouncilTranscript messages={plan.transcript} />
      )}

      {days.length === 0 && (
        <p className="text-xs italic text-ink-faint">
          {committed
            ? "Semaine vidée — il ne reste aucune séance du plan."
            : "Aucune séance proposée — précise tes contraintes ?"}
        </p>
      )}

      {/* Planning : replié par défaut — la semaine se lit dans le calendrier,
          pas dans le fil de chat. Le détail reste à un clic. */}
      {days.length > 0 && (
        <details className="rounded-xl border border-line bg-white/[0.04]">
          <summary className="cursor-pointer list-none px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
            {plan.sessions.length} séance{plan.sessions.length > 1 ? "s" : ""} sur {days.length} jour{days.length > 1 ? "s" : ""} — voir le détail
          </summary>
          <div className="space-y-3 px-2.5 pb-2.5">
            {days.map(([day, sessions]) => (
              <div key={day}>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
                  {formatFullDate(parseIso(`${day}T12:00:00`))}
                </p>
                <ul className="space-y-1">
                  {sessions.map((s, i) => (
                    <SessionItem key={i} session={s} workout={workoutByStart.get(s.start)} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
      )}

      {plan.coachNote && (
        <p className="rounded-xl bg-brand/10 px-2.5 py-1.5 text-[11px] text-ink-soft">
          Jannik : {plan.coachNote}
        </p>
      )}

      {plan.summary && (
        <p className="text-[11px] leading-relaxed text-ink-faint">{plan.summary}</p>
      )}

      {/* Règles enfreintes : ce ne sont pas des avertissements de plus. Sans
          elles à l'écran, valider « quand même » se ferait à l'aveugle. */}
      {plan.blockingErrors && plan.blockingErrors.length > 0 && (
        <ul className="space-y-0.5 rounded-xl border border-red-500/30 bg-red-500/10 px-2.5 py-1.5">
          {plan.blockingErrors.map((e, i) => (
            <li key={i} className="text-[11px] text-red-400">
              ✕ {e}
            </li>
          ))}
        </ul>
      )}

      {plan.warnings && plan.warnings.length > 0 && (
        <ul className="space-y-0.5">
          {plan.warnings.map((w, i) => (
            <li key={i} className="text-[11px] text-amber-500">
              ⚠ {w}
            </li>
          ))}
        </ul>
      )}

      {/* Repas de Simone */}
      {mealDays.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-pink-400">
            Les repas de Simone
          </p>
          <div className="space-y-2">
            {mealDays.map(([day, meals]) => (
              <div key={day}>
                <p className="mb-0.5 text-[11px] font-medium text-ink-soft">
                  {formatFullDate(parseIso(`${day}T12:00:00`))}
                </p>
                <div className="space-y-1">
                  {meals.map((m, i) => (
                    <MealItem key={i} meal={m} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Liste de courses */}
      {groceries.length > 0 && (
        <details className="rounded-xl border border-line bg-white/[0.04]">
          <summary className="cursor-pointer list-none px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
            Liste de courses ({groceries.length})
          </summary>
          <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 px-2.5 pb-2.5">
            {groceries.map((g, i) => (
              <li key={i} className="text-[11px] text-ink-soft">
                • {g.name}
                {g.qty ? ` (${g.qty})` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}

      {committed ? (
        <p className="inline-flex items-center gap-1 text-xs font-medium text-emerald-500">
          <CheckIcon size={13} /> Ajouté à l&apos;agenda
        </p>
      ) : (
        plan.sessions.length > 0 && (
          <div className="flex gap-2">
            <button
              onClick={onValidate}
              disabled={disabled}
              className="btn-primary flex-1 justify-center disabled:opacity-50"
            >
              <CheckIcon size={14} /> Valider
            </button>
            <button
              onClick={onAdjust}
              disabled={disabled}
              className="rounded-xl border border-line bg-white/[0.06] px-3 py-2 text-sm font-medium text-ink-soft transition hover:bg-white/10 disabled:opacity-50"
            >
              Ajuster
            </button>
          </div>
        )
      )}
    </div>
  );
}

/** Fil de discussion (messages + indicateur de saisie). */
export default function ChatMessages({ chat }: { chat: AgentChat }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [chat.messages, chat.loading]);

  return (
    <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
      {chat.messages.map((m: ChatMsg, i) => (
        <div
          key={i}
          className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
        >
          <div
            className={`animate-fade-in max-w-[86%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
              m.role === "user"
                ? "rounded-br-md bg-brand-gradient text-brand-ink shadow-glow-sm"
                : "rounded-bl-md border border-line bg-white/[0.07] text-ink shadow-soft backdrop-blur-md"
            } ${m.plan ? "w-full max-w-full" : ""}`}
          >
            {m.role === "user" ? (
              <p className="whitespace-pre-wrap">{m.content}</p>
            ) : (
              <Markdown content={m.content} />
            )}

            {m.actions && m.actions.length > 0 && (
              <ul
                className={`mt-2 space-y-1 border-t pt-2 ${
                  m.role === "user" ? "border-black/10" : "border-line"
                }`}
              >
                {m.actions.map((a, j) => (
                  <li
                    key={j}
                    className={`text-[11px] ${
                      m.role === "user" ? "text-brand-ink/70" : "text-ink-soft"
                    }`}
                  >
                    ✓ {a}
                  </li>
                ))}
              </ul>
            )}

            {m.plan && (
              <PlanCard
                plan={m.plan}
                committed={m.planCommitted}
                disabled={chat.loading}
                onValidate={() => chat.commitPlan(i)}
                onAdjust={() => chat.setInput("Ajuste le plan : ")}
              />
            )}
          </div>
        </div>
      ))}

      {chat.loading && (
        <div className="flex justify-start">
          <div className="rounded-2xl rounded-bl-md border border-line bg-white/[0.07] px-4 py-3 shadow-soft backdrop-blur-md">
            <div className="flex gap-1">
              <span className="h-2 w-2 animate-bounce rounded-full bg-accent/60 [animation-delay:-0.3s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-accent/60 [animation-delay:-0.15s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-accent/60" />
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
