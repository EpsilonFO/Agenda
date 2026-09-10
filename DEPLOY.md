# Déploiement sur ton VPS (accès iPhone + notifications)

Objectif : app installable sur l'iPhone (PWA) + rappels push avant chaque événement.
Pré-requis côté toi : un VPS Linux avec **nginx** déjà en place et un **sous-domaine**
que tu peux pointer vers le VPS (ex. `agenda.tondomaine.fr`).

Remplace partout `agenda.tondomaine.fr`, `TON_USER`, le port, etc.

---

## 0. DNS (à faire en premier, ça met quelques minutes à se propager)

Chez ton registrar / ta zone DNS, crée un enregistrement :

```
Type: A    Nom: agenda    Valeur: <IP publique du VPS>
```

Vérifie : `dig +short agenda.tondomaine.fr` doit renvoyer l'IP du VPS.

---

## 1. Fuseau horaire du VPS (IMPORTANT)

Les événements sont stockés en heure locale sans fuseau. Le serveur doit donc être
en `Europe/Paris`, sinon les rappels tomberaient à la mauvaise heure.

```bash
sudo timedatectl set-timezone Europe/Paris
timedatectl        # vérifie "Time zone: Europe/Paris"
```

## 2. Node + PM2

```bash
node -v            # doit être >= 18 ; sinon installe Node 20 LTS (nvm ou nodesource)
sudo npm install -g pm2
```

## 3. Récupérer le code et les données

```bash
cd /home/TON_USER
git clone <URL_DE_TON_REPO> agenda
cd agenda
npm ci
```

Tes données (`data/*.json`) et ton `.env.local` **ne sont pas dans git** (ils sont
gitignorés). Copie-les depuis ton Mac vers le VPS :

```bash
# Depuis ton Mac, dans le dossier du projet :
scp -r data TON_USER@<IP_VPS>:/home/TON_USER/agenda/
scp .env.local TON_USER@<IP_VPS>:/home/TON_USER/agenda/
```

> Si tu ne copies pas `data/`, l'app démarre avec un agenda vide (pas grave, tes
> agents le rerempliront), mais tu perdrais tes événements actuels.

## 4. Réglages de l'environnement (secrets)

Ouvre `.env.local` sur le VPS et vérifie / complète :

```bash
# Génère un secret cron solide et colle-le dans CRON_SECRET :
openssl rand -hex 32
```

Champs à contrôler dans `.env.local` :
- `MISTRAL_API_KEY` — ta clé.
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — les clés VAPID (déjà générées).
- `VAPID_SUBJECT` — `mailto:ton-email`.
- `CRON_SECRET` — le secret généré ci-dessus.
- (optionnel) `REMINDER_LEAD_MIN=20,1` — les préavis, en minutes, avant un
  événement (liste séparée par des virgules ; défaut : `20,1`).

> Les clés VAPID incluses fonctionnent, mais comme la privée a transité par un dépôt,
> tu peux en régénérer un couple pour toi seul : `npx web-push generate-vapid-keys`
> puis remplace les deux valeurs (garde bien la même paire des deux côtés).

## 5. Build + lancement avec PM2

```bash
npm run build

# Choisis un port LIBRE (ton autre projet occupe peut-être déjà 3000) :
PORT=3001 pm2 start npm --name agenda -- start

pm2 save                      # mémorise le process
pm2 startup                   # affiche une commande à copier-coller (démarrage auto au reboot)
```

Vérifie en local sur le VPS : `curl -I http://localhost:3001` doit répondre `200`.

## 6. nginx : bloc pour le sous-domaine

Crée `/etc/nginx/sites-available/agenda` :

```nginx
server {
    listen 80;
    server_name agenda.tondomaine.fr;

    location / {
        proxy_pass http://127.0.0.1:3001;   # le PORT choisi à l'étape 5
        proxy_http_version 1.1;

        # OBLIGATOIRE : le Conseil enchaîne plusieurs appels LLM en effort xhigh
        # et peut tourner 3-5 minutes avant de renvoyer le moindre octet. Le
        # défaut nginx (60s) coupe la connexion en plein milieu : le serveur va
        # au bout et écrit le plan, mais le navigateur affiche une erreur.
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Active-le :

```bash
sudo ln -s /etc/nginx/sites-available/agenda /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 7. HTTPS (OBLIGATOIRE pour la PWA et le push)

```bash
sudo certbot --nginx -d agenda.tondomaine.fr
```

Certbot ajoute tout seul le bloc `listen 443 ssl` et la redirection http→https.
Teste : ouvre `https://agenda.tondomaine.fr` dans un navigateur.

## 8. Rappels des événements (le cœur des notifications)

Le serveur vérifie lui-même les événements à venir toutes les minutes
(`src/instrumentation.ts`, démarré automatiquement par Next/PM2 — rien à
configurer côté crontab). Par défaut, chaque événement donne **deux** rappels :
un préavis 20 min avant pour se préparer, puis un dernier appel 1 min avant.
La liste se règle avec `REMINDER_LEAD_MIN` (par exemple `30,5,1` ; défaut
`20,1`). Un événement peut avoir son propre préavis via `reminderMin` : il
remplace celui de préparation, le dernier appel part quand même.

Vérifie à la main que ça tourne bien après un déploiement :

```bash
pm2 logs agenda | grep reminders   # aucune erreur "échec du passage périodique"
```

L'endpoint `GET/POST /api/cron/reminders` reste disponible pour un test manuel
ou un déclenchement externe de secours (protégé par `CRON_SECRET`) :

```bash
curl -H "Authorization: Bearer TON_CRON_SECRET" https://agenda.tondomaine.fr/api/cron/reminders
# -> {"ok":true,"checked":N,"due":...,"pushed":...}
```

---

## 9. Sur ton iPhone (une seule fois)

1. Ouvre `https://agenda.tondomaine.fr` dans **Safari**.
2. Bouton **Partager** → **Sur l'écran d'accueil** → Ajouter.
3. **Rouvre l'app depuis son icône** (plus depuis Safari).
4. Va dans **Réglages → Notifications → Activer les notifications**, autorise.
5. Touche **Tester** : tu dois recevoir une notif.

À partir de là, tu reçois deux rappels par événement : ~20 min avant, puis
~1 min avant (réglable via `REMINDER_LEAD_MIN` dans `.env.local`).

---

## Mettre à jour l'app plus tard

```bash
cd /home/TON_USER/agenda
git pull
npm ci
npm run build
pm2 restart agenda
```

## Dépannage rapide

- **Pas de notif sur iPhone** : l'app doit être lancée depuis l'icône (pas Safari),
  et tu dois être en iOS 16.4+. Refais l'étape 9.
- **`due` toujours 0** : normal s'il n'y a aucun événement dans les 20 min à venir.
- **Mauvaise heure des rappels** : vérifie l'étape 1 (`timedatectl`).
- **Aucun rappel jamais reçu (mais « Tester » fonctionne)** : le scheduler
  interne (étape 8) tourne dans le process Next/PM2 — un `pm2 restart agenda`
  (ou un déploiement) est nécessaire après avoir mis à jour le code pour
  qu'il démarre. Vérifie `pm2 logs agenda` juste après le restart.
- **« Le proxy a coupé avant la fin » / erreur après ~60s sur le Conseil** :
  `proxy_read_timeout` manque dans le bloc nginx (étape 6). Symptôme typique :
  `pm2 logs agenda` montre le Conseil qui se termine normalement, et un F5
  affiche bien le résultat. Si tu es derrière Cloudflare, son propre timeout
  d'origine (100s, non configurable en plan gratuit) coupera malgré nginx.
- **Logs de l'app** : `pm2 logs agenda`.
