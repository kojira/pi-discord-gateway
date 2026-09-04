const MAX_TEXT = 1200;
const MAX_ARGUMENTS = 400;

/** Convert selected Pi RPC events into concise, bounded monitoring lines. */
export function formatAgentTraceEvent(event: any): string | undefined {
  switch (event?.type) {
    case 'agent_start':
      return '▶️ agent started';
    case 'agent_settled':
      return '⏹️ agent settled';
    case 'message_start':
      if (event.message?.role !== 'user') return undefined;
      return `👤 user: ${truncate(formatContent(event.message.content), MAX_TEXT)}`;
    case 'message_end':
      return formatCompletedMessage(event.message);
    case 'tool_execution_start':
      return `🛠️ tool ${safeLabel(event.toolName)}${formatArguments(event.args)}`;
    case 'tool_execution_end': {
      const status = event.isError ? 'error' : 'ok';
      const result = truncate(formatContent(event.result?.content), MAX_TEXT);
      return `🔧 tool-end ${safeLabel(event.toolName)} ${status}${result ? `: ${result}` : ''}`;
    }
    case 'compaction_start':
      return `🗜️ compaction started${event.reason ? ` (${safeLabel(event.reason)})` : ''}`;
    case 'compaction_end':
      return `🗜️ compaction ${event.aborted ? 'aborted' : event.errorMessage ? 'failed' : 'finished'}`;
    case 'auto_retry_start':
      return `🔄 retry ${numberLabel(event.attempt)}/${numberLabel(event.maxAttempts)} scheduled`;
    case 'auto_retry_end':
      return `🔄 retry ${numberLabel(event.attempt)} ${event.success ? 'succeeded' : 'failed'}`;
    case 'extension_error':
      return `⚠️ extension error${event.event ? ` (${safeLabel(event.event)})` : ''}: ${truncate(
        String(event.error || event.errorMessage || 'unknown error'),
        MAX_TEXT,
      )}`;
    default:
      return undefined;
  }
}

function formatCompletedMessage(message: any): string | undefined {
  if (message?.role !== 'assistant') return undefined;
  const content = truncate(formatContent(message.content), MAX_TEXT);
  const model =
    typeof message.model === 'string'
      ? message.model
      : typeof message.responseModel === 'string'
        ? message.responseModel
        : '';
  const provider = typeof message.provider === 'string' ? message.provider : '';
  const identity = model ? ` [${provider ? `${provider}/` : ''}${model}]` : '';
  const error =
    message.stopReason === 'error' || typeof message.errorMessage === 'string'
      ? ` ⚠️ ${truncate(String(message.errorMessage || 'assistant error'), 300)}`
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
      if (block?.type === 'toolCall') {
        return `🛠️ ${safeLabel(block.name)}${formatArguments(block.arguments)}`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function formatArguments(args: unknown): string {
  if (args === undefined || args === null) return '';
  try {
    return ` ${truncate(JSON.stringify(args), MAX_ARGUMENTS)}`;
  } catch {
    return ' [unserializable arguments]';
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 12))}…[truncated]`;
}

function safeLabel(value: unknown): string {
  return typeof value === 'string' && value ? value.replace(/[\r\n]/gu, ' ') : 'unknown';
}

function numberLabel(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '?';
}
