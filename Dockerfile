FROM node:20-alpine

WORKDIR /app

# Copia apenas os manifests primeiro para otimizar cache
COPY package.json package-lock.json* ./

# Usar install ao invés de ci para evitar falha quando não há lockfile
RUN npm install --omit=dev --no-audit --no-fund

# Copia o restante do código
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]


