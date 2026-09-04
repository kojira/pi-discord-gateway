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
    ).toBe('🤖 assistant [openai-codex/gpt-5.6-sol]: 💭 Checking the files.\nI found the issue.');

    expect(
      formatAgentTraceEvent({
        type: 'tool_execution_start',
        toolName: 'bash',
        args: { command: 'pnpm test' },
      }),
    ).toBe('🛠️ tool bash');

    expect(
      formatAgentTraceEvent({
        type: 'tool_execution_end',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: '70 passed' }] },
        isError: false,
      }),
    ).toBe('🔧 tool-end bash ok');

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

  it('keeps tool traces metadata-only and bounds untrusted labels', () => {
    const secret = 'ghp_super_secret_token';
    const trace = formatAgentTraceEvent({
      type: 'tool_execution_start',
      toolName: `bad\n${'label'.repeat(100)}`,
      args: { Authorization: `Bearer ${secret}`, command: `curl ?token=${secret}` },
    });
    const result = formatAgentTraceEvent({
      type: 'tool_execution_end',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: `API_KEY=${secret}` }] },
      isError: false,
    });

    expect(trace).not.toContain('\n');
    expect(trace).not.toContain(secret);
    expect(trace!.length).toBeLessThan(150);
    expect(result).toBe('🔧 tool-end bash ok');
    expect(result).not.toContain(secret);
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
