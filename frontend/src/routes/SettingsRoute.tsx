import {
  ActionIcon,
  Box,
  Button,
  Group,
  Loader,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { IconTrash } from "@tabler/icons-react";

type Model = {
  id: number;
  name: string;
  openrouterIdentifier: string;
};

export function SettingsRoute() {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [openrouterIdentifier, setOpenrouterIdentifier] = useState("");

  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = useMemo(
    () => name.trim().length > 0 && openrouterIdentifier.trim().length > 0,
    [name, openrouterIdentifier]
  );

  async function loadModels() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/models");
      if (!res.ok) {
        setError("Failed to load models.");
        setModels([]);
        return;
      }
      const data = (await res.json()) as Model[];
      setModels(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadModels();
  }, []);

  async function addModel() {
    if (!canSubmit || saving) return;
    setSaving(true);
    setError(null);

    try {
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          openrouterIdentifier: openrouterIdentifier.trim(),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        // Your backend returns 409 on duplicate with { error, field }
        if (res.status === 409) {
          setError("That OpenRouter identifier already exists.");
        } else {
          setError(body?.error ?? "Failed to add model.");
        }
        return;
      }

      setName("");
      setOpenrouterIdentifier("");
      await loadModels();
    } finally {
      setSaving(false);
    }
  }

  async function deleteModel(id: number) {
    if (deletingId) return;
    setDeletingId(id);
    setError(null);

    try {
      const res = await fetch(`/api/models/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "Failed to delete model.");
        return;
      }
      await loadModels();
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Stack gap="md">
      <Group justify="space-between" align="baseline">
        <Title order={2}>Settings</Title>
        <Text c="dimmed">Models</Text>
      </Group>

      <Paper withBorder p="md">
        <Stack gap="sm">
          <Text fw={600}>Add model</Text>

          <Group align="flex-end" wrap="nowrap">
            <TextInput
              label="Name"
              placeholder="e.g. GPT-4o Mini"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              style={{ flex: 1 }}
              disabled={saving}
            />
            <TextInput
              label="OpenRouter identifier"
              placeholder="e.g. openai/gpt-4o-mini"
              value={openrouterIdentifier}
              onChange={(e) => setOpenrouterIdentifier(e.currentTarget.value)}
              style={{ flex: 2 }}
              disabled={saving}
            />
            <Button onClick={addModel} loading={saving} disabled={!canSubmit}>
              Add
            </Button>
          </Group>

          {error ? (
            <Box>
              <Text c="red" size="sm">
                {error}
              </Text>
            </Box>
          ) : null}
        </Stack>
      </Paper>

      <Paper withBorder p="md">
        <Group justify="space-between" mb="sm">
          <Text fw={600}>Available models</Text>
          <Button variant="subtle" onClick={loadModels} disabled={loading}>
            Refresh
          </Button>
        </Group>

        {loading ? (
          <Group justify="center" py="xl">
            <Loader />
          </Group>
        ) : models.length === 0 ? (
          <Text c="dimmed">No models yet. Add one above.</Text>
        ) : (
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ width: 80 }}>ID</Table.Th>
                <Table.Th>Name</Table.Th>
                <Table.Th>Identifier</Table.Th>
                <Table.Th style={{ width: 80 }} />
              </Table.Tr>
            </Table.Thead>

            <Table.Tbody>
              {models.map((m) => (
                <Table.Tr key={m.id}>
                  <Table.Td>{m.id}</Table.Td>
                  <Table.Td>{m.name}</Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {m.openrouterIdentifier}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label="Delete model">
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        onClick={() => deleteModel(m.id)}
                        loading={deletingId === m.id}
                        aria-label="Delete model"
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Paper>
    </Stack>
  );
}
