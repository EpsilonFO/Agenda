"use client";

import { useRef, useState } from "react";
import ChatMessages from "@/components/ChatMessages";
import MicButton from "@/components/MicButton";
import { useDictationField } from "@/lib/useDictationField";
import { useAutoGrow } from "@/lib/useAutoGrow";
import ChatModeSwitcher, { chatModeInfo } from "@/components/ChatModeSwitcher";
import { AgentChat as AgentChatState } from "@/lib/useAgentChat";
import SessionDrawer from "@/components/SessionDrawer";

/** Panneau de conversation (vue bureau, dans la barre latérale). */
export default function AgentChat({ chat }: { chat: AgentChatState }) {
  const [micError, setMicError] = useState<string | null>(null);
  const mic = useDictationField(chat.setInput);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(inputRef, mic.preview(chat.input));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const info = chatModeInfo(chat.mode);

  function submit() {
    // On envoie ce qui est affiché : le provisoire encore en cours de dictée
    // en fait partie.
    const text = mic.flush(chat.input).trim();
    if (!text) return;
    chat.send(text);
  }

  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      <div className="border-b border-line bg-white/[0.04] px-4 py-3">
        <div className="relative mb-2.5 flex items-center gap-2.5" ref={headerRef}>
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-white shadow-glow-sm"
            style={{ backgroundColor: info.color }}
          >
            <span className="text-sm font-bold">{info.title.charAt(0)}</span>
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="text-sm font-semibold text-ink">{info.title}</div>
            <div className="text-[11px] text-ink-soft">{info.subtitle}</div>
          </div>
          {/* Bouton nouvelle conversation */}
          <button
            onClick={() => chat.newConversation()}
            className="flex h-7 w-7 items-center justify-center rounded-xl border border-line text-ink-soft transition hover:bg-white/10 hover:text-ink"
            title="Nouvelle conversation"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M8 3v10M3 8h10" strokeLinecap="round"/>
            </svg>
          </button>
          {/* Bouton historique — pas pour le Conseil, dont les séances sont éphémères */}
          {chat.mode !== "council" && (
            <>
              <button
                onClick={() => setDrawerOpen((v) => !v)}
                className={`flex h-7 w-7 items-center justify-center rounded-xl border transition ${
                  drawerOpen
                    ? "border-brand/50 bg-brand/10 text-brand"
                    : "border-line text-ink-soft hover:bg-white/10 hover:text-ink"
                }`}
                title="Historique des conversations"
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="8" cy="8" r="6.5"/>
                  <path d="M8 4.5v4l2.5 1.5" strokeLinecap="round"/>
                </svg>
              </button>
              <SessionDrawer
                chat={chat}
                open={drawerOpen}
                onClose={() => setDrawerOpen(false)}
              />
            </>
          )}
        </div>
        <ChatModeSwitcher chat={chat} />
      </div>

      <ChatMessages chat={chat} />

      <div className="border-t border-line bg-white/[0.04] p-3">
        {micError && (
          <p className="mb-2 px-1 text-[11px] font-medium text-red-500">
            {micError}
          </p>
        )}
        {chat.offline && (
          <p className="mb-2 px-1 text-[11px] font-medium text-amber-300">
            Hors ligne — agents indisponibles. L&apos;agenda reste consultable
            et modifiable.
          </p>
        )}
        <div className="flex items-end gap-2">
          <MicButton
            onText={mic.onText}
            onInterim={mic.onInterim}
            onError={setMicError}
          />
          <textarea
            ref={inputRef}
            value={mic.preview(chat.input)}
            onChange={(e) => mic.onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            disabled={chat.offline}
            placeholder={
              chat.offline
                ? "Agents indisponibles hors ligne"
                : "Demande à l'assistant…"
            }
            className="field max-h-32 flex-1 resize-none overflow-y-auto disabled:opacity-60"
          />
          <button
            onClick={submit}
            disabled={chat.offline || chat.loading || !mic.preview(chat.input).trim()}
            className="btn-primary h-10 w-11 px-0 text-base"
            aria-label="Envoyer"
          >
            →
          </button>
        </div>
      </div>
    </div>
  );
}
