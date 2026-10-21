# Stage 1: Build the Go binary
FROM golang:1.22-alpine AS builder

WORKDIR /app

# Install git and ca-certificates
RUN apk add --no-cache git ca-certificates

# Copy module definition files and download dependencies
COPY go.mod go.sum* ./
RUN go mod download

# Copy source files
COPY main.go ./

# Build ultra-lightweight statically linked CGO_ENABLED=0 binary
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o notionly main.go

# Stage 2: Final minimal runtime image with non-root security user
FROM alpine:3.19

WORKDIR /app

# Install ca-certificates for secure HTTPS if needed
RUN apk add --no-cache ca-certificates tzdata

# Create dedicated non-root security user and group (UID/GID 10001)
RUN addgroup -g 10001 -S appgroup && \
    adduser -u 10001 -S appuser -G appgroup

# Create uploads directory and set non-root user permissions
RUN mkdir -p /app/uploads && chown -R appuser:appgroup /app

# Copy binary from builder
COPY --from=builder --chown=appuser:appgroup /app/notionly /app/notionly

# Copy static frontend files
COPY --chown=appuser:appgroup static /app/static

# Switch to non-root user for security compliance
USER appuser:appgroup

# Expose HTTP port
EXPOSE 8080

# Run the lightweight Go server
CMD ["/app/notionly"]
