# BrainGlitchX Poster v1.3

Fixes in v1.3:
- Generate form now sends category/topic/status correctly to the backend.
- Queue category counts now respect the selected status filter.
- Existing `.env`, `data`, and `public/uploads` should be kept during updates.

# BrainGlitchX Poster v1.1

Fixes in v1.1:
- Better Generate logging: requests now log category/topic/status and created IDs.
- Database insert validation: success is only reported after an actual DB insert.
- Single-category generation now stores the requested category exactly.
- OpenAI prompt now strongly respects topic hints, e.g. Tennis.

Update: keep `.env`, `data/`, and `public/uploads/`, then rebuild with `docker compose down` and `docker compose up -d --build`.

# BrainGlitchX Poster

A small self-hosted queue, scheduler, AI generator, image generator, and analytics dashboard for @BrainGlitchX.

## Update notes

When updating from an older ZIP, keep these from your existing install:

- `.env`
- `data/`
- `public/uploads/`

Then copy the new files over the old project folder and rebuild:

```powershell
docker compose down
docker compose up -d --build
```

## Required `.env`

```env
PORT=3000
APP_PASSWORD=change-me-now
BASE_URL=https://brain.bastiwe.de

X_APP_KEY=
X_APP_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_SECRET=

TIMEZONE=Europe/Berlin
DRY_RUN=false

OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
OPENAI_IMAGE_MODEL=gpt-image-1
OPENAI_IMAGE_SIZE=1024x1024
OPENAI_IMAGE_QUALITY=low

SCHEDULER_DEBUG=false
DEDUPE_MEMORY_LIMIT=300

ANALYTICS_AUTO_SYNC=false
ANALYTICS_CRON=17 * * * *
ANALYTICS_SYNC_LIMIT=50
ANALYTICS_PRIVATE_METRICS=false
```

## Analytics sync

Open the **Analytics** tab and click **Sync analytics now**. The app fetches metrics for posts that were already published by this tool and stores them in SQLite.

The Queue tab also shows views, likes, and reposts for each posted item after syncing.

Optional automatic sync:

```env
ANALYTICS_AUTO_SYNC=true
ANALYTICS_CRON=17 * * * *
ANALYTICS_SYNC_LIMIT=50
```

This syncs the latest posted items once per hour at minute 17.

## Local run

```powershell
docker compose up -d --build
```

Open:

```text
http://localhost:3000?key=YOUR_APP_PASSWORD
```

## Deployment on bastiwe.de with a subdomain

Recommended: use a subdomain like `brain.bastiwe.de`, not the root domain `bastiwe.de`, so your main website remains separate.

### 1. VPS / server requirements

Install Docker and Docker Compose on the server.

### 2. Upload the app

Copy the project folder to the server, for example:

```bash
scp -r brainglitchx-poster user@YOUR_SERVER_IP:/opt/brainglitchx-poster
```

Then SSH into the server:

```bash
ssh user@YOUR_SERVER_IP
cd /opt/brainglitchx-poster
```

Create/edit `.env`:

```bash
cp .env.example .env
nano .env
```

Set:

```env
BASE_URL=https://brain.bastiwe.de
APP_PASSWORD=your-long-password
DRY_RUN=false
```

### 3. Start the app

```bash
docker compose up -d --build
```

Check logs:

```bash
docker compose logs -f
```

### 4. DNS

At your domain provider, create an A record:

```text
brain.bastiwe.de  A  YOUR_SERVER_IP
```

Wait until DNS has propagated.

### 5. Reverse proxy with Caddy

Caddy is the easiest option because it automatically handles HTTPS certificates.

Install Caddy, then create/edit `/etc/caddy/Caddyfile`:

```caddy
brain.bastiwe.de {
  reverse_proxy 127.0.0.1:3000
}
```

Reload Caddy:

```bash
sudo systemctl reload caddy
```

Open:

```text
https://brain.bastiwe.de?key=YOUR_APP_PASSWORD
```

### Alternative: Nginx

If you use Nginx, proxy to port 3000 and add HTTPS with Certbot.

```nginx
server {
    server_name brain.bastiwe.de;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 6. Security notes

- Use a long `APP_PASSWORD`.
- Do not commit or share `.env`.
- Keep the app behind HTTPS.
- Keep `data/` backed up because it contains your queue database.

## Backup

```bash
tar -czf brainglitchx-backup.tar.gz data public/uploads .env
```

## Restore

Copy `.env`, `data/`, and `public/uploads/` back into the project folder and run:

```bash
docker compose up -d --build
```


## v1.3

- Added Post Now actions for existing drafts/queued posts.
- Added Generate & Schedule and Generate & Post Now buttons.
- Queue schedule column now displays local dates as DD.MM.YYYY HH:MM plus relative timing.
- Status badges remain color-coded for Draft/Scheduled/Posted/Failed.
