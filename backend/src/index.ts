import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  timestamp,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// =========================
// Role Enum
// =========================

export const messageRoleEnum = pgEnum("message_role", [
  "user",
  "assistant",
  "system",
]);

// =========================
// Users
// =========================

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
});

// =========================
// Models
// =========================

export const models = pgTable("models", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  openrouterIdentifier: varchar("openrouter_identifier", {
    length: 255,
  }).notNull().unique(),
});

// =========================
// Chats
// =========================

export const chats = pgTable(
  "chats",
  {
    id: serial("id").primaryKey(),

    title: varchar("title", { length: 255 }).notNull(),

    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    modelId: integer("model_id")
      .references(() => models.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: false })
      .defaultNow()
      .notNull(),

    updatedAt: timestamp("updated_at", { withTimezone: false })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userIdx: index("idx_chats_user_id").on(table.userId),
  })
);

// =========================
// Messages
// =========================

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),

    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),

    content: text("content").notNull(),

    role: messageRoleEnum("role").notNull(),

    createdAt: timestamp("created_at", { withTimezone: false })
      .defaultNow()
      .notNull(),

    parentMessageId: integer("parent_message_id").references(
      () => messages.id,
      { onDelete: "set null" }
    ),
  },
  (table) => ({
    chatIdx: index("idx_messages_chat_id").on(table.chatId),
    parentIdx: index("idx_messages_parent_id").on(table.parentMessageId),
  })
);

// =========================
// Relations (Optional but Recommended)
// =========================

export const usersRelations = relations(users, ({ many }) => ({
  chats: many(chats),
}));

export const chatsRelations = relations(chats, ({ one, many }) => ({
  user: one(users, {
    fields: [chats.userId],
    references: [users.id],
  }),
  model: one(models, {
    fields: [chats.modelId],
    references: [models.id],
  }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  chat: one(chats, {
    fields: [messages.chatId],
    references: [chats.id],
  }),
  parent: one(messages, {
    fields: [messages.parentMessageId],
    references: [messages.id],
  }),
  replies: many(messages),
}));

export const modelsRelations = relations(models, ({ many }) => ({
  chats: many(chats),
}));
