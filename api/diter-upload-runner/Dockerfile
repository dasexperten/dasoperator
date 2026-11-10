FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git gh python3 python3-venv ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/media && /opt/media/bin/pip install --no-cache-dir 'yt-dlp[default]'
ENV PATH=/opt/media/bin:$PATH
RUN npm install --global @openai/codex@0.165.0
WORKDIR /app
COPY native.mjs server.mjs dieter.mjs ./
RUN node -e "require('fs').writeFileSync('/app/ca.pem', require('tls').rootCertificates.join('\n'))"
ENV SSL_CERT_FILE=/app/ca.pem
ENV DIETER_STATE_DIR=/home/node/dieter-state
USER node
EXPOSE 8080
CMD ["node","server.mjs"]
