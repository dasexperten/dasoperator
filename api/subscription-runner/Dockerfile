FROM node:24-bookworm-slim
RUN npm install --global @openai/codex@0.165.0
WORKDIR /app
COPY native.mjs server.mjs ./
USER node
EXPOSE 8080
CMD ["node","server.mjs"]
