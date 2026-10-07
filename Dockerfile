FROM node:24-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.27-alpine AS collector
WORKDIR /src
COPY collector/go.mod collector/go.sum ./
RUN go mod download
COPY collector/ ./
RUN CGO_ENABLED=0 go build -o /mental-map .

FROM alpine:3.22
WORKDIR /app
COPY --from=collector /mental-map /app/mental-map
COPY --from=web /web/dist /app/web
ENV MENTAL_MAP_DATA_DIR=/data MENTAL_MAP_WEB_DIR=/app/web
EXPOSE 9000
CMD ["/app/mental-map"]
