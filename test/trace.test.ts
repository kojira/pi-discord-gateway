import { describe, expect, it } from 'vitest';
import {
  formatAgentTraceEvent,
  formatNestedSessionTraceRecord,
  MAX_NESTED_TRACE_LINES_PER_RECORD,
} from '../src/agent/trace.js';
import { splitWebhookLines } from '../src/discord/webhook-monitor.js';

describe('Pi activity trace formatting', () => {
  it('formats user, assistant, thinking, and tool activity without streaming updates', () => {
    expect(
      formatAgentTraceEvent({
        type: 'message_start',
        message: { role: 'user', content: '[Discord user: Alice]\nPlease inspect it' },
      }),
    ).toBe('👤 user: [Discord user: Alice]\nPlease inspect it');

    expect(
      formatAgentTraceEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          provider: 'openai-codex',
          model: 'gpt-5.6-sol',
          content: [
            { type: 'thinking', thinking: 'Checking the files.' },
            { type: 'text', text: 'I found the issue.' },
            { type: 'toolCall', name: 'read', arguments: { path: '/tmp/file' } },
          ],
        },
      }),
    ).toBe('🤖 assistant [openai-codex/gpt-5.6-sol]: 💭 Checking the files.\nI found the issue.');

    expect(
      formatAgentTraceEvent({
        type: 'tool_execution_start',
        toolName: 'bash',
        args: { command: 'pnpm test' },
      }),
    ).toBe('🛠️ tool bash: {"command":"pnpm test"}');

    expect(
      formatAgentTraceEvent({
        type: 'tool_execution_end',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: '70 passed' }] },
        isError: false,
      }),
    ).toBe('🔧 tool-end bash ok: 70 passed');

    expect(formatAgentTraceEvent({ type: 'message_update' })).toBeUndefined();
    expect(
      formatAgentTraceEvent({
        type: 'message_end',
        message: { role: 'toolResult', content: [{ type: 'text', text: 'duplicate' }] },
      }),
    ).toBeUndefined();
  });

  it('redacts common credentials from free-form trace text', () => {
    const trace = formatAgentTraceEvent({
      type: 'message_start',
      message: {
        role: 'user',
        content:
          'Authorization: Bearer abc123 API_TOKEN=top-secret https://discord.com/api/webhooks/123/webhook-token',
      },
    });

    expect(trace).not.toContain('abc123');
    expect(trace).not.toContain('top-secret');
    expect(trace).not.toContain('webhook-token');
    expect(trace).toContain('[REDACTED]');
  });

  it('redacts and bounds tool argument and result previews', () => {
    const secret = 'ghp_super_secret_token';
    const trace = formatAgentTraceEvent({
      type: 'tool_execution_start',
      toolName: `bad\n${'label'.repeat(100)}`,
      args: {
        Authorization: `Bearer ${secret}`,
        command: `curl ?token=${secret} ${'x'.repeat(500)}`,
      },
    });
    const result = formatAgentTraceEvent({
      type: 'tool_execution_end',
      toolName: 'bash',
      result: {
        content: [{ type: 'text', text: `API_KEY=${secret} ${'output'.repeat(300)}` }],
      },
      isError: false,
    });

    expect(trace!.split(': ').at(-1)!.length).toBeLessThanOrEqual(180);
    expect(trace).not.toContain(secret);
    expect(trace).toContain('[REDACTED]');
    expect(result).not.toContain(secret);
    expect(result).toContain('[REDACTED]');
    expect(result!.split(': ').at(-1)!.length).toBeLessThanOrEqual(1000);
  });

  it('matches the standalone session formatter’s practical content previews', () => {
    let sourceName: string | undefined;
    const records = [
      { type: 'session_info', name: 'subagent-worker' },
      { type: 'message', message: { role: 'user', content: 'please inspect' } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'openai-codex',
          model: 'gpt-test',
          content: [
            { type: 'thinking', thinking: 'checking' },
            { type: 'text', text: 'found it' },
            { type: 'toolCall', name: 'bash', arguments: { command: 'pnpm test' } },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'subagent',
          content: [{ type: 'text', text: 'review complete: no blockers' }],
          isError: false,
        },
      },
      { recordType: 'tool_start', toolName: 'read', argsPreview: '{"path":"README.md"}' },
      { recordType: 'tool_end', toolName: 'read', resultPreview: 'file contents', isError: false },
      { recordType: 'run_start' },
      { recordType: 'run_end' },
    ];
    const lines = records.flatMap((record) => {
      const formatted = formatNestedSessionTraceRecord(record, { sourceName });
      sourceName = formatted.sourceName;
      return formatted.lines;
    });

    expect(lines).toEqual([
      '🧩 child subagent-worker started',
      '👤 child[subagent-worker] user: please inspect',
      '🤖 child[subagent-worker] assistant [openai-codex/gpt-test]: 💭 checking\nfound it',
      '🛠️ child[subagent-worker] tool bash: {"command":"pnpm test"}',
      '🔧 child[subagent-worker] tool-end subagent ok: review complete: no blockers',
      '🛠️ child[subagent-worker] tool read: {"path":"README.md"}',
      '🔧 child[subagent-worker] tool-end read ok: file contents',
      '🧩 child[subagent-worker] run started',
      '🧩 child[subagent-worker] run finished',
    ]);
  });

  it('caps tool-call lines produced by one nested assistant record', () => {
    const formatted = formatNestedSessionTraceRecord(
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'child result' },
            ...Array.from({ length: 10_000 }, (_, index) => ({
              type: 'toolCall',
              name: `tool-${index}`,
              arguments: { token: 'must-not-appear' },
            })),
          ],
        },
      },
      { sourceName: 'worker' },
    );

    expect(formatted.lines).toHaveLength(MAX_NESTED_TRACE_LINES_PER_RECORD);
    expect(formatted.lines.at(-1)).toContain('additional tool calls omitted');
    expect(formatted.lines.join('\n')).not.toContain('must-not-appear');
    expect(formatted.lines.join('\n')).toContain('[REDACTED]');
  });

  it('formats lifecycle and error events', () => {
    expect(formatAgentTraceEvent({ type: 'agent_start' })).toBe('▶️ agent started');
    expect(formatAgentTraceEvent({ type: 'agent_settled' })).toBeUndefined();
    expect(formatAgentTraceEvent({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3 })).toBe(
      '🔄 retry 2/3 scheduled',
    );
    expect(
      formatAgentTraceEvent({ type: 'extension_error', event: 'tool_call', error: 'denied' }),
    ).toBe('⚠️ extension error (tool_call): denied');
  });

  it('splits webhook posts without exceeding Discord’s content limit', () => {
    const chunks = splitWebhookLines(['first line', 'x'.repeat(25), 'last line'], 12);

    expect(chunks).toEqual(['first line', 'xxxxxxxxxxxx', 'xxxxxxxxxxxx', 'x\nlast line']);
    expect(chunks.every((chunk) => chunk.length <= 12)).toBe(true);
  });
});
