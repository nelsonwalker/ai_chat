import type { FastifyReply } from "fastify";

export function parseNumericId(id: string, reply: FastifyReply, name = "id") {
  const n = Number(id);
  if (Number.isNaN(n)) {
    reply.code(400).send({ error: `Invalid ${name}` });
    return null;
  }
  return n;
}

export function requireEnv(name: string, reply: FastifyReply): string | null {
  const value = process.env[name];
  if (!value) {
    reply.code(500).send({ error: `Missing ${name}` });
    return null;
  }
  return value;
}
