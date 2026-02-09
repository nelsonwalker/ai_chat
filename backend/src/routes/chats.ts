import { FastifyPluginAsync } from "fastify";
import { db } from "../db/db";
import { chats, messages, models } from "../db/schema";
import { desc, eq, asc, sql } from "drizzle-orm";

const chatsRoutes: FastifyPluginAsync = async (fastify) => {
    // GET /api/chats - list of chats
    fastify.get("/", async () => {
        // TODO: get user id from request
        const userId = 1;

        return db
        .select({
            id: chats.id,
            title: chats.title,
            updatedAt: chats.updatedAt,
            createdAt: chats.createdAt,
        })
        .from(chats)
        .where(eq(chats.userId, userId))
        .orderBy(desc(chats.updatedAt), desc(chats.id));
    });

    // GET /api/chats/:id - chat messages by id
    fastify.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
        const chatId = Number(request.params.id);
        if (Number.isNaN(chatId)) {
        return reply.status(400).send({ error: "Invalid chat id" });
        }

        const chat = await db.query.chats.findFirst({
        where: eq(chats.id, chatId),
        with: {
            messages: {
                    orderBy: (t, { asc }) => asc(t.id),
                },
            },
        });

        if (!chat) {
            return reply.status(404).send({ error: "Chat not found" });
        }

        return chat;
    });

    // POST /api/chats - create a new chat
    fastify.post<{
    Body: {
        title?: string;
        modelId?: number | null;
    };
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
        const userId = 1; // TODO: replace with auth-derived userId later

        const title =
        typeof request.body?.title === "string" && request.body.title.trim()
            ? request.body.title.trim()
            : "New chat";

        const modelId =
        typeof request.body?.modelId === "number" ? request.body.modelId : null;

        const [created] = await db
        .insert(chats)
        .values({
            title,
            userId,
            modelId,
        })
        .returning();

        return reply.status(201).send(created);
    }
    );

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
        const chatId = Number(request.params.id);
        if (Number.isNaN(chatId)) return reply.code(400).send({ error: "Invalid chat id" });

        const userContent = request.body.content.trim();
        if (!userContent) return reply.code(400).send({ error: "Content cannot be empty" });

        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) return reply.code(500).send({ error: "Missing OPENROUTER_API_KEY" });

        // 1) Load chat
        const chat = await db.query.chats.findFirst({
        where: eq(chats.id, chatId),
        columns: { id: true, modelId: true },
        });
        if (!chat) return reply.code(404).send({ error: "Chat not found" });

        // Resolve model identifier
        let modelIdentifier = process.env.OPENROUTER_MODEL;
        if (chat.modelId) {
        const modelRow = await db.query.models.findFirst({
            where: eq(models.id, chat.modelId),
            columns: { openrouterIdentifier: true },
        });
        if (modelRow?.openrouterIdentifier) modelIdentifier = modelRow.openrouterIdentifier;
        }
        if (!modelIdentifier) {
        return reply.code(500).send({ error: "No model configured (OPENROUTER_MODEL or chat.modelId)" });
        }

        // Helper: normalize upstream errors into UX-friendly fields
        const mapUpstreamError = (status: number, rawBody: string) => {
        // Defaults
        let errorCode = "upstream_error";
        let errorMessage = "Something went wrong generating a response. Please try again.";

        // Try to parse OpenRouter style error payloads
        try {
            const parsed = JSON.parse(rawBody);
            const code = parsed?.error?.code;
            const msg = parsed?.error?.message;

            if (status === 429 || code === 429) {
            errorCode = "rate_limited";
            errorMessage = "This model is temporarily rate-limited. Please retry in a moment or switch models.";
            } else if (status === 401 || status === 403) {
            errorCode = "auth_error";
            errorMessage = "Authentication failed when calling the model provider. Check your OpenRouter API key.";
            } else if (typeof msg === "string" && msg.trim()) {
            // Keep a generic user-friendly message, but include provider message as detail
            errorMessage = msg.trim();
            }
        } catch {
            // ignore parse errors; keep defaults
        }

        return { errorCode, errorMessage };
        };

        const markAssistantError = async (assistantId: number, statusCode: number, rawBody: string) => {
        const { errorCode, errorMessage } = mapUpstreamError(statusCode, rawBody);

        await db
            .update(messages)
            .set({
            status: "error",
            errorCode,
            errorMessage,
            content: errorMessage, // so the UI can render a normal bubble even without special casing
            })
            .where(eq(messages.id, assistantId));

        await db.update(chats).set({ updatedAt: sql`now()` }).where(eq(chats.id, chatId));

        // Also stream a clear sentinel for non-UI clients (curl)
        reply.raw.write(`\n[ERROR] ${errorMessage}\n`);
        };

        // 2) Insert the user's message
        const [userMsg] = await db
        .insert(messages)
        .values({
            chatId,
            role: "user",
            content: userContent,
            parentMessageId: null,
            status: "complete",
            errorCode: null,
            errorMessage: null,
        })
        .returning({ id: messages.id });

        // 3) Create assistant placeholder as streaming
        const [assistantMsg] = await db
        .insert(messages)
        .values({
            chatId,
            role: "assistant",
            content: "",
            parentMessageId: userMsg.id,
            status: "streaming",
            errorCode: null,
            errorMessage: null,
        })
        .returning({ id: messages.id });

        // 4) Build history BEFORE assistant content exists (filter out empty assistant content)
        const history = await db.query.messages.findMany({
        where: eq(messages.chatId, chatId),
        orderBy: (fields, { asc }) => [asc(fields.id)],
        columns: { role: true, content: true },
        });

        // 5) Prepare streaming response
        reply.raw.setHeader("Content-Type", "text/plain; charset=utf-8");
        reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
        reply.raw.setHeader("Connection", "keep-alive");
        reply.raw.flushHeaders?.();
        reply.hijack();

        const abortController = new AbortController();
        let clientDisconnected = false;

        request.raw.on("close", () => {
        clientDisconnected = true;
        abortController.abort();
        });

        // 6) Call OpenRouter (SSE upstream)
        let upstream: Response;
        try {
        upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:3000",
            "X-Title": "AI Chat (take-home)",
            },
            body: JSON.stringify({
            model: modelIdentifier,
            messages: history,
            stream: true,
            }),
            signal: abortController.signal,
        });
        } catch {
        // Fetch failed (network/DNS/etc)
        await db
            .update(messages)
            .set({
            status: "error",
            errorCode: "network_error",
            errorMessage: "Could not reach the model provider. Please try again.",
            content: "Could not reach the model provider. Please try again.",
            })
            .where(eq(messages.id, assistantMsg.id));

        await db.update(chats).set({ updatedAt: sql`now()` }).where(eq(chats.id, chatId));
        reply.raw.write(`\n[ERROR] Could not reach the model provider. Please try again.\n`);
        reply.raw.end();
        return;
        }

        // Upstream error before streaming begins
        if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => "");
        await markAssistantError(assistantMsg.id, upstream.status, text);
        reply.raw.end();
        return;
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let assistantText = "";

        // Throttle DB updates
        let lastPersist = Date.now();
        const persistEveryMs = 250;

        const persistContent = async (final = false) => {
        const now = Date.now();
        if (!final && now - lastPersist < persistEveryMs) return;
        lastPersist = now;

        await db
            .update(messages)
            .set({
            content: assistantText,
            // keep status as streaming until final
            status: final ? "complete" : "streaming",
            errorCode: null,
            errorMessage: null,
            })
            .where(eq(messages.id, assistantMsg.id));

        await db.update(chats).set({ updatedAt: sql`now()` }).where(eq(chats.id, chatId));
        };

        const finalizeComplete = async () => {
        await db
            .update(messages)
            .set({
            content: assistantText,
            status: "complete",
            errorCode: null,
            errorMessage: null,
            })
            .where(eq(messages.id, assistantMsg.id));

        await db.update(chats).set({ updatedAt: sql`now()` }).where(eq(chats.id, chatId));
        };

        try {
        const reader = upstream.body.getReader();

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            let idx;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const eventBlock = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            if (eventBlock.startsWith(":")) continue;

            const dataLines = extractSseDataLines(eventBlock);
            for (const data of dataLines) {
                if (!data) continue;

                if (data === "[DONE]") {
                await persistContent(true);
                reply.raw.end();
                return;
                }

                let json: any;
                try {
                json = JSON.parse(data);
                } catch {
                continue;
                }

                // Mid-stream error
                if (json?.error) {
                const raw = JSON.stringify(json);
                await markAssistantError(assistantMsg.id, 500, raw);
                reply.raw.end();
                return;
                }

                const delta = json?.choices?.[0]?.delta?.content;
                if (typeof delta === "string" && delta.length) {
                assistantText += delta;
                reply.raw.write(delta);
                await persistContent(false);
                }
            }
            }
        }

        // Stream ended without [DONE] — treat as complete if we have tokens, otherwise error
        if (assistantText.trim().length > 0) {
            await finalizeComplete();
        } else if (!clientDisconnected) {
            await db
            .update(messages)
            .set({
                status: "error",
                errorCode: "stream_ended",
                errorMessage: "The model stream ended unexpectedly. Please try again.",
                content: "The model stream ended unexpectedly. Please try again.",
            })
            .where(eq(messages.id, assistantMsg.id));
        }

        reply.raw.end();
        } catch {
        // If client disconnected: if we got some text, keep it as complete; if not, mark error
        if (assistantText.trim().length > 0) {
            await finalizeComplete().catch(() => {});
        } else {
            await db
            .update(messages)
            .set({
                status: "error",
                errorCode: "aborted",
                errorMessage: "Request was cancelled before a response was generated.",
                content: "Request was cancelled before a response was generated.",
            })
            .where(eq(messages.id, assistantMsg.id))
            .catch(() => {});
        }

        reply.raw.end();
        }
    }
    );


    // POST /api/chats/:id/messages
//     fastify.post<{
//     Params: { id: string };
//     Body: { content: string };
//   }>(
//     "/:id/messages",
//     {
//       schema: {
//         params: {
//           type: "object",
//           properties: { id: { type: "string", pattern: "^[0-9]+$" } },
//           required: ["id"],
//           additionalProperties: false,
//         },
//         body: {
//           type: "object",
//           properties: { content: { type: "string", minLength: 1 } },
//           required: ["content"],
//           additionalProperties: false,
//         },
//       },
//     },
//     async (request, reply) => {
//       const chatId = Number(request.params.id);
//       if (Number.isNaN(chatId)) return reply.code(400).send({ error: "Invalid chat id" });

//       const userContent = request.body.content.trim();
//       if (!userContent) return reply.code(400).send({ error: "Content cannot be empty" });

//       const apiKey = process.env.OPENROUTER_API_KEY;
//       if (!apiKey) return reply.code(500).send({ error: "Missing OPENROUTER_API_KEY" });

//       // 1) Load chat (and model if you store it on chat)
//       const chat = await db.query.chats.findFirst({
//         where: eq(chats.id, chatId),
//         columns: { id: true, modelId: true },
//       });
//       if (!chat) return reply.code(404).send({ error: "Chat not found" });

//       // Resolve model identifier
//       let modelIdentifier = process.env.OPENROUTER_MODEL; // fallback
//       if (chat.modelId) {
//         const modelRow = await db.query.models.findFirst({
//           where: eq(models.id, chat.modelId),
//           columns: { openrouterIdentifier: true },
//         });
//         if (modelRow?.openrouterIdentifier) modelIdentifier = modelRow.openrouterIdentifier;
//       }
//       if (!modelIdentifier) {
//         return reply.code(500).send({ error: "No model configured (OPENROUTER_MODEL or chat.modelId)" });
//       }

//       // 2) Insert the user's message
//       const [userMsg] = await db
//         .insert(messages)
//         .values({
//           chatId,
//           role: "user",
//           content: userContent,
//           parentMessageId: null,
//         })
//         .returning({
//           id: messages.id,
//           chatId: messages.chatId,
//           role: messages.role,
//           content: messages.content,
//           createdAt: messages.createdAt,
//         });

//       // 3) Create an assistant placeholder message we will update as tokens stream in
//       const [assistantMsg] = await db
//         .insert(messages)
//         .values({
//           chatId,
//           role: "assistant",
//           content: "",
//           parentMessageId: userMsg.id,
//         })
//         .returning({ id: messages.id });

//       // 4) Build full chat history for OpenRouter (ordered)
//       const history = await db.query.messages.findMany({
//         where: eq(messages.chatId, chatId),
//         orderBy: (fields, { asc }) => [asc(fields.id)],
//         columns: { role: true, content: true },
//       });

//       // 5) Prepare streaming response to browser (chunked text)
//       reply.raw.setHeader("Content-Type", "text/plain; charset=utf-8");
//       reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
//       reply.raw.setHeader("Connection", "keep-alive");
//       reply.raw.flushHeaders?.(); // ok if available
//       reply.hijack(); // we will manage the stream manually

//       const abortController = new AbortController();

//       // If client disconnects, cancel upstream
//       request.raw.on("close", () => {
//         abortController.abort();
//       });

//       // 6) Call OpenRouter with stream:true (SSE stream) :contentReference[oaicite:3]{index=3}
//       let upstream: Response;
//       try {
//         upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
//           method: "POST",
//           headers: {
//             Authorization: `Bearer ${apiKey}`,
//             "Content-Type": "application/json",
//             // Optional but recommended for OpenRouter rankings/telemetry :contentReference[oaicite:4]{index=4}
//             "HTTP-Referer": "http://localhost:3000",
//             "X-Title": "AI Chat (take-home)",
//           },
//           body: JSON.stringify({
//             model: modelIdentifier,
//             messages: history,
//             stream: true,
//           }),
//           signal: abortController.signal,
//         });
//       } catch (e: any) {
//         // If fetch itself fails
//         reply.raw.end();
//         return;
//       }

//       // If OpenRouter errors before any tokens, it returns normal JSON + status :contentReference[oaicite:5]{index=5}
//       if (!upstream.ok || !upstream.body) {
//         const text = await upstream.text().catch(() => "");
//         reply.raw.write(`\n[Upstream error ${upstream.status}] ${text}\n`);
//         reply.raw.end();
//         return;
//       }

//       const decoder = new TextDecoder();
//       let buffer = "";
//       let assistantText = "";

//       // Throttle DB updates
//       let lastPersist = Date.now();
//       const persistEveryMs = 250;

//       const persist = async (final = false) => {
//         const now = Date.now();
//         if (!final && now - lastPersist < persistEveryMs) return;
//         lastPersist = now;

//         await db
//           .update(messages)
//           .set({ content: assistantText })
//           .where(eq(messages.id, assistantMsg.id));

//         await db
//           .update(chats)
//           .set({ updatedAt: sql`now()` })
//           .where(eq(chats.id, chatId));
//       };

//       try {
//         // 7) Parse SSE from OpenRouter; ignore comment payloads :contentReference[oaicite:6]{index=6}
//         const reader = upstream.body.getReader();

//         while (true) {
//           const { value, done } = await reader.read();
//           if (done) break;

//           buffer += decoder.decode(value, { stream: true });

//           // SSE events are separated by a blank line
//           let idx;
//           while ((idx = buffer.indexOf("\n\n")) !== -1) {
//             const eventBlock = buffer.slice(0, idx);
//             buffer = buffer.slice(idx + 2);

//             // ignore comment-only events like ": OPENROUTER PROCESSING" :contentReference[oaicite:7]{index=7}
//             if (eventBlock.startsWith(":")) continue;

//             const dataLines = extractSseDataLines(eventBlock);
//             for (const data of dataLines) {
//               if (!data) continue;
//               if (data === "[DONE]") {
//                 await persist(true);
//                 reply.raw.end();
//                 return;
//               }

//               let json: any;
//               try {
//                 json = JSON.parse(data);
//               } catch {
//                 continue;
//               }

//               // OpenAI-style delta content
//               const delta = json?.choices?.[0]?.delta?.content;
//               if (typeof delta === "string" && delta.length) {
//                 assistantText += delta;
//                 reply.raw.write(delta); // stream to client immediately
//                 await persist(false);
//               }

//               // Mid-stream errors can be sent as SSE events too :contentReference[oaicite:8]{index=8}
//               if (json?.error) {
//                 reply.raw.write(`\n[Upstream stream error] ${JSON.stringify(json.error)}\n`);
//                 await persist(true);
//                 reply.raw.end();
//                 return;
//               }
//             }
//           }
//         }

//         // stream ended without [DONE]
//         await persist(true);
//         reply.raw.end();
//       } catch (e: any) {
//         // Abort is normal if client disconnects; cancellation support depends on provider :contentReference[oaicite:9]{index=9}
//         await persist(true).catch(() => {});
//         reply.raw.end();
//       }
//     }
//   );
};

function extractSseDataLines(sseEvent: string): string[] {
  // SSE event is a block separated by \n\n; within it, lines may be:
  // "data: {...}" or ":" comments
  const lines = sseEvent.split("\n");
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  return dataLines;
}

export default chatsRoutes;
