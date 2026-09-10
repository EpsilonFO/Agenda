"use client";

import Link from "next/link";
import { CalendarIcon } from "@/components/icons";
import { useOnline } from "@/lib/connectivity";
import LifeConfigEditor from "@/components/LifeConfigEditor";
import GoogleCalendarSettings from "@/components/GoogleCalendarSettings";
import NotificationSettings from "@/components/NotificationSettings";
import MobileTabBar from "@/components/MobileTabBar";

/**
 * Page réglages (v5) : édite data/life-config.json — la source de vérité
 * unique du planificateur déterministe. Chaque section reflète le schéma de
 * src/lib/planner/config.ts ; l'enregistrement revalide tout côté serveur.
 * Plus, en dessous : la connexion Google Calendar et les notifications.
 */
export default function ReglagesPage() {
  // Les réglages s'écrivent directement côté serveur (revalidation zod) :
  // contrairement à l'agenda, ils n'ont pas de file d'attente hors ligne.
  const online = useOnline();

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-4 pb-[8.5rem] sm:p-6 lg:pb-6">
      <header className="glass mt-[env(safe-area-inset-top)] flex items-center justify-between rounded-3xl px-4 py-3">
        <h1 className="font-display text-lg font-bold tracking-tight text-ink">
          Réglages
        </h1>
        <Link
          href="/"
          className="flex items-center gap-1.5 rounded-xl border border-line bg-white/[0.06] px-3 py-2 text-sm font-medium text-ink-soft shadow-soft backdrop-blur-md transition hover:bg-white/10 hover:text-ink"
        >
          <CalendarIcon size={16} />
          <span>Agenda</span>
        </Link>
      </header>

      {!online && (
        <p className="rounded-2xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-xs leading-snug text-amber-200">
          Hors ligne : les réglages s&apos;affichent tels qu&apos;au dernier
          chargement, mais l&apos;enregistrement attend le réseau. L&apos;agenda,
          lui, reste modifiable.
        </p>
      )}

      <LifeConfigEditor />

      <section id="google" className="glass rounded-3xl px-5 py-5">
        <h2 className="mb-3 font-display text-base font-bold tracking-tight text-ink">
          Google Calendar
        </h2>
        <GoogleCalendarSettings />
      </section>

      <section className="glass rounded-3xl px-5 py-5">
        <h2 className="mb-3 font-display text-base font-bold tracking-tight text-ink">
          Notifications
        </h2>
        <NotificationSettings />
      </section>

      <MobileTabBar />
    </main>
  );
}
