import { FastifyPluginAsync } from "fastify";
import { parseNumericId, requireEnv } from "../utils/http";
import {
  deleteChatForUser,
  getChatWithMessages,
  createChat,
  listChatsForUser,
  streamAssistantReply,
  updateChatModel,
} from "../services/chatService";

const chatsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/chats
  fastify.get("/", async () => {
    const userId = 1; // TODO: auth
    return listChatsForUser(userId);
  });

  // GET /api/chats/:id
  fastify.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const chatId = parseNumericId(request.params.id, reply, "chat id");
    if (chatId === null) return;

    const chat = await getChatWithMessages(chatId);
    if (!chat) return reply.code(404).send({ error: "Chat not found" });

    return chat;
  });

  // POST /api/chats
  fastify.post<{
    Body: { title?: string; modelId?: number | null };
  }>(
    "/",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            title: { type: "string" },
            modelId: { type: ["number", "null"] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const userId = 1;
      const title =
        typeof request.body?.title === "string" && request.body.title.trim()
          ? request.body.title.trim()
          : "New chat";

      const modelId =
        typeof request.body?.modelId === "number" ? request.body.modelId : null;

      const created = await createChat(userId, title, modelId)

      return reply.code(201).send(created);
    }
  );

  // POST /api/chats/:id/messages (stream)
  fastify.post<{
    Params: { id: string };
    Body: { content: string };
  }>(
    "/:id/messages",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", pattern: "^[0-9]+$" } },
          required: ["id"],
          additionalProperties: false,
        },
        body: {
          type: "object",
          properties: { content: { type: "string", minLength: 1 } },
          required: ["content"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const chatId = parseNumericId(request.params.id, reply, "chat id");
      if (chatId === null) return;

      const userContent = request.body.content.trim();
      if (!userContent) return reply.code(400).send({ error: "Content cannot be empty" });

      const apiKey = requireEnv("OPENROUTER_API_KEY", reply);
      if (!apiKey) return;

      // Setup streaming response
      reply.raw.setHeader("Content-Type", "text/plain; charset=utf-8");
      reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.flushHeaders?.();
      reply.hijack();

      const abortController = new AbortController();

      // If the client cancels the request mid-flight
      request.raw.on("aborted", () => abortController.abort());

      // If the client closes the connection while we're streaming the response
      reply.raw.on("close", () => abortController.abort());


      const userId = 1;

      const result = await streamAssistantReply({
        userId,
        chatId,
        userContent,
        apiKey,
        signal: abortController.signal,
        writeToClient: (chunk) => reply.raw.write(chunk),
      });

      if (!result.ok) {
        // For non-streamed errors (chat not found / forbidden / etc.)
        // You can't change status once hijacked, so just emit a sentinel and end.
        reply.raw.write(`\n[ERROR] ${result.error}\n`);
      }

      reply.raw.end();
    }
  );

  // PATCH /api/chats/:id
  fastify.patch<{
    Params: { id: string };
    Body: { modelId: number | null };
  }>(
    "/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", pattern: "^[0-9]+$" } },
          required: ["id"],
          additionalProperties: false,
        },
        body: {
          type: "object",
          properties: { modelId: { type: ["number", "null"] } },
          required: ["modelId"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const chatId = parseNumericId(request.params.id, reply, "chat id");
      if (chatId === null) return;

      const userId = 1;
      const result = await updateChatModel(userId, chatId, request.body.modelId);

      if (!result.ok) return reply.code(result.code).send({ error: result.error });
      return reply.send(result.updated);
    }
  );

  // DELETE /api/chats/:id
  fastify.delete<{ Params: { id: string } }>(
    "/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", pattern: "^[0-9]+$" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const chatId = parseNumericId(request.params.id, reply, "chat id");
      if (chatId === null) return;

      const userId = 1;
      const result = await deleteChatForUser(userId, chatId);

      if (!result.ok) return reply.code(result.code).send({ error: result.error });
      return reply.send({ ok: true, deletedId: result.deletedId });
    }
  );
};

export default chatsRoutes;
