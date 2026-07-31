/**
 * Extract the concatenated text of an assistant message's content blocks.
 *
 * Some OpenRouter providers (Gemini, DeepSeek) emit redacted_thinking blocks
 * AFTER the final text block, which makes the Claude Code SDK's
 * `result.result` fall back to null when its "last assistant message" lookup
 * lands on a thinking-only block. The runner tracks the last text-bearing
 * assistant message via this helper so the channel post stays intact.
 *
 * Returns undefined when the content is not an array or carries no
 * non-empty text blocks — callers keep their previous value in that case.
 */
export function extractAssistantText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const textParts = content.filter(
    (c): c is { type: 'text'; text: string } =>
      typeof c === 'object' &&
      c !== null &&
      (c as { type?: unknown }).type === 'text' &&
      typeof (c as { text?: unknown }).text === 'string' &&
      ((c as { text: string }).text.length > 0),
  );
  if (textParts.length === 0) return undefined;
  return textParts.map((c) => c.text).join('');
}
