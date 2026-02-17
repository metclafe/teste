FROM oven/bun:1

RUN apt-get update && apt-get install -y --fix-missing --no-install-recommends \
    wget \
    gnupg \
    ca-certificates \
    apt-transport-https \
    chromium \
    xvfb \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

ENV CHROME_BIN=/usr/bin/chromium
# Aumenta limite de file descriptors pra alto volume
ENV UV_THREADPOOL_SIZE=16

WORKDIR /app

COPY package*.json ./
RUN bun install --production

COPY . .

# Limites recomendados pra alto volume (override via docker run -e)
ENV browserLimit=20
ENV maxQueue=100
ENV timeOut=180000

CMD ["bun", "start"]
