import "dotenv/config";
import Fastify from "fastify";
import chatsRoutes from "./routes/chats";

const fastify = Fastify({ logger: true });

fastify.get("/health", async () => ({ ok: true }));

fastify.register(chatsRoutes, { prefix: "/api/chats" });

fastify.listen({ port: 3000, host: "0.0.0.0" });
