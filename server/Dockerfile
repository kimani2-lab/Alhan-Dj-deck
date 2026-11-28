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
        "yt-dlp[default]" \
    && test -x /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version \
    && rm -rf /var/lib/apt/lists/*

RUN curl -L --fail --retry 3 \
        https://deno.land/install.sh \
        -o /tmp/install-deno.sh \
    && DENO_INSTALL=/usr/local sh /tmp/install-deno.sh \
    && rm /tmp/install-deno.sh \
    && test -x /usr/local/bin/deno \
    && /usr/local/bin/deno --version

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
