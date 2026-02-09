import {
  Badge,
  Box,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  Button,
  Select,
} from "@mantine/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";

function scrollToBottom(viewport: HTMLDivElement | null, behavior: ScrollBehavior = "auto") {
  if (!viewport) return;
  viewport.scrollTo({
    top: viewport.scrollHeight,
    behavior,
  });
}

type Message = {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  status?: "streaming" | "complete" | "error";
  errorMessage?: string | null;
};

type Model = {
  id: number;
  name: string;
  openrouterIdentifier: string;
};

type ChatResponse = {
  id: number;
  title: string;
  model: null | Model;
  messages: Message[];
};

export function ChatRoute() {
  const { id } = useParams();
  const chatId = useMemo(() => Number(id), [id]);

  const [chat, setChat] = useState<ChatResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [savingModel, setSavingModel] = useState(false);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);

  async function loadChat(options: { showLoader?: boolean } = {}) {
    const { showLoader = true } = options;
    if (!Number.isFinite(chatId)) return;
    if (showLoader) {
      setLoading(true);
    }
    const res = await fetch(`/api/chats/${chatId}`);
    if (!res.ok) {
      setChat(null);
      if (showLoader) {
        setLoading(false);
      }
      return;
    }
    const data = (await res.json()) as ChatResponse;
    setChat(data);
    if (showLoader) {
      setLoading(false);
    }
    queueMicrotask(() =>
      scrollToBottom(viewportRef.current, "auto")
    );
  }

  async function loadModels() {
    setModelsLoading(true);
    try {
      const res = await fetch("/api/models");
      if (!res.ok) {
        setModels([]);
        return;
      }
      const data = (await res.json()) as Model[];
      setModels(data);
    } finally {
      setModelsLoading(false);
    }
  }

  useEffect(() => {
    loadChat();
    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  const selectedModelValue = useMemo(() => {
    // Select expects string values
    if (!chat?.model) return "__default__";
    return String(chat.model.id);
  }, [chat?.model]);

  const modelOptions = useMemo(
    () => [
      { value: "__default__", label: "Default model" },
      ...models.map((m) => ({
        value: String(m.id),
        label: m.name,
      })),
    ],
    [models]
  );

  async function persistModelSelection(value: string | null) {
    if (!chat || !Number.isFinite(chatId) || savingModel) return;

    const modelId =
      !value || value === "__default__" ? null : Number(value);

    if (value !== "__default__" && Number.isNaN(modelId)) return;

    setSavingModel(true);

    // Optimistically update UI badge + select
    setChat((prev) => {
      if (!prev) return prev;
      const nextModel =
        modelId === null ? null : models.find((m) => m.id === modelId) ?? null;
      return { ...prev, model: nextModel };
    });

    try {
      const res = await fetch(`/api/chats/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });

      if (!res.ok) {
        // rollback by reloading chat (source of truth)
        await loadChat();
        return;
      }

      // Refresh chat to ensure DB is synced (and in case model relation changes)
      await loadChat();
    } finally {
      setSavingModel(false);
    }
  }

  async function sendMessage() {
    const content = input.trim();
    if (!content || !Number.isFinite(chatId) || sending) return;

    setSending(true);
    setInput("");

    // Optimistic UI: add a user message + a streaming assistant placeholder
    const tempUserId = Date.now();
    const tempAssistantId = Date.now() + 1;

    setChat((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        messages: [
          ...prev.messages,
          {
            id: tempUserId,
            role: "user",
            content,
            createdAt: new Date().toISOString(),
            status: "complete",
          },
          {
            id: tempAssistantId,
            role: "assistant",
            content: "",
            createdAt: new Date().toISOString(),
            status: "streaming",
          },
        ],
      };
    });

    queueMicrotask(() =>
      scrollToBottom(viewportRef.current, "auto")
    );

    try {
      const res = await fetch(`/api/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        setChat((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === tempAssistantId
                ? {
                    ...m,
                    status: "error",
                    content: "",
                    errorMessage: text || "Failed to send message.",
                  }
                : m
            ),
          };
        });
        return;
      }

      // Stream assistant text chunks
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        assistantText += decoder.decode(value, { stream: true });

        setChat((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === tempAssistantId
                ? { ...m, content: assistantText, status: "streaming" }
                : m
            ),
          };
        });

        scrollToBottom(viewportRef.current, "auto"); 
      }

      // Finalize as complete
      setChat((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          messages: prev.messages.map((m) =>
            m.id === tempAssistantId ? { ...m, status: "complete" } : m
          ),
        };
      });

      // Refresh from server to replace temp ids with real ids + persisted status.
      // Avoid toggling the global `loading` state here so the ScrollArea
      // isn't unmounted/remounted (which would reset scroll to the top).
      await loadChat({ showLoader: false });

      queueMicrotask(() => scrollToBottom(viewportRef.current, "auto"));

      // Tell sidebar to reload list (title may have changed)
      window.dispatchEvent(new Event("chats:refresh"));
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <Group justify="center" mt="xl">
        <Loader />
      </Group>
    );
  }

  if (!chat) {
    return (
      <Box>
        <Text>Chat not found.</Text>
      </Box>
    );
  }

  return (
    <Stack h="calc(100vh - 40px)" gap="sm">
      <Group justify="space-between" align="center">
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text fw={700} size="lg" lineClamp={1}>
            {chat.title}
          </Text>

          {chat.model ? (
            <Badge variant="light">{chat.model.name}</Badge>
          ) : (
            <Badge variant="outline" c="dimmed">
              Default model
            </Badge>
          )}
        </Stack>

        <Select
          data={modelOptions}
          value={selectedModelValue}
          onChange={persistModelSelection}
          disabled={modelsLoading || savingModel}
          rightSection={savingModel ? <Loader size="xs" /> : undefined}
          w={260}
          placeholder="Select model"
          searchable
          nothingFoundMessage="No models"
        />
      </Group>

      <Paper withBorder p="md" style={{ flex: 1, minHeight: 0 }}>
        <ScrollArea h="100%" viewportRef={viewportRef}>
          <Stack gap="sm">
            {chat.messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
          </Stack>
        </ScrollArea>
      </Paper>

      <Paper withBorder p="md">
        <Group align="flex-end" wrap="nowrap">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            placeholder="Send a message…"
            autosize
            minRows={2}
            maxRows={6}
            style={{ flex: 1 }}
            disabled={sending}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
          />
          <Button onClick={sendMessage} loading={sending} disabled={!input.trim()}>
            Send
          </Button>
        </Group>
        <Text size="xs" c="dimmed" mt={6}>
          Enter to send, Shift+Enter for newline
        </Text>
      </Paper>
    </Stack>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const isError = message.status === "error";

  return (
    <Group justify={isUser ? "flex-end" : "flex-start"}>
      <Paper
        withBorder
        p="sm"
        radius="md"
        style={{
          maxWidth: 720,
          width: "fit-content",
          borderColor: isError ? "var(--mantine-color-red-6)" : undefined,
        }}
      >
        <Text size="sm" fw={600} c={isUser ? "blue" : "gray"}>
          {isUser ? "You" : "Assistant"}
        </Text>

        {isError ? (
          <Text size="sm" c="red">
            {message.errorMessage ?? "Something went wrong."}
          </Text>
        ) : (
          <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
            {message.content || (message.status === "streaming" ? "…" : "")}
          </Text>
        )}
      </Paper>
    </Group>
  );
}
