export function extractSseDataLines(sseEvent: string): string[] {
  const lines = sseEvent.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) out.push(line.slice(5).trim());
  }
  return out;
}
