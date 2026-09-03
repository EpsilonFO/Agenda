"use client";

import { useEffect, useRef, useState } from "react";
import ChatMessages from "@/components/ChatMessages";
import MicButton from "@/components/MicButton";
import { useDictationField } from "@/lib/useDictationField";
import ChatModeSwitcher, { chatModeInfo } from "@/components/ChatModeSwitcher";
import SessionDrawer from "@/components/SessionDrawer";
import type { AgentChat } from "@/lib/useAgentChat";

/**
 * Feuille de conversation qui remonte du bas (mobile).
 * Partagée par la barre de l'agenda et l'onglet Agents.
 */
export default function ChatSheet({
  chat,
  open,
  onClose,
  showSwitcher = false,
  header,
}: {
  chat: AgentChat;
  open: boolean;
  onClose: () => void;
  /** Affiche la rangée de sélection d'agents en tête. */
  showSwitcher?: boolean;
  /** Force le titre/sous-titre/couleur ; sinon dérivé du mode actif. */
  header?: { title: string; subtitle: string; color: string };
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const mic = useDictationField(chat.setInput);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const info = header ?? chatModeInfo(chat.mode);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  function submit() {
    // On envoie ce qui est affiché : le provisoire encore en cours de dictée
    // en fait partie.
    const text = mic.flush(chat.input).trim();
    if (!text) return;
    chat.send(text);
  }

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="animate-fade-in absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className="glass-strong animate-slide-up absolute inset-x-0 bottom-0 flex max-h-[88vh] flex-col rounded-t-4xl"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {/* Poignée */}
        <div className="flex justify-center pt-2.5">
          <span className="h-1.5 w-10 rounded-full bg-ink-faint/40" />
        </div>

        <div className="flex items-center justify-between px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-9 w-9 items-center justify-center rounded-2xl text-white shadow-glow-sm"
              style={{ backgroundColor: info.color }}
            >
              <span className="text-sm font-bold">{info.title.charAt(0)}</span>
            </span>
            <div className="leading-tight">
              <div className="text-sm font-semibold text-ink">{info.title}</div>
              <div className="text-[11px] text-ink-soft">{info.subtitle}</div>
            </div>
          </div>
          <div className="relative flex items-center gap-1.5">
            <button
              onClick={() => {
                setDrawerOpen(false);
                chat.newConversation();
              }}
              className="btn-icon h-9 w-9"
              aria-label="Nouvelle conversation"
              title="Nouvelle conversation"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M8 3v10M3 8h10" strokeLinecap="round" />
              </svg>
            </button>
            {/* Historique — pas pour le Conseil, dont les séances sont éphémères */}
            {chat.mode !== "council" && (
              <button
                onClick={() => setDrawerOpen((v) => !v)}
                className={`btn-icon h-9 w-9 ${
                  drawerOpen ? "border-brand/50 text-brand" : ""
                }`}
                aria-label="Historique des conversations"
                title="Historique des conversations"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="8" cy="8" r="6.5" />
                  <path d="M8 4.5v4l2.5 1.5" strokeLinecap="round" />
                </svg>
              </button>
            )}
            <button
              onClick={onClose}
              className="btn-icon h-9 w-9 text-base"
              aria-label="Fermer"
            >
              ×
            </button>
            {chat.mode !== "council" && (
              <SessionDrawer
                chat={chat}
                open={drawerOpen}
                onClose={() => setDrawerOpen(false)}
              />
            )}
          </div>
        </div>

        {showSwitcher && (
          <div className="px-4 pb-2">
            <ChatModeSwitcher chat={chat} />
          </div>
        )}

        <div className="border-t border-line" />
        <ChatMessages chat={chat} />

        <div className="border-t border-line p-3">
          {micError && (
            <p className="mb-2 px-1 text-[11px] font-medium text-red-500">
              {micError}
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
              placeholder="Écris ton message…"
              className="field max-h-32 flex-1 resize-none"
            />
            <button
              onClick={submit}
              disabled={chat.loading || !mic.preview(chat.input).trim()}
              className="btn-primary h-10 w-11 px-0 text-base"
              aria-label="Envoyer"
            >
              →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
