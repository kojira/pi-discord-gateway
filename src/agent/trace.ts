const MAX_TEXT = 1200;
const MAX_LABEL = 120;

/** Convert selected Pi RPC events into concise, bounded monitoring lines. */
export function formatAgentTraceEvent(event: any): string | undefined {
  switch (event?.type) {
    case 'agent_start':
      return '▶️ agent started';
    case 'message_start':
      if (event.message?.role !== 'user') return undefined;
      return `👤 user: ${sanitizeText(formatContent(event.message.content), MAX_TEXT)}`;
    case 'message_end':
      return formatCompletedMessage(event.message);
    case 'tool_execution_start':
      return `🛠️ tool ${safeLabel(event.toolName)}`;
    case 'tool_execution_end':
      return `🔧 tool-end ${safeLabel(event.toolName)} ${event.isError ? 'error' : 'ok'}`;
    case 'compaction_start':
      return `🗜️ compaction started${event.reason ? ` (${safeLabel(event.reason)})` : ''}`;
    case 'compaction_end':
      return `🗜️ compaction ${event.aborted ? 'aborted' : event.errorMessage ? 'failed' : 'finished'}`;
    case 'auto_retry_start':
      return `🔄 retry ${numberLabel(event.attempt)}/${numberLabel(event.maxAttempts)} scheduled`;
    case 'auto_retry_end':
      return `🔄 retry ${numberLabel(event.attempt)} ${event.success ? 'succeeded' : 'failed'}`;
    case 'extension_error':
      return `⚠️ extension error${event.event ? ` (${safeLabel(event.event)})` : ''}: ${sanitizeText(
        String(event.error || event.errorMessage || 'unknown error'),
        MAX_TEXT,
      )}`;
    default:
      return undefined;
  }
}

function formatCompletedMessage(message: any): string | undefined {
  if (message?.role !== 'assistant') return undefined;
  const content = sanitizeText(formatContent(message.content), MAX_TEXT);
  const model =
    typeof message.model === 'string'
      ? safeLabel(message.model)
      : typeof message.responseModel === 'string'
        ? safeLabel(message.responseModel)
        : '';
  const provider = typeof message.provider === 'string' ? safeLabel(message.provider) : '';
  const identity = model ? ` [${provider ? `${provider}/` : ''}${model}]` : '';
  const error =
    message.stopReason === 'error' || typeof message.errorMessage === 'string'
      ? ` ⚠️ ${sanitizeText(String(message.errorMessage || 'assistant error'), 300)}`
      : '';
  if (!content && !error) return undefined;
  return `🤖 assistant${identity}: ${content || '(no text)'}${error}`;
}

function formatContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  return content
    .map((block: any) => {
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      if (block?.type === 'thinking' && typeof block.thinking === 'string') {
        return `💭 ${block.thinking}`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function sanitizeText(text: string, max: number): string {
  const redacted = text
    .replace(
      /(https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+)\/[\w.-]+/giu,
      '$1/[REDACTED]',
    )
    .replace(
      /(\bauthorization\s*[:=]\s*)(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      '$1[REDACTED]',
    )
    .replace(
      /(\b[\w.-]*(?:api[_-]?key|token|secret|password)[\w.-]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      '$1[REDACTED]',
    )
    .replace(/\b(?:ghp_[\w]+|github_pat_[\w]+|sk-[\w-]{16,}|xox[baprs]-[\w-]+)\b/giu, '[REDACTED]');
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, Math.max(0, max - 12))}…[truncated]`;
}

function safeLabel(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'unknown';
  return sanitizeText(value.replace(/[\r\n]/gu, ' '), MAX_LABEL);
}

function numberLabel(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '?';
}
