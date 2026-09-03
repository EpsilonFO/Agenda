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
# puis, dans .env.local : LLM_PROVIDER=openai + OPENAI_API_KEY=…

# 3. Lancer en développement
npm run dev
```

Ouvre ensuite http://localhost:3000.

> L'agenda fonctionne sans clé (création/édition manuelle), mais l'assistant IA
> en a besoin. Le provider actif est affiché dans la console au démarrage.

## 🔄 Choisir son modèle

Une seule ligne de `.env.local` décide du fournisseur — le modèle par défaut,
l'URL et le format d'API suivent :

```bash
LLM_PROVIDER=claude      # puis ANTHROPIC_API_KEY=…
```

| `LLM_PROVIDER`  | Alias      | Clé attendue        | Modèle par défaut      | API             |
| --------------- | ---------- | ------------------- | ---------------------- | --------------- |
| `openai`        | `chatgpt`  | `OPENAI_API_KEY`    | `gpt-5.6-terra`        | Responses       |
| `anthropic`     | `claude`   | `ANTHROPIC_API_KEY` | `claude-sonnet-5`      | Messages        |
| `mistral`       | —          | `MISTRAL_API_KEY`   | `mistral-large-latest` | chat/completions|
| `deepseek`      | —          | `DEEPSEEK_API_KEY`  | `deepseek-chat`        | chat/completions|
| `openai-compat` | `local`, `localmodel`, `ollama`, `qwen`, `groq`, `openrouter`, `together` | `LLM_API_KEY` (facultative) | `LLM_MODEL` (requis) | chat/completions |

`openai-compat` accepte n'importe quel endpoint parlant le dialecte
`/chat/completions` — un modèle local suffit :

```bash
LLM_PROVIDER=localmodel
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen2.5:14b
```

Les alias ne changent que la lisibilité de ta config : ils désignent tous
`openai-compat`, et `LLM_MODEL` reste à renseigner dans tous les cas.

Ce que la couche `src/lib/llm/` garantit, quel que soit le fournisseur :
appels d'outils, mode JSON, effort de raisonnement, timeout et retries sur
erreurs transitoires. Les différences d'API (prompt système à part chez
Claude, outils aplatis chez OpenAI, mot « json » obligatoire chez DeepSeek,
blocs de raisonnement à rejouer) sont absorbées par le provider concerné —
le reste du code ne les voit jamais.

**Ajouter un fournisseur** : une entrée dans `PROVIDERS`
(`src/lib/llm/providers/index.ts`). S'il parle `/chat/completions`, il réutilise
la fonction `chatCompletions` existante et ne demande aucun code.

## ⚙️ Configuration

| Variable                    | Défaut                | Rôle                                        |
| --------------------------- | --------------------- | ------------------------------------------- |
| `LLM_PROVIDER`              | `openai`              | Fournisseur actif (tableau ci-dessus)       |
| `LLM_MODEL`                 | défaut du provider    | Surcharge globale du modèle                 |
| `LLM_MODEL_PLANNER`, …      | `LLM_MODEL`           | Modèle d'un rôle (planner/coach/work/…)     |
| `LLM_REASONING_EFFORT`      | `xhigh`               | `none`…`max` — ignoré si le modèle n'en a pas |
| `LLM_REASONING_EFFORT_CHAT` | `medium`              | Effort de la boucle de chat (plus léger)    |
| `LLM_MAX_TOKENS`            | `8192`                | Plafond de sortie (obligatoire chez Claude) |
| `LLM_TIMEOUT_MS`            | `600000`              | Timeout d'un appel                          |
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
│   ├── EventModal.tsx        # création / édition
│   ├── AgentChat.tsx         # chat (barre latérale bureau)
│   ├── MobileAgentBar.tsx    # barre de prompt + feuille (mobile)
│   ├── ChatMessages.tsx      # fil de messages partagé
│   ├── MicButton.tsx         # dictée vocale en direct
│   └── MemoryPanel.tsx       # mémoire & préférences
└── lib/
    ├── llm/                  # couche multi-provider (voir « Choisir son modèle »)
    │   ├── index.ts          # llmChat() — seul point d'entrée du reste du code
    │   ├── env.ts            # LLM_PROVIDER, modèles par rôle, effort
    │   ├── http.ts           # timeout, retries, lecture SSE
    │   └── providers/        # openai · anthropic · chat-completions
    ├── store.ts              # persistance JSON
    ├── agent.ts              # outils + orchestration de l'agent
    ├── dates.ts              # utilitaires de dates
    ├── useAgentChat.ts       # état de conversation partagé
    ├── useDictation.ts       # moteurs vocaux : Web Speech + repli Whisper
    ├── whisper.worker.ts     # inférence Whisper, hors thread principal
    ├── useDictationField.ts  # aperçu en direct dans un champ contrôlé
    └── types.ts
```

## 🛠️ Personnalisation rapide

- **Couleurs des catégories** : `CATEGORY_COLORS` dans `src/lib/agent.ts` et le
  thème dans `tailwind.config.ts`.
- **Plage horaire affichée** : `DAY_START` / `DAY_END` dans
  `src/components/Calendar.tsx`.
- **Comportement de l'assistant** : le *system prompt* dans `src/lib/agent.ts`.

## 📦 Stack

Next.js 14 (App Router) · React 18 · TypeScript · Tailwind CSS · LLM au choix
(OpenAI · Anthropic · Mistral · DeepSeek · tout endpoint compatible).

## 📄 Licence

MIT — usage personnel libre.
