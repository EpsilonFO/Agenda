# 🗓️ Agenda IA

Un agenda personnel **moderne** et **facilement modifiable**, piloté par un
agent IA. Tu discutes avec l'assistant en langage naturel : il ajoute, modifie
et supprime des événements, choisit intelligemment les créneaux, et tient
compte de tes préférences enregistrées.

Le modèle est **interchangeable** : GPT, Claude, Mistral ou DeepSeek se
choisissent avec une seule variable d'environnement (voir
[Choisir son modèle](#-choisir-son-modèle)).

## ✨ Fonctionnalités

- **Vue 1 / 3 / 7 jours** commutable : un sélecteur segmenté choisit le nombre de
  jours affichés. Sur mobile, la vue **3 jours** est proposée par défaut pour un
  affichage confortable ; sur grand écran, la semaine complète.
- **Interface « Liquid Glass · Deep Teal »** : fond profond, verre dépoli
  translucide (reflet spéculaire, saturation) sur toute l'UI **sauf l'agenda**
  qui reste une surface opaque et lisible ; accent teal→cyan uniforme, ligne
  « maintenant » en temps réel, micro-interactions soignées. Événements de
  l'agenda en pastilles **opaques**. Police Manrope. Sans emoji dans l'UI.
- **Dictée vocale en direct** : le bouton micro écrit les mots dans le champ
  au fil de la parole. Deux moteurs, choisis automatiquement :
  l'**API Web Speech** du navigateur quand elle existe (Chrome, Edge, Safari,
  iOS) — instantanée, rien à télécharger, mais l'audio passe par le service de
  reconnaissance du navigateur ; sinon **Whisper en local** via
  [transformers.js](https://github.com/xenova/transformers.js) (Firefox, ou si
  le moteur navigateur échoue) — aucune donnée envoyée. L'inférence tourne
  dans un **Web Worker** (la page ne gèle jamais) et l'audio est découpé en
  segments d'environ 8 s, coupés sur un creux d'énergie puis figés une fois
  pour toutes : le coût d'une passe reste constant, même sur une longue dictée.
  Reste que Whisper en WASM mono-thread trotte derrière la parole — pour du
  vrai temps réel, Chrome ou Safari.
- **Barre de prompt** ancrée en bas de l'écran sur mobile, dépliable en une
  feuille de conversation.
- **Hors ligne (PWA)** : dans le métro ou sans réseau, l'agenda s'ouvre et
  s'affiche quand même — le service worker garde en cache la coquille de l'app
  et la dernière liste d'événements. On peut **créer, déplacer, retoucher et
  supprimer** : chaque modification est rangée dans une file d'attente sur le
  téléphone, appliquée tout de suite à l'écran (petit point clignotant sur
  l'événement), et poussée au serveur dès le retour du réseau — même après
  avoir fermé l'app. Les **agents**, eux, tournent côté serveur : ils sont
  désactivés hors ligne, avec le message qui va avec plutôt qu'une requête qui
  meurt en silence. Une pastille dans l'en-tête indique l'état (hors ligne, N
  en attente, synchronisation, échec) et propose de réessayer.
- **Édition manuelle** : clique sur un créneau pour créer un événement, clique
  sur un événement pour le modifier ou le supprimer.
- **Assistant IA** (chat) qui manipule l'agenda via *function calling* :
  - `list_events` — lit les créneaux occupés avant de planifier ;
  - `create_event`, `update_event`, `delete_event` ;
  - `remember` — enregistre une préférence durable.
- **Mémoire & préférences** : un espace où tu notes tes habitudes récurrentes
  (« pas de réunion avant 9h », « sport le mardi soir »…). Elles sont injectées
  dans le contexte de l'agent à chaque demande.
- **Stockage local en JSON** (`data/events.json`, `data/memory.json`) — aucune
  base de données à installer, éditable à la main.
- **Google Calendar (optionnel)** : synchro dans les deux sens avec un ou
  plusieurs comptes Google. Tes événements y sont copiés (les collègues te
  voient occupé, tu invites des gens depuis l'agenda ou via Josiane) et les
  invitations reçues s'affichent ici, avec réponse en un clic. Mise en place
  pas à pas : [GOOGLE.md](GOOGLE.md).

## 🚀 Démarrage

```bash
# 1. Installer les dépendances
npm install

# 2. Choisir un fournisseur et renseigner sa clé
cp .env.example .env.local
# puis, dans .env.local : LLM_MODEL=gpt-terra + OPENAI_API_KEY=…

# 3. Lancer en développement
npm run dev
```

Ouvre ensuite http://localhost:3000.

> L'agenda fonctionne sans clé (création/édition manuelle), mais l'assistant IA
> en a besoin. Le modèle actif est affiché dans la console au démarrage, avec la
> raison pour laquelle il a été retenu.

## 🔄 Choisir son modèle

Les appels LLM passent par [**providall**](https://github.com/EpsilonFO/providall) :
un registre de modèles, deux protocoles (Messages chez Anthropic,
`/chat/completions` partout ailleurs), une seule API. Changer de fournisseur,
c'est changer une ligne de `.env.local` :

```bash
LLM_MODEL=sonnet         # puis ANTHROPIC_API_KEY=…
```

`LLM_MODEL` accepte un **alias du registre** (`sonnet`, `opus`, `haiku`,
`gpt-terra`, `gpt-luna`, `ds-flash`, `ds-pro`, `mistral`, `gemini-pro`,
`grok`, `kimi-k3`, `glm`…) ou la forme `fournisseur:identifiant`
(`zai:glm-5.4-flash`) pour un modèle trop récent pour y figurer. Chaque
fournisseur lit sa propre clé : `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`,
`MOONSHOT_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`.
`providall models` liste le registre, tarifs compris.

Avec **une seule** clé posée dans `.env.local`, `LLM_MODEL` devient même
facultatif : c'est le modèle par défaut de ce fournisseur qui sert.

N'importe quel serveur parlant `/chat/completions` fait l'affaire — un modèle
local, par exemple :

```bash
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=openai_compat:qwen2.5:14b
```

Ce que providall garantit, quel que soit le fournisseur : appels d'outils, mode
JSON, effort de raisonnement ramené à l'échelle du modèle, timeout, retries sur
erreurs transitoires, coût par appel et erreurs typées. Les différences d'API
(prompt système à part chez Claude, mot « json » obligatoire chez DeepSeek,
blocs de raisonnement signés à rejouer) ne remontent jamais jusqu'ici.

Ce qui reste dans `src/lib/llm.ts` est ce qui est propre à l'agenda : la forme
des outils du reste du code, les modèles par rôle, et trois paliers d'effort —
délibérer sur une semaine et écrire deux phrases dans le chat ne méritent pas
le même prix.

## ⚙️ Configuration

| Variable                    | Défaut                | Rôle                                        |
| --------------------------- | --------------------- | ------------------------------------------- |
| `LLM_MODEL`                 | seule clé posée       | Alias du registre ou `fournisseur:identifiant` |
| `LLM_MODEL_PLANNER`, …      | `LLM_MODEL`           | Modèle d'un rôle (planner/coach/work/leisure/chef) |
| `LLM_EFFORT`                | `xhigh`               | `none`…`max` — délibération (Conseil, planner) |
| `LLM_EFFORT_CHAT`           | `medium`              | Effort de la boucle de chat (plus léger)    |
| `LLM_EFFORT_RETOUCH`        | `high`                | Effort d'une retouche ciblée de plan        |
| `LLM_MAX_TOKENS`            | défaut du modèle      | Plafond de sortie                           |
| `LLM_TIMEOUT_MS`            | `600000`              | Timeout d'un appel                          |
| `LLM_DEBUG`                 | —                     | `1` : journalise chaque appel (modèle, jetons, coût) |
| `NEXT_PUBLIC_SPEECH_LANG`   | `fr-FR`               | Langue du moteur vocal du navigateur        |
| `NEXT_PUBLIC_WHISPER_MODEL` | `Xenova/whisper-base` | Modèle Whisper local (dictée, repli)        |
| `NEXT_PUBLIC_WHISPER_LANG`  | `french`              | Langue de transcription Whisper             |

> La dictée demande l'accès au micro. Sur le moteur navigateur il n'y a rien à
> télécharger. Sur le repli Whisper, le modèle est récupéré au premier usage
> (~150 Mo pour `whisper-base`) puis mis en cache : `whisper-tiny` (~75 Mo) est
> plus rapide, `whisper-small` plus précis. Sur Firefox — seul navigateur sans
> API Web Speech — c'est toujours Whisper qui s'exécute : si le texte traîne
> trop, `Xenova/whisper-tiny` est le levier le plus direct.

## 🧱 Architecture

```
src/
├── app/
│   ├── page.tsx              # UI principale (calendrier + panneau latéral)
│   ├── layout.tsx
│   ├── globals.css
│   └── api/
│       ├── events/           # CRUD événements
│       ├── memory/           # CRUD préférences
│       └── agent/            # boucle agent LLM (function calling)
├── components/
│   ├── Calendar.tsx          # grille 1/3/7 jours + ligne "maintenant"
│   ├── SegmentedControl.tsx  # sélecteur de vue (1J / 3J / 7J)
│   ├── SyncStatus.tsx        # pastille hors ligne / file d'attente
│   ├── EventModal.tsx        # création / édition
│   ├── AgentChat.tsx         # chat (barre latérale bureau)
│   ├── MobileAgentBar.tsx    # barre de prompt + feuille (mobile)
│   ├── ChatMessages.tsx      # fil de messages partagé
│   ├── MicButton.tsx         # dictée vocale en direct
│   └── MemoryPanel.tsx       # mémoire & préférences
└── lib/
    ├── llm.ts                # llmChat() sur providall : outils, rôles, efforts
    ├── store.ts              # persistance JSON
    ├── agent.ts              # outils + orchestration de l'agent
    ├── dates.ts              # utilitaires de dates
    ├── useAgentChat.ts       # état de conversation partagé
    ├── useEvents.ts          # événements affichés (serveur + cache + file)
    ├── offline.ts            # cache local et file d'écritures hors ligne
    ├── connectivity.ts       # état en ligne / hors ligne partagé
    ├── colors.ts             # couleurs par catégorie (serveur ET navigateur)
    ├── useDictation.ts       # moteurs vocaux : Web Speech + repli Whisper
    ├── whisper.worker.ts     # inférence Whisper, hors thread principal
    ├── useDictationField.ts  # aperçu en direct dans un champ contrôlé
    └── types.ts
```

## 📴 Comment marche le hors ligne

Trois pièces, volontairement séparées :

1. **`public/sw.js`** (service worker) — met en cache la coquille de l'app
   (HTML des pages, JS/CSS de build, icônes, police) et la **dernière réponse**
   de chaque lecture d'API. Stratégie : réseau d'abord, cache en secours ; une
   réponse ressortie du cache est marquée d'un en-tête `x-agenda-cache: 1` pour
   que la page sache qu'elle lit du périmé. Les appels aux agents
   (`/api/agent`) et l'authentification ne sont jamais mis en cache : sans
   réseau, ils doivent échouer franchement.
2. **`src/lib/offline.ts`** — le cache d'événements (localStorage) et la **file
   d'attente d'écritures**. Toute modification y entre d'abord (*write-behind*),
   avec fusion des opérations redondantes : trois déplacements du même
   événement = un seul `PUT`, une retouche d'un événement pas encore créé est
   absorbée par sa création, une suppression annule les écritures en attente
   qui la précèdent. La file est rejouée dans l'ordre et persistée après chaque
   opération réussie : une coupure en plein milieu ne rejoue jamais deux fois
   la même écriture. Une écriture refusée définitivement (400, ou 404 = plus
   d'événement à modifier) est abandonnée et signalée ; un 5xx ou un 401
   (session à rafraîchir) est retenté.
3. **`src/lib/useEvents.ts`** — colle les deux : affiche l'instantané serveur
   recouvert de la file d'attente, repousse la file au retour du réseau, au
   retour de l'app au premier plan, et toutes les 15 s tant qu'il reste quelque
   chose à envoyer.

Ce qui **ne** marche pas hors ligne, et le dit : les agents et le Conseil
(appels LLM côté serveur), la réponse aux invitations Google, et
l'enregistrement des réglages.

À noter : la synchro n'est pas faite dans le service worker (Background Sync)
parce que cette API n'existe pas sur iOS — donc tout part de la page, qui
retente dès qu'elle est visible.

## 🛠️ Personnalisation rapide

- **Couleurs des catégories** : `CATEGORY_COLORS` dans `src/lib/colors.ts`
  (partagé par le stockage et l'agenda hors ligne ; `agent.ts` et `commit.ts`
  gardent leur propre liste) et le thème dans `tailwind.config.ts`.
- **Plage horaire affichée** : `DAY_START` / `DAY_END` dans
  `src/components/Calendar.tsx`.
- **Comportement de l'assistant** : le *system prompt* dans `src/lib/agent.ts`.

## 📦 Stack

Next.js 14 (App Router) · React 18 · TypeScript · Tailwind CSS · LLM au choix
(OpenAI · Anthropic · Mistral · DeepSeek · tout endpoint compatible).

## 📄 Licence

MIT — usage personnel libre.
