const MAX_TEXT = 1200;
const MAX_LABEL = 120;
export const MAX_NESTED_TRACE_LINES_PER_RECORD = 5;

export interface NestedSessionTraceContext {
  sourceName?: string;
}

/** Convert selected Pi RPC events into concise, bounded monitoring lines. */
export function formatAgentTraceEvent(event: any): string | undefined {
  switch (event?.type) {
    case 'agent_start':
      return '▶️ agent started';
    case 'message_start':
      if (event.message?.role !== 'user') return undefined;
      return `👤 user: ${sanitizeTraceText(formatContent(event.message.content), MAX_TEXT)}`;
    case 'message_end':
      return formatCompletedMessage(event.message);
    case 'tool_execution_start':
      return `🛠️ tool ${safeTraceLabel(event.toolName)}`;
    case 'tool_execution_end':
      return `🔧 tool-end ${safeTraceLabel(event.toolName)} ${event.isError ? 'error' : 'ok'}`;
    case 'compaction_start':
      return `🗜️ compaction started${event.reason ? ` (${safeTraceLabel(event.reason)})` : ''}`;
    case 'compaction_end':
      return `🗜️ compaction ${event.aborted ? 'aborted' : event.errorMessage ? 'failed' : 'finished'}`;
    case 'auto_retry_start':
      return `🔄 retry ${numberLabel(event.attempt)}/${numberLabel(event.maxAttempts)} scheduled`;
    case 'auto_retry_end':
      return `🔄 retry ${numberLabel(event.attempt)} ${event.success ? 'succeeded' : 'failed'}`;
    case 'extension_error':
      return `⚠️ extension error${event.event ? ` (${safeTraceLabel(event.event)})` : ''}: ${sanitizeTraceText(
        String(event.error || event.errorMessage || 'unknown error'),
        MAX_TEXT,
      )}`;
    default:
      return undefined;
  }
}

function formatCompletedMessage(message: any): string | undefined {
  if (message?.role !== 'assistant') return undefined;
  const content = sanitizeTraceText(formatContent(message.content), MAX_TEXT);
  const model =
    typeof message.model === 'string'
      ? safeTraceLabel(message.model)
      : typeof message.responseModel === 'string'
        ? safeTraceLabel(message.responseModel)
        : '';
  const provider = typeof message.provider === 'string' ? safeTraceLabel(message.provider) : '';
  const identity = model ? ` [${provider ? `${provider}/` : ''}${model}]` : '';
  const error =
    message.stopReason === 'error' || typeof message.errorMessage === 'string'
      ? ` ⚠️ ${sanitizeTraceText(String(message.errorMessage || 'assistant error'), 300)}`
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

/** Redact common credentials and bound model-visible monitoring text. */
export function sanitizeTraceText(text: string, max = MAX_TEXT): string {
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

export function safeTraceLabel(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'unknown';
  return sanitizeTraceText(value.replace(/[\r\n]/gu, ' '), MAX_LABEL);
}

/**
 * Format a completed record from a nested Pi session. This intentionally omits
 * arguments, result bodies, details, and signatures; child assistant output is
 * the only free-form payload forwarded.
 */
export function formatNestedSessionTraceRecord(
  record: any,
  context: NestedSessionTraceContext = {},
): { lines: string[]; sourceName?: string } {
  let sourceName = context.sourceName;
  if (record?.type === 'session_info') {
    sourceName = safeTraceLabel(record.name || 'subagent');
    return { lines: [`🧩 child ${sourceName} started`], sourceName };
  }

  const child = `child[${safeTraceLabel(sourceName || 'subagent')}]`;
  if (record?.type === 'message' || record?.recordType === 'message') {
    const message = record.message ?? record;
    if (message?.role === 'user') {
      const text = sanitizeTraceText(formatContent(message.content));
      return { lines: text ? [`👤 ${child} user: ${text}`] : [], sourceName };
    }
    if (message?.role === 'assistant') {
      const lines: string[] = [];
      const text = sanitizeTraceText(formatContent(message.content));
      const model = typeof message.model === 'string' ? safeTraceLabel(message.model) : '';
      const provider = typeof message.provider === 'string' ? safeTraceLabel(message.provider) : '';
      const identity = model ? ` [${provider ? `${provider}/` : ''}${model}]` : '';
      const error =
        message.stopReason === 'error' || typeof message.errorMessage === 'string'
          ? ` ⚠️ ${sanitizeTraceText(String(message.errorMessage || 'assistant error'), 300)}`
          : '';
      if (text || error)
        lines.push(`🤖 ${child} assistant${identity}: ${text || '(no text)'}${error}`);
      const toolCalls = (Array.isArray(message.content) ? message.content : []).filter(
        (block: any) => block?.type === 'toolCall',
      );
      const available = MAX_NESTED_TRACE_LINES_PER_RECORD - lines.length;
      const visibleTools = toolCalls.slice(
        0,
        Math.max(0, available - (toolCalls.length > available ? 1 : 0)),
      );
      for (const block of visibleTools) {
        lines.push(`🛠️ ${child} tool ${safeTraceLabel(block.name)}`);
      }
      const omitted = toolCalls.length - visibleTools.length;
      if (omitted > 0 && lines.length < MAX_NESTED_TRACE_LINES_PER_RECORD) {
        lines.push(
          `⚠️ ${child} ${omitted} additional tool call${omitted === 1 ? '' : 's'} omitted`,
        );
      }
      return { lines, sourceName };
    }
    if (message?.role === 'toolResult') {
      return {
        lines: [
          `🔧 ${child} tool-end ${safeTraceLabel(message.toolName)} ${message.isError ? 'error' : 'ok'}`,
        ],
        sourceName,
      };
    }
    return { lines: [], sourceName };
  }

  if (record?.recordType === 'tool_start') {
    return {
      lines: [`🛠️ ${child} tool ${safeTraceLabel(record.toolName)}`],
      sourceName,
    };
  }
  if (record?.recordType === 'tool_end') {
    return {
      lines: [
        `🔧 ${child} tool-end ${safeTraceLabel(record.toolName)} ${record.isError ? 'error' : 'ok'}`,
      ],
      sourceName,
    };
  }
  if (record?.recordType === 'run_start' || record?.recordType === 'run_end') {
    return {
      lines: [`🧩 ${child} ${record.recordType === 'run_start' ? 'run started' : 'run finished'}`],
      sourceName,
    };
  }
  if (record?.type === 'extension_error') {
    return {
      lines: [
        `⚠️ ${child} extension error${record.event ? ` (${safeTraceLabel(record.event)})` : ''}: ${sanitizeTraceText(
          String(record.error || record.errorMessage || 'unknown error'),
        )}`,
      ],
      sourceName,
    };
  }
  return { lines: [], sourceName };
}

function numberLabel(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '?';
}
