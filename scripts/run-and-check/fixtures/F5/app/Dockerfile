FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -o /out/app .

FROM alpine:3.20
COPY --from=build /out/app /app
EXPOSE 8080
CMD ["/app"]
