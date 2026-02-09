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

run the server

```bash
npm run dev
```

## Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

## Design Decisions

### Backend

#### Database

<img width="1068" height="640" alt="ai_chat_schema" src="https://github.com/user-attachments/assets/ff7dea82-99f1-4f24-940f-8eb8d20431a1" />


- included `users` table for future extensibility with auth
- included `models` table which allows user to see which model they're using, switch between models, and add / remove models
- `messages` table consists of messages from both user and AI assistant. The `status`, `error_code`, and `error_message` are needed for when something goes wrong, e.g. many models have rate limits or just don't work
- `messages` has a foreign key referencing itself with the idea being that in the future there could be threads
- structured to meet the requirements and be extensible. I've extended slightly beyond the requirements with the model selection feature and more features such as message attachments, user auth, can easily be added
- assistant message is only updated every 250 ms to avoid excessive db writes

#### API

- decided to use REST http endpoints instead of tRPC for ease of use and testing with curl
- `POST /api/chats/:id/messages` streams the response from the assistant back to the client, gives it a nicer, quicker feel than waiting for the entire response
- separated the file structure into:
  - db - database schema and connection
  - routes - parses the request and calls service layer (need to do this for `routes/models.ts`)
  - services - business logic, access db
  - utils - helper functions
  - providers - openrouter client

### Frontend

- Mantine UI vs ShadCN: haven't really used either, decided to try Mantine UI since people seemed to like it more online
- kept simple, design based off chatgpt
- automatically titles the chats for you
- organises chats by most recently updated
