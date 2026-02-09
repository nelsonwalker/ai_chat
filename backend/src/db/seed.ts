import { users, chats, messages, models } from "./schema";
import { db } from "./db";


async function seed() {
  console.log("🌱 Seeding database...");

  // Create user
  const [user] = await db
    .insert(users)
    .values({})
    .returning();

  // Create model
  const [model] = await db
    .insert(models)
    .values({
      name: "Llama 3.2 3B (Free)",
      openrouterIdentifier: "meta-llama/llama-3.2-3b-instruct:free",
    })
    .returning();

  // Create chat
  const [chat] = await db
    .insert(chats)
    .values({
      title: "First Chat",
      userId: user.id,
      modelId: model.id,
    })
    .returning();

  // Create messages
  await db.insert(messages).values([
    {
      chatId: chat.id,
      role: "user",
      content: "Hey! Can you explain what React Router is?",
    },
    {
      chatId: chat.id,
      role: "assistant",
      content:
        "React Router is a library that enables client-side routing in React applications. It allows navigation without full page reloads.",
    },
    {
      chatId: chat.id,
      role: "user",
      content: "Nice. What’s new in v7?",
    },
    {
      chatId: chat.id,
      role: "assistant",
      content:
        "React Router v7 improves data APIs and simplifies nested routing patterns.",
    },
  ]);

  console.log("✅ Seeding complete");
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
