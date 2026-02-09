# AI Chat

## Backend Setup

to setup locally:

```bash
cd backend
docker compose up -d
npm install
npx drizzle-kit push
```

copy env.sample and configure local env variables

```bash
cp env.sample .env
vim .env
```

if you want to seed with some sample data:

```bash
npm run seed
```

run the server

```bash
npm run dev
```

try calling api

```bash
$ curl http://localhost:3000/api/chats/1 | jq .
$ curl -N http://localhost:3000/api/chats/1/messages \
  -H "Content-Type: application/json" \
  -d '{"content":"how are you today my good sir?"}'
```

## Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

## TODO

- [ ] refactor chats.ts (currently too large and hard to read)
- [ ] improve formatting
