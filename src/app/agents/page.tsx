"use client";

import { useCallback, useState } from "react";
import { AGENT_META } from "@/lib/agents";
import type { AgentName } from "@/lib/types";
import { useAgentChat } from "@/lib/useAgentChat";
import ChatSheet from "@/components/ChatSheet";
import MobileTabBar from "@/components/MobileTabBar";
import { SparkIcon, UsersIcon } from "@/components/icons";

/** Les agents nommés avec lesquels on peut discuter (l'agenda a sa propre barre). */
const AGENTS: AgentName[] = ["emilien", "jannik", "djimo", "simone"];

export default function AgentsPage() {
  const noop = useCallback(() => {}, []);
  const chat = useAgentChat(noop);
  const [open, setOpen] = useState(false);

  function openAgent(name: AgentName) {
    chat.setMode(name);
    setOpen(true);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-3 pb-[7rem] sm:p-4 lg:p-6 lg:pb-6">
      <header className="glass mt-[env(safe-area-inset-top)] flex items-center gap-3 rounded-3xl px-4 py-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-brand-gradient text-brand-ink shadow-glow-sm">
          <UsersIcon size={18} />
        </span>
        <div className="leading-tight">
          <h1 className="font-display text-lg font-bold tracking-tight text-ink">
            Agents
          </h1>
          <span className="text-xs font-medium text-ink-soft">
            Choisis avec qui discuter
          </span>
        </div>
      </header>

      {chat.offline && (
        <p className="rounded-2xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-xs leading-snug text-amber-200">
          Hors ligne : les agents tournent côté serveur, ils reviendront avec le
          réseau. L&apos;agenda, lui, reste consultable et modifiable.
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {AGENTS.map((name) => {
          const a = AGENT_META[name];
          return (
            <button
              key={name}
              onClick={() => openAgent(name)}
              className="panel flex items-start gap-3 p-4 text-left transition active:scale-[0.98]"
            >
              <span
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white shadow-glow-sm"
                style={{ backgroundColor: a.color }}
              >
                <span className="text-lg font-bold">{a.label.charAt(0)}</span>
              </span>
              <div className="min-w-0">
                <div className="font-semibold text-ink">{a.label}</div>
                <div className="text-xs capitalize text-ink-soft">{a.role}</div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-ink-faint">
                  {a.welcome}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Séance du Conseil : les 5 agents planifient la semaine ensemble. */}
      <button
        onClick={() => {
          chat.startCouncil();
          setOpen(true);
        }}
        className="panel flex items-center gap-3 border-brand/30 p-4 text-left transition active:scale-[0.98]"
      >
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-gradient text-brand-ink shadow-glow-sm">
          <SparkIcon size={22} />
        </span>
        <div className="min-w-0">
          <div className="font-semibold text-ink">Réunir le Conseil</div>
          <p className="mt-0.5 text-[11px] leading-snug text-ink-faint">
            Les agents organisent toute ta semaine ensemble — travail, sport,
            loisir, repas.
          </p>
        </div>
      </button>

      <ChatSheet chat={chat} open={open} onClose={() => setOpen(false)} />
      <MobileTabBar />
    </main>
  );
}
