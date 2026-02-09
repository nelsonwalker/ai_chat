import "dotenv/config";
import Fastify from "fastify";
import chatsRoutes from "./routes/chats";
import modelsRoutes from "./routes/models";

const fastify = Fastify({ logger: true });

fastify.get("/health", async () => ({ ok: true }));

fastify.register(chatsRoutes, { prefix: "/api/chats" });
fastify.register(modelsRoutes, { prefix: "/api/models" });

fastify.listen({ port: 3000, host: "0.0.0.0" });
