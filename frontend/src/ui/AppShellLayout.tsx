import {
  AppShell,
  Button,
  Divider,
  Group,
  ScrollArea,
  Stack,
  Text,
  ActionIcon,
  Tooltip,
} from "@mantine/core";
import { Outlet, useNavigate, useParams } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { IconTrash } from "@tabler/icons-react";

type ChatListItem = { id: number; title: string; updatedAt: string };

export function AppShellLayout() {
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const navigate = useNavigate();
  const params = useParams();
  const activeId = useMemo(() => (params.id ? Number(params.id) : null), [params.id]);

  async function loadChats() {
    const res = await fetch("/api/chats");
    if (!res.ok) return;
    const data = (await res.json()) as ChatListItem[];
    setChats(data);
  }

  async function createChat() {
    const res = await fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New chat" }),
    });
    if (!res.ok) return null;
    const chat = (await res.json()) as { id: number };
    await loadChats();
    navigate(`/chats/${chat.id}`);
    return chat.id;
  }

  async function deleteChat(chatId: number) {
    if (deletingId) return;

    const chat = chats.find((c) => c.id === chatId);
    const ok = window.confirm(`Delete "${chat?.title ?? "this chat"}"? This cannot be undone.`);
    if (!ok) return;

    setDeletingId(chatId);
    try {
      const res = await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
      if (!res.ok) return;

      // Refresh list
      await loadChats();

      // If we deleted the active chat, navigate somewhere sensible
      if (activeId === chatId) {
        const remaining = chats.filter((c) => c.id !== chatId);

        if (remaining.length > 0) {
          // Prefer the first in the remaining list (your API already sorts by updatedAt desc)
          navigate(`/chats/${remaining[0].id}`);
        } else {
          // No chats left — create a new one
          await createChat();
        }
      }
    } finally {
      setDeletingId(null);
    }
  }

  useEffect(() => {
    loadChats();
  }, []);

  return (
    <AppShell
      padding="md"
      navbar={{
        width: 320,
        breakpoint: "sm",
      }}
    >
      <AppShell.Navbar p="md">
        <Stack gap="sm" h="100%">
          {/* Header */}
          <Group justify="space-between">
            <Text fw={700}>Chats</Text>
            <Button size="xs" onClick={createChat}>
              New
            </Button>
          </Group>

          {/* Chat list */}
          <ScrollArea h="calc(100vh - 180px)">
            <Stack gap={6}>
              {chats.map((c) => {
                const isActive = activeId === c.id;

                return (
                  <Group key={c.id} gap={6} wrap="nowrap">
                    <Button
                      variant={isActive ? "light" : "subtle"}
                      justify="flex-start"
                      onClick={() => navigate(`/chats/${c.id}`)}
                      styles={{ inner: { justifyContent: "flex-start" } }}
                      style={{ flex: 1, minWidth: 0 }}
                    >
                      {c.title}
                    </Button>

                    <Tooltip label="Delete chat">
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteChat(c.id);
                        }}
                        loading={deletingId === c.id}
                        aria-label="Delete chat"
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                );
              })}
            </Stack>
          </ScrollArea>

          {/* Bottom actions */}
          <Divider />

          <Button
            variant="subtle"
            justify="flex-start"
            onClick={() => navigate("/settings")}
            styles={{ inner: { justifyContent: "flex-start" } }}
          >
            Settings
          </Button>
        </Stack>
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
