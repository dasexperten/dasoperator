FROM node:24-bookworm-slim
RUN npm install --global @openai/codex@0.165.0
WORKDIR /app
COPY native.mjs server.mjs ./
RUN node -e "require('fs').writeFileSync('/app/ca.pem', require('tls').rootCertificates.join('\n'))"
ENV SSL_CERT_FILE=/app/ca.pem
ENV DIANA_STATE_DIR=/home/node/diana-state
USER node
EXPOSE 8080
CMD ["node","server.mjs"]
