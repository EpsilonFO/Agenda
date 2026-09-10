"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Calendar from "@/components/Calendar";
import EventModal from "@/components/EventModal";
import AgentChat from "@/components/AgentChat";
import MobileAgentBar from "@/components/MobileAgentBar";
import MobileTabBar from "@/components/MobileTabBar";
import CouncilPromptBar from "@/components/CouncilPromptBar";
import SegmentedControl from "@/components/SegmentedControl";
import SyncStatus from "@/components/SyncStatus";
import { CalendarIcon, SettingsIcon } from "@/components/icons";
import { EventItem } from "@/lib/types";
import {
  addDays,
  formatRangeLabel,
  parseIso,
  startOfDay,
  startOfWeek,
  toLocalIso,
} from "@/lib/dates";
import { useAgentChat } from "@/lib/useAgentChat";
import { useEvents } from "@/lib/useEvents";
import type { EventPayload } from "@/lib/offline";

const VIEW_OPTIONS = [
  { value: 1, label: "1J" },
  { value: 3, label: "3J" },
  { value: 7, label: "7J" },
];

export default function Home() {
  // Nombre de jours affichés (1 / 3 / 7). Défaut responsive au 1er rendu,
  // puis pilotable par le sélecteur segmenté.
  const [viewDays, setViewDays] = useState(7);
  const [anchor, setAnchor] = useState<Date>(() => startOfWeek(new Date()));
  const [modalEvent, setModalEvent] = useState<Partial<EventItem> | null>(null);
  const [councilOpen, setCouncilOpen] = useState(false);
  const pickedRef = useRef(false);

  // Agenda : serveur quand il répond, cache du téléphone sinon, plus les
  // modifications faites hors ligne qui attendent de partir (lib/useEvents).
  const store = useEvents();
  const { events } = store;

  const chat = useAgentChat(store.reload);

  // Défaut mobile : 3 jours centrés sur aujourd'hui.
  useEffect(() => {
    if (!pickedRef.current && window.matchMedia("(max-width: 1023px)").matches) {
      setViewDays(3);
      setAnchor(startOfDay(new Date()));
    }
  }, []);

  const days = Array.from({ length: viewDays }, (_, i) => addDays(anchor, i));

  function anchorFor(n: number, base: Date) {
    return n === 7 ? startOfWeek(base) : startOfDay(base);
  }

  function changeView(n: number) {
    pickedRef.current = true;
    setViewDays(n);
    // On recentre sur aujourd'hui au changement de vue (comportement attendu).
    setAnchor(anchorFor(n, new Date()));
  }

  function goToday() {
    setAnchor(anchorFor(viewDays, new Date()));
  }

  // Stats d'heures pour la semaine visible
  const weekStart = days[0]!;
  const weekEnd = addDays(days[days.length - 1]!, 1);
  const weekEvents = events.filter((ev) => {
    const d = parseIso(ev.start);
    return d >= weekStart && d < weekEnd;
  });
  function hoursFor(category: string): number {
    return weekEvents
      .filter((ev) => ev.category === category)
      .reduce(
        (acc, ev) =>
          acc +
          (parseIso(ev.end).getTime() - parseIso(ev.start).getTime()) /
            3600000,
        0
      );
  }
  function fmtHours(h: number): string {
    const whole = Math.floor(h);
    const mins = Math.round((h - whole) * 60);
    return `${whole}h${String(mins).padStart(2, "0")}`;
  }
  const monumiaHours = hoursFor("monumia");
  const sportHours = hoursFor("sport");

  // Invitations Google (à venir) pas encore répondues — rappel dans l'en-tête.
  const nowMs = Date.now();
  const pendingInvites = events
    .filter(
      (ev) => ev.google?.myResponse === "needsAction" && parseIso(ev.end).getTime() >= nowMs
    )
    .sort((a, b) => a.start.localeCompare(b.start));
  function openFirstPending() {
    const first = pendingInvites[0];
    if (!first) return;
    setAnchor(anchorFor(viewDays, parseIso(first.start)));
    setModalEvent(first);
  }

  function newEvent() {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    setModalEvent({ start: toLocalIso(start) });
  }

  return (
    <main className="mx-auto flex h-screen max-w-[1560px] flex-col gap-4 p-3 pb-[8.5rem] sm:p-4 lg:p-6 lg:pb-6">
      {/* Barre du haut (décalée sous l'encoche en PWA) */}
      <header className="glass mt-[env(safe-area-inset-top)] flex flex-wrap items-center justify-between gap-3 rounded-3xl px-3 py-2.5 sm:px-4">
        {/* Logo et nom masqués sur téléphone (l'onglet actif l'indique) : seuls
            les contrôles restent, et l'agenda gagne la ligne entière que la
            pastille occupait pour rien. */}
        <div className="hidden items-center gap-3 sm:flex">
          <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-brand-gradient text-brand-ink shadow-glow-sm">
            <CalendarIcon size={18} />
          </div>
          <div className="leading-tight">
            <h1 className="font-display text-lg font-bold tracking-tight text-ink">
              Agenda
            </h1>
            <span className="text-xs font-medium tabular-nums text-ink-soft">
              {formatRangeLabel(anchor, viewDays)}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SyncStatus state={store} />

          <SegmentedControl
            options={VIEW_OPTIONS}
            value={viewDays}
            onChange={changeView}
            ariaLabel="Nombre de jours affichés"
          />

          {pendingInvites.length > 0 && (
            <button
              onClick={openFirstPending}
              className="inline-flex items-center gap-1.5 rounded-xl border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-sm font-semibold text-amber-200 shadow-soft backdrop-blur-md transition hover:bg-amber-500/20"
              aria-label="Invitations Google en attente de réponse"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
              {pendingInvites.length} invitation{pendingInvites.length > 1 ? "s" : ""}
            </button>
          )}

          <div className="flex items-center overflow-hidden rounded-xl border border-line bg-white/[0.06] shadow-soft backdrop-blur-md">
            <button
              onClick={() => setAnchor((a) => addDays(a, -viewDays))}
              className="px-3 py-2 text-ink-soft transition hover:bg-white/10 hover:text-ink"
              aria-label="Période précédente"
            >
              ‹
            </button>
            <button
              onClick={goToday}
              className="border-x border-line px-3.5 py-2 text-sm font-semibold text-ink transition hover:bg-white/10"
            >
              Aujourd&apos;hui
            </button>
            <button
              onClick={() => setAnchor((a) => addDays(a, viewDays))}
              className="px-3 py-2 text-ink-soft transition hover:bg-white/10 hover:text-ink"
              aria-label="Période suivante"
            >
              ›
            </button>
            {/* + compact accolé à « Aujourd'hui » (mobile) pour tenir sur une ligne */}
            <button
              onClick={newEvent}
              className="border-l border-line px-3 py-2 text-base leading-none text-ink transition hover:bg-white/10 lg:hidden"
              aria-label="Nouvel événement"
            >
              +
            </button>
          </div>

          {/* Réglages : dans la barre d'onglets sur mobile, ici sur bureau */}
          <Link
            href="/reglages"
            className="hidden h-[38px] items-center gap-1.5 rounded-xl border border-line bg-white/[0.06] px-3 text-sm font-medium text-ink-soft shadow-soft backdrop-blur-md transition hover:bg-white/10 hover:text-ink lg:flex"
            aria-label="Réglages : lieux, trajets, activités"
          >
            <SettingsIcon size={16} />
            <span>Réglages</span>
          </Link>

          {/* Bouton « Réunir le conseil » (bureau) */}
          <button
            onClick={() => setCouncilOpen((v) => !v)}
            className={`hidden lg:inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-semibold shadow-soft backdrop-blur-md transition ${
              councilOpen
                ? "border-brand/50 bg-brand/15 text-brand"
                : "border-brand/40 bg-brand/10 text-brand hover:bg-brand/20"
            }`}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="5" cy="5" r="2.5" />
              <circle cx="11" cy="5" r="2.5" />
              <path d="M1 13c0-2.2 1.8-4 4-4h6c2.2 0 4 1.8 4 4" strokeLinecap="round" />
            </svg>
            Réunir le conseil
          </button>

          {/* Bouton « Événement » complet (bureau) */}
          <button onClick={newEvent} className="btn-primary hidden lg:inline-flex">
            <span className="text-base leading-none">+</span>
            <span>Événement</span>
          </button>
        </div>
      </header>

      {/* Barre de prompt Conseil (bureau) */}
      <CouncilPromptBar
        chat={chat}
        open={councilOpen}
        onClose={() => setCouncilOpen(false)}
      />

      {/* Corps : calendrier + panneau latéral (bureau) */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_368px]">
        <div className="min-h-0">
          <Calendar
            days={days}
            events={events}
            onEventClick={(ev) => setModalEvent(ev)}
            onSlotClick={(start) => {
              const end = new Date(start.getTime() + 3600000);
              setModalEvent({
                start: toLocalIso(start),
                end: toLocalIso(end),
              });
            }}
            onEventMove={store.moveEvent}
          />
        </div>

        <aside className="hidden min-h-0 flex-col gap-4 lg:flex">
          {/* Compteur d'heures */}
          <div className="glass rounded-2xl p-4">
            <div className="flex items-center gap-3">
              <div className="flex flex-1 flex-col items-center gap-0.5">
                <div
                  className="text-2xl font-bold tabular-nums"
                  style={{ color: "#8b5cf6" }}
                >
                  {fmtHours(monumiaHours)}
                </div>
                <div className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                  Monumia
                </div>
              </div>
              <div className="h-8 w-px bg-line/50" />
              <div className="flex flex-1 flex-col items-center gap-0.5">
                <div
                  className="text-2xl font-bold tabular-nums"
                  style={{ color: "#f59e0b" }}
                >
                  {fmtHours(sportHours)}
                </div>
                <div className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                  Sport
                </div>
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <AgentChat chat={chat} />
          </div>
        </aside>
      </div>

      {/* Barre de prompt de l'agenda + barre d'onglets (mobile) */}
      <MobileAgentBar chat={chat} />
      <MobileTabBar />

      {modalEvent && (
        <EventModal
          event={modalEvent}
          online={store.online}
          onClose={() => setModalEvent(null)}
          onSave={(payload: EventPayload) => {
            store.saveEvent(payload, modalEvent.id);
            setModalEvent(null);
          }}
          onDelete={() => {
            if (modalEvent.id) store.removeEvent(modalEvent.id);
            setModalEvent(null);
          }}
          onRsvped={() => {
            setModalEvent(null);
            void store.reload();
          }}
        />
      )}
    </main>
  );
}
