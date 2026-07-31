/**
 * Thread-window helper for agent-runner.
 *
 * Bounds the SDK's session-log replay on `resume: sessionId` by returning a
 * UUID anchor that the caller passes as `resumeSessionAt`. The SDK loads
 * messages from that UUID forward per its parent-UUID chain — effectively
 * windowing replay to the last N assistant turns.
 *
 * Without this cap, Aria's per-group session JSONL accumulates every turn
 * across days of Slack traffic; once it exceeds the model's max input, every
 * request returns "Prompt is too long" (see feedback-aria-session-bloat).
 *
 * Pure function: reads the JSONL, scans lines, returns a UUID or undefined.
 * Never mutates the file, never touches process state.
 */
import fs from 'fs';

export const DEFAULT_THREAD_WINDOW = 15;
export const THREAD_WINDOW_ENV_VAR = 'THREAD_WINDOW';

/**
 * Return the UUID of the N-th-last assistant message in a session JSONL.
 *
 * Returns undefined when:
 *   - windowSize <= 0 (disable-anchor sentinel)
 *   - the file is missing or unreadable
 *   - the log has fewer than windowSize assistant messages (SDK falls
 *     through to its own "latest" pick)
 *   - the target assistant entry lacks a uuid field (defensive against SDK
 *     schema drift)
 *
 * @param jsonlPath  Absolute path to the session JSONL (per-session file).
 * @param windowSize How many trailing assistant turns to keep in replay.
 */
export function findResumeAnchor(
  jsonlPath: string,
  windowSize: number,
): string | undefined {
  if (windowSize <= 0) return undefined;

  let contents: string;
  try {
    contents = fs.readFileSync(jsonlPath, 'utf-8');
  } catch {
    return undefined;
  }

  const assistantUuids: string[] = [];
  for (const line of contents.split('\n')) {
    if (!line) continue;
    let parsed: { type?: string; uuid?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== 'assistant') continue;
    if (typeof parsed.uuid !== 'string' || parsed.uuid.length === 0) continue;
    assistantUuids.push(parsed.uuid);
  }

  if (assistantUuids.length < windowSize) return undefined;

  return assistantUuids[assistantUuids.length - windowSize];
}
