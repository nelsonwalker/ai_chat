import { FastifyPluginAsync } from "fastify";
import { db } from "../db/db";
import { models } from "../db/schema";
import { asc, eq } from "drizzle-orm";

const modelsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/models - list models (sorted by name)
  fastify.get("/", async () => {
    return db
      .select({
        id: models.id,
        name: models.name,
        openrouterIdentifier: models.openrouterIdentifier,
      })
      .from(models)
      .orderBy(asc(models.name), asc(models.id));
  });

  // POST /api/models - create a model
  fastify.post<{
    Body: { name: string; openrouterIdentifier: string };
  }>(
    "/",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
            openrouterIdentifier: { type: "string", minLength: 1 },
          },
          required: ["name", "openrouterIdentifier"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const name = request.body.name.trim();
      const openrouterIdentifier = request.body.openrouterIdentifier.trim();

      // Friendly 409 for duplicates
      const existing = await db.query.models.findFirst({
        where: eq(models.openrouterIdentifier, openrouterIdentifier),
        columns: { id: true },
      });
      if (existing) {
        return reply.code(409).send({
          error: "Model already exists",
          field: "openrouterIdentifier",
        });
      }

      const [created] = await db
        .insert(models)
        .values({ name, openrouterIdentifier })
        .returning({
          id: models.id,
          name: models.name,
          openrouterIdentifier: models.openrouterIdentifier,
        });

      return reply.code(201).send(created);
    }
  );

  // DELETE /api/models/:id - delete a model
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
      const modelId = Number(request.params.id);
      if (Number.isNaN(modelId)) {
        return reply.code(400).send({ error: "Invalid model id" });
      }

      const existing = await db.query.models.findFirst({
        where: eq(models.id, modelId),
        columns: { id: true },
      });

      if (!existing) {
        return reply.code(404).send({ error: "Model not found" });
      }

      // This will set chats.modelId to null because of onDelete: "set null"
      const [deleted] = await db
        .delete(models)
        .where(eq(models.id, modelId))
        .returning({ id: models.id });

      return reply.code(200).send({ ok: true, deletedId: deleted.id });
    }
  );
};

export default modelsRoutes;
