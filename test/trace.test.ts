import { describe, expect, it } from 'vitest';
import { formatAgentTraceEvent } from '../src/agent/trace.js';
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
    ).toContain('🤖 assistant [openai-codex/gpt-5.6-sol]: 💭 Checking the files.');

    expect(
      formatAgentTraceEvent({
        type: 'tool_execution_start',
        toolName: 'bash',
        args: { command: 'pnpm test' },
      }),
    ).toBe('🛠️ tool bash {"command":"pnpm test"}');

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

  it('bounds untrusted event text and strips newlines from labels', () => {
    const trace = formatAgentTraceEvent({
      type: 'tool_execution_start',
      toolName: 'bad\nlabel',
      args: { value: 'x'.repeat(1000) },
    });

    expect(trace).not.toContain('bad\nlabel');
    expect(trace).toContain('bad label');
    expect(trace!.length).toBeLessThan(500);
  });

  it('formats lifecycle and error events', () => {
    expect(formatAgentTraceEvent({ type: 'agent_start' })).toBe('▶️ agent started');
    expect(formatAgentTraceEvent({ type: 'agent_settled' })).toBe('⏹️ agent settled');
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
