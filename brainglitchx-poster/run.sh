#!/usr/bin/with-contenv sh
set -e

OPTIONS=/data/options.json

get_opt() {
  key="$1"
  default="$2"
  jq -r --arg key "$key" --arg default "$default" 'if has($key) then .[$key] else $default end' "$OPTIONS"
}

export PORT=3000
export HA_INGRESS=true
export ADDON_VERSION="2.8.17"
export APP_PASSWORD="$(get_opt app_password change-me-now)"
export TIMEZONE="$(get_opt timezone Europe/Berlin)"
export DRY_RUN="$(get_opt dry_run true)"
export SCHEDULER_DEBUG="$(get_opt scheduler_debug false)"
export BASE_URL="$(get_opt base_url '')"
export X_APP_KEY="$(get_opt x_app_key '')"
export X_APP_SECRET="$(get_opt x_app_secret '')"
export X_ACCESS_TOKEN="$(get_opt x_access_token '')"
export X_ACCESS_SECRET="$(get_opt x_access_secret '')"
export OPENAI_API_KEY="$(get_opt openai_api_key '')"
export OPENAI_MODEL="$(get_opt openai_model gpt-4.1-mini)"
export OPENAI_IMAGE_MODEL="$(get_opt openai_image_model gpt-image-1)"
export OPENAI_IMAGE_SIZE="$(get_opt openai_image_size 1024x1024)"
export OPENAI_IMAGE_QUALITY="$(get_opt openai_image_quality low)"
export OPENAI_IMAGE_FORMAT="$(get_opt openai_image_format jpeg)"
export DEDUPE_MEMORY_LIMIT="$(get_opt dedupe_memory_limit 300)"

# Persist DB/imports/uploads under /data so Home Assistant add-on backups can include them.
mkdir -p /data/imports /data/uploads /app/public
rm -rf /app/data /app/public/uploads
ln -s /data /app/data
ln -s /data/uploads /app/public/uploads

echo "BrainGlitchX Poster add-on starting..."
echo "Loaded Home Assistant add-on options from $OPTIONS"
echo "PORT=$PORT HA_INGRESS=$HA_INGRESS TIMEZONE=$TIMEZONE DRY_RUN=$DRY_RUN SCHEDULER_DEBUG=$SCHEDULER_DEBUG"
echo "BASE_URL=$BASE_URL OPENAI_MODEL=$OPENAI_MODEL OPENAI_IMAGE_MODEL=$OPENAI_IMAGE_MODEL OPENAI_IMAGE_SIZE=$OPENAI_IMAGE_SIZE OPENAI_IMAGE_QUALITY=$OPENAI_IMAGE_QUALITY OPENAI_IMAGE_FORMAT=$OPENAI_IMAGE_FORMAT DEDUPE_MEMORY_LIMIT=$DEDUPE_MEMORY_LIMIT"
echo "X credentials configured: app_key=$( [ -n "$X_APP_KEY" ] && echo yes || echo no ) access_token=$( [ -n "$X_ACCESS_TOKEN" ] && echo yes || echo no )"
echo "OpenAI key configured: $( [ -n "$OPENAI_API_KEY" ] && echo yes || echo no )"
exec node /app/src/server.js
