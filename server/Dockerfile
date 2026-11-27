FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        ffmpeg \
        python3 \
        python3-pip \
        unzip \
    && python3 -m pip install --no-cache-dir --break-system-packages --upgrade \
        --prefix /usr/local "yt-dlp[default]" \
    && curl -L --fail --retry 3 \
        https://deno.land/install.sh \
        -o /tmp/install-deno.sh \
    && DENO_INSTALL=/usr/local sh /tmp/install-deno.sh \
    && rm /tmp/install-deno.sh \
    && command -v yt-dlp \
    && yt-dlp --version \
    && command -v deno \
    && deno --version \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
COPY src ./src
RUN npm install --omit=dev

ENV NODE_ENV=production
ENV PORT=5000
ENV YT_DLP_PATH=/usr/local/bin/yt-dlp
ENV YT_DLP_JS_RUNTIME=deno
EXPOSE 5000

CMD ["npm", "run", "start"]
