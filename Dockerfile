# build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# bake same-origin REST mode into the build ('' → restDataStore via nginx /api proxy)
ENV VITE_API_BASE=""
# Clan column toggle: instance b builds with SHOW_CLAN=on, instance a with off (default).
ARG VITE_SHOW_CLAN=""
ENV VITE_SHOW_CLAN=$VITE_SHOW_CLAN
# Tab title: instance b builds with fomo.
ARG VITE_TITLE=signal_scan
ENV VITE_TITLE=$VITE_TITLE
# Firebase web config (public client identifiers). Passed via compose build args / root .env.
ARG VITE_FIREBASE_API_KEY=""
ENV VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN=""
ENV VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID=""
ENV VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID
RUN npm run build

# serve stage
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
