FROM node:22-slim

# ─── System deps ─────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg python3 python3-pip python3-dev git curl wget unzip ca-certificates \
  fonts-dejavu-core fonts-noto fonts-beng fonts-beng-extra fonts-noto-color-emoji \
  fonts-freefont-ttf fontconfig \
  libraqm0 libraqm-dev libfreetype6 libfreetype6-dev libharfbuzz0b libharfbuzz-dev \
  libfribidi0 libfribidi-dev libjpeg-dev zlib1g-dev libpng-dev build-essential \
  && rm -rf /var/lib/apt/lists/* \
  && fc-cache -f

# ─── Pip: Pillow (source + raqm), yt-dlp, instaloader ────────────
RUN pip install --break-system-packages --no-cache-dir -U \
  setuptools wheel cmake ninja pybind11 \
  && pip install --break-system-packages --no-cache-dir --no-binary Pillow --force-reinstall Pillow \
  && pip install --break-system-packages --no-cache-dir -U \
  "yt-dlp[default]" instaloader \
  && yt-dlp --version \
  && instaloader --version \
  && python3 -c "from PIL import features; raqm=features.check('raqm'); fribidi=features.check('fribidi'); print('raqm=', raqm, 'fribidi=', fribidi)" \
  && python3 -c "from PIL import Image, ImageDraw, ImageFont; f=ImageFont.truetype('/usr/share/fonts/truetype/freefont/FreeSans.ttf',20); print('Pillow OK')"

# ─── KS-Downloader (captcha-resistant Kuaishou downloader) ───────
COPY ks-downloader /app/ks-downloader
RUN pip install --break-system-packages --no-cache-dir \
  httpx[socks] aiofiles aiosqlite lxml pyyaml rich uvicorn fastapi emoji \
  && echo "KS-Downloader installed"

# ─── Deno (for YouTube JS challenge bypass) ──────────────────────
RUN curl -fsSL https://deno.land/install.sh | sh \
  && mv /root/.deno/bin/deno /usr/local/bin/deno \
  && deno --version

# ─── Xray-core ───────────────────────────────────────────────────
RUN ARCH=$(dpkg --print-architecture) \
  && if [ "$ARCH" = "amd64" ]; then XARCH="64"; else XARCH="arm64-v8a"; fi \
  && wget -q "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${XARCH}.zip" -O /tmp/xray.zip \
  && unzip -q /tmp/xray.zip -d /tmp/xray \
  && mv /tmp/xray/xray /usr/local/bin/xray \
  && chmod +x /usr/local/bin/xray \
  && rm -rf /tmp/xray.zip /tmp/xray \
  && xray version || true

# ─── App ─────────────────────────────────────────────────────────
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src

# ─── Dirs ────────────────────────────────────────────────────────
RUN mkdir -p /app/data/output /app/data/cookies /app/data \
  /tmp/vmixer /app/ks-downloader/Volume

ENV PORT=3000 \
  TEMP_DIR=/tmp/vmixer \
  OUTPUT_DIR=/app/data/output \
  COOKIES_FILE=/app/data/cookies/cookies.txt \
  CONFIG_FILE=/app/data/config.json \
  NODE_ENV=production

EXPOSE 3000

# ─── Startup: KS-Downloader API background + Node server foreground
RUN printf '#!/bin/sh\n\
echo "[startup] Starting KS-Downloader API..."\n\
cd /app/ks-downloader && python main.py api --host 0.0.0.0 --port 5557 >> /tmp/ks-api.log 2>&1 &\n\
echo "[startup] KS-Downloader PID=$!"\n\
echo "[startup] Starting Node server..."\n\
exec node /app/src/server.js\n' > /app/start.sh \
  && chmod +x /app/start.sh

CMD ["/app/start.sh"]
