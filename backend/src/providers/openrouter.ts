import { extractSseDataLines } from "../utils/sse";

type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

type StreamHandlers = {
  onDelta: (delta: string) => Promise<void> | void;
  onError: (statusCode: number, rawBody: string) => Promise<void> | void;
  onDone: () => Promise<void> | void;
  signal?: AbortSignal;
};

export async function openRouterStreamChat(opts: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  referer?: string;
  title?: string;
  handlers: StreamHandlers;
}) {
  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": opts.referer ?? "http://localhost:3000",
      "X-Title": opts.title ?? "AI Chat (take-home)",
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: true,
    }),
    signal: opts.signal,
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    await opts.handlers.onError(upstream.status, text);
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
          await opts.handlers.onDone();
          return;
        }

        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }

        if (json?.error) {
          await opts.handlers.onError(500, JSON.stringify(json));
          return;
        }

        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length) {
          await opts.handlers.onDelta(delta);
        }
      }
    }
  }

  // If the upstream ends without [DONE], treat as done; caller can decide if empty is error.
  await opts.handlers.onDone();
}

export async function openRouterGenerateTitle(opts: {
  apiKey: string;
  model: string;
  userContent: string;
  signal?: AbortSignal;
  referer?: string;
  title?: string;
}): Promise<string | null> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": opts.referer ?? "http://localhost:3000",
        "X-Title": opts.title ?? "AI Chat (take-home)",
      },
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "Generate a short, concise title (maximum 5 words) for this conversation based on the user's first message. Return only the title, nothing else.",
          },
          { role: "user", content: opts.userContent },
        ],
      }),
      signal: opts.signal,
    });

    if (!res.ok) return null;

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;

    // remove quotes + clamp
    let clean = raw.replace(/^["']|["']$/g, "").trim();
    if (clean.length > 100) clean = clean.slice(0, 100);
    return clean || null;
  } catch {
    return null;
  }
}
