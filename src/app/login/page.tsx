"use client";

import { useCallback, useEffect, useState } from "react";

type Status = { configured: boolean; authenticated: boolean };

export default function LoginPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** true = on définit un mot de passe (première visite ou changement). */
  const [setup, setSetup] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/status");
      const data = (await res.json()) as Status;
      setStatus(data);
      if (data.authenticated) window.location.href = "/";
      if (!data.configured) setSetup(true); // aucun mot de passe → création
    } catch {
      setStatus({ configured: false, authenticated: false });
      setSetup(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function signIn() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Connexion refusée.");
      }
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Une erreur est survenue.");
      setBusy(false);
    }
  }

  async function savePassword() {
    setError("");
    if (password !== confirm) {
      setError("Les deux mots de passe ne correspondent pas.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, code: code.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Enregistrement refusé.");
      }
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Une erreur est survenue.");
      setBusy(false);
    }
  }

  const canSave = password.length >= 8 && confirm.length > 0 && code.trim().length > 0;

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="glass w-full max-w-sm rounded-3xl p-6">
        <h1 className="font-display text-xl font-bold tracking-tight text-ink">
          Agenda
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          {setup
            ? status?.configured
              ? "Changer le mot de passe"
              : "Choisis ton mot de passe"
            : "Entre ton mot de passe"}
        </p>

        <form
          className="mt-6 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (setup) {
              if (canSave && !busy) savePassword();
            } else if (password && !busy) {
              signIn();
            }
          }}
        >
          {/* Champ « identifiant » caché : sans lui, les gestionnaires de mots de
              passe (Trousseau, 1Password…) ne proposent pas d'enregistrer. */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value="felix"
            readOnly
            hidden
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={setup ? "Nouveau mot de passe" : "Mot de passe"}
            autoComplete={setup ? "new-password" : "current-password"}
            autoFocus
            className="field w-full"
          />

          {setup && (
            <>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Confirme le mot de passe"
                autoComplete="new-password"
                className="field w-full"
              />
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Code de secours (.env.local)"
                autoComplete="one-time-code"
                className="field w-full"
              />
            </>
          )}

          <button
            type="submit"
            disabled={busy || (setup ? !canSave : !password)}
            className="btn-primary w-full disabled:opacity-50"
          >
            {busy ? "…" : setup ? "Enregistrer le mot de passe" : "Se connecter"}
          </button>

          <p className="text-center text-xs text-ink-faint">
            Tu restes connecté sur cet appareil.
          </p>

          {status?.configured && (
            <button
              type="button"
              onClick={() => {
                setSetup(!setup);
                setError("");
                setPassword("");
                setConfirm("");
                setCode("");
              }}
              className="w-full text-xs text-ink-faint transition hover:text-ink-soft"
            >
              {setup
                ? "← Revenir à la connexion"
                : "Mot de passe oublié ? Le redéfinir avec le code de secours"}
            </button>
          )}

          {error && (
            <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}
        </form>
      </div>
    </main>
  );
}
