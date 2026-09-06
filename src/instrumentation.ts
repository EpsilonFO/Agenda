/**
 * Démarre le rappel des événements directement dans le process du serveur,
 * sans dépendre d'un crontab externe sur le VPS (fragile : hors git, invisible
 * si jamais installé ou perdu après une réinstall). `register()` est appelé
 * une seule fois au démarrage du serveur Next (pas pendant le build).
 *
 * Même chose pour la synchro Google Calendar : un passage au boot (après un
 * court délai) puis toutes les GOOGLE_SYNC_INTERVAL_MIN minutes (défaut 5).
 * Sans identifiants Google configurés, le passage est un no-op immédiat.
 *
 * Les imports de `./lib/reminders` (web-push → http/https/net) et de
 * `./lib/google/sync` (fs) doivent rester imbriqués dans ce `if` : Next
 * compile ce fichier à la fois pour le runtime Node et le runtime Edge, et
 * webpack n'élimine la branche morte côté Edge que si l'import est bien à
 * l'intérieur du bloc — pas après un early return.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Le modèle actif, annoncé au démarrage — avec la raison de ce choix :
    // une clé absente ou un LLM_MODEL mal orthographié se voit ici, pas au
    // premier message.
    const { describeConfig } = await import("./lib/llm");
    console.log(`[llm] ${describeConfig()}`);

    const { runReminders } = await import("./lib/reminders");
    const { runGoogleSync } = await import("./lib/google/sync");
    const { googleConfigured, syncIntervalMs } = await import("./lib/google/config");

    const CHECK_EVERY_MS = 60_000;

    const tick = async () => {
      try {
        await runReminders(new Date());
      } catch (err) {
        console.error("[reminders] échec du passage périodique:", err);
      }
    };

    tick();
    setInterval(tick, CHECK_EVERY_MS);

    if (googleConfigured()) {
      const syncTick = async () => {
        try {
          const report = await runGoogleSync();
          const failed = report.accounts.filter((a) => !a.ok);
          if (failed.length) {
            console.warn(
              `[google-sync] ${failed.length} compte(s) en échec : ${failed
                .map((a) => `${a.email} (${a.error})`)
                .join(", ")}`
            );
          }
        } catch (err) {
          console.error("[google-sync] échec du passage périodique:", err);
        }
      };
      setTimeout(syncTick, 10_000);
      setInterval(syncTick, syncIntervalMs());
    }
  }
}
