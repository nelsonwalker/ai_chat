import { db } from "../db/db";
import { chats, messages, models } from "../db/schema";
import { asc, eq, sql } from "drizzle-orm";
import { openRouterGenerateTitle, openRouterStreamChat } from "../providers/openrouter";

export function mapUpstreamError(status: number, rawBody: string) {
  let errorCode = "upstream_error";
  let errorMessage = "Something went wrong generating a response. Please try again.";

  try {
    const parsed = JSON.parse(rawBody);
    const code = parsed?.error?.code;
    const msg = parsed?.error?.message;

    if (status === 429 || code === 429) {
      errorCode = "rate_limited";
      errorMessage =
        "This model is temporarily rate-limited. Please retry in a moment or switch models.";
    } else if (status === 401 || status === 403) {
      errorCode = "auth_error";
      errorMessage =
        "Authentication failed when calling the model provider. Check your OpenRouter API key.";
    } else if (typeof msg === "string" && msg.trim()) {
      errorMessage = msg.trim();
    }
  } catch {
    // ignore
  }

  return { errorCode, errorMessage };
}

export async function resolveModelIdentifier(chatModelId: number | null) {
  let modelIdentifier = process.env.OPENROUTER_MODEL;

  if (chatModelId) {
    const modelRow = await db.query.models.findFirst({
      where: eq(models.id, chatModelId),
      columns: { openrouterIdentifier: true },
    });
    if (modelRow?.openrouterIdentifier) modelIdentifier = modelRow.openrouterIdentifier;
  }

  return modelIdentifier ?? null;
}

export async function listChatsForUser(userId: number) {
  return db
    .select({
      id: chats.id,
      title: chats.title,
      updatedAt: chats.updatedAt,
      createdAt: chats.createdAt,
    })
    .from(chats)
    .where(eq(chats.userId, userId))
    .orderBy(sql`${chats.updatedAt} DESC`, sql`${chats.id} DESC`);
}

export async function createChat(
  userId: number,
  title: string,
  modelId: number | null
) {
  const [created] = await db
    .insert(chats)
    .values({ title, userId, modelId })
    .returning();

  return created;
}


export async function getChatWithMessages(chatId: number) {
  const chat = await db.query.chats.findFirst({
    where: eq(chats.id, chatId),
    with: {
      messages: { orderBy: (t, { asc }) => asc(t.id) },
      model: true,
    },
  });

  if (!chat) return null;

  return {
    ...chat,
    model:
      chat.model && !Array.isArray(chat.model)
        ? {
            id: chat.model.id,
            name: chat.model.name,
            openrouterIdentifier: chat.model.openrouterIdentifier,
          }
        : null,
  };
}

export async function updateChatModel(userId: number, chatId: number, modelId: number | null) {
  if (modelId !== null) {
    const model = await db.query.models.findFirst({
      where: eq(models.id, modelId),
      columns: { id: true },
    });
    if (!model) return { ok: false as const, code: 400 as const, error: "Invalid modelId" };
  }

  const chat = await db.query.chats.findFirst({
    where: eq(chats.id, chatId),
    columns: { id: true, userId: true },
  });
  if (!chat) return { ok: false as const, code: 404 as const, error: "Chat not found" };
  if (chat.userId !== userId) return { ok: false as const, code: 403 as const, error: "Forbidden" };

  const [updated] = await db
    .update(chats)
    .set({ modelId, updatedAt: sql`now()` })
    .where(eq(chats.id, chatId))
    .returning({
      id: chats.id,
      title: chats.title,
      modelId: chats.modelId,
      updatedAt: chats.updatedAt,
      createdAt: chats.createdAt,
    });

  return { ok: true as const, updated };
}

export async function deleteChatForUser(userId: number, chatId: number) {
  const chat = await db.query.chats.findFirst({
    where: eq(chats.id, chatId),
    columns: { id: true, userId: true },
  });

  if (!chat) return { ok: false as const, code: 404 as const, error: "Chat not found" };
  if (chat.userId !== userId) return { ok: false as const, code: 403 as const, error: "Forbidden" };

  const [deleted] = await db.delete(chats).where(eq(chats.id, chatId)).returning({ id: chats.id });
  return { ok: true as const, deletedId: deleted.id };
}

export async function streamAssistantReply(opts: {
  userId: number;
  chatId: number;
  userContent: string;
  apiKey: string;
  writeToClient: (chunk: string) => void;
  signal: AbortSignal;
}) {
  // Load chat
  const chat = await db.query.chats.findFirst({
    where: eq(chats.id, opts.chatId),
    columns: { id: true, modelId: true, userId: true, title: true },
  });
  if (!chat) return { ok: false as const, code: 404 as const, error: "Chat not found" };
  if (chat.userId !== opts.userId) return { ok: false as const, code: 403 as const, error: "Forbidden" };

  // Build history once (optimization) + determine first message
  const history = await db.query.messages.findMany({
    where: eq(messages.chatId, opts.chatId),
    orderBy: (fields, { asc }) => [asc(fields.id)],
    columns: { role: true, content: true },
  });
  const isFirstMessage = history.length === 0;

  const modelIdentifier = await resolveModelIdentifier(chat.modelId);
  if (!modelIdentifier) {
    return {
      ok: false as const,
      code: 500 as const,
      error: "No model configured (OPENROUTER_MODEL or chat.modelId)",
    };
  }

  // Insert user message
  const [userMsg] = await db
    .insert(messages)
    .values({
      chatId: opts.chatId,
      role: "user",
      content: opts.userContent,
      parentMessageId: null,
      status: "complete",
      errorCode: null,
      errorMessage: null,
    })
    .returning({ id: messages.id });

  // Insert assistant placeholder
  const [assistantMsg] = await db
    .insert(messages)
    .values({
      chatId: opts.chatId,
      role: "assistant",
      content: "",
      parentMessageId: userMsg.id,
      status: "streaming",
      errorCode: null,
      errorMessage: null,
    })
    .returning({ id: messages.id });

  let assistantText = "";
  let clientDisconnected = false;

  // Throttle DB writes
  let lastPersist = Date.now();
  const persistEveryMs = 250;

  const persist = async (final: boolean) => {
    const now = Date.now();
    if (!final && now - lastPersist < persistEveryMs) return;
    lastPersist = now;

    await db
      .update(messages)
      .set({
        content: assistantText,
        status: final ? "complete" : "streaming",
        errorCode: null,
        errorMessage: null,
      })
      .where(eq(messages.id, assistantMsg.id));

    await db.update(chats).set({ updatedAt: sql`now()` }).where(eq(chats.id, opts.chatId));
  };

  const markError = async (statusCode: number, rawBody: string) => {
    const { errorCode, errorMessage } = mapUpstreamError(statusCode, rawBody);

    await db
      .update(messages)
      .set({
        status: "error",
        errorCode,
        errorMessage,
        content: errorMessage,
      })
      .where(eq(messages.id, assistantMsg.id));

    await db.update(chats).set({ updatedAt: sql`now()` }).where(eq(chats.id, opts.chatId));

    opts.writeToClient(`\n[ERROR] ${errorMessage}\n`);
  };

  try {
    await openRouterStreamChat({
      apiKey: opts.apiKey,
      model: modelIdentifier,
      // IMPORTANT: include the user message in the prompt we send upstream
      messages: [...history, { role: "user", content: opts.userContent }],
      signal: opts.signal,
      handlers: {
        onDelta: async (delta) => {
          assistantText += delta;
          opts.writeToClient(delta);
          await persist(false);
        },
        onError: async (status, raw) => {
          await markError(status, raw);
        },
        onDone: async () => {
          // If ended with nothing and not disconnected, record a useful error
          if (!assistantText.trim().length && !clientDisconnected) {
            await db
              .update(messages)
              .set({
                status: "error",
                errorCode: "stream_ended",
                errorMessage: "The model stream ended unexpectedly. Please try again.",
                content: "The model stream ended unexpectedly. Please try again.",
              })
              .where(eq(messages.id, assistantMsg.id));
            return;
          }

          await persist(true);

          // Generate a title only for first message
          if (isFirstMessage) {
            const title = await openRouterGenerateTitle({
              apiKey: opts.apiKey,
              model: modelIdentifier,
              userContent: opts.userContent,
              signal: opts.signal,
            });

            if (title) {
              await db.update(chats).set({ title }).where(eq(chats.id, opts.chatId));
            }
          }
        },
        signal: opts.signal,
      },
    });

    return { ok: true as const };
  } catch (e) {
    // aborted or network error
    if (assistantText.trim().length) {
      await persist(true);
      return { ok: true as const };
    }

    await db
      .update(messages)
      .set({
        status: "error",
        errorCode: "aborted",
        errorMessage: "Request was cancelled before a response was generated.",
        content: "Request was cancelled before a response was generated.",
      })
      .where(eq(messages.id, assistantMsg.id));

    return { ok: true as const };
  }
}
