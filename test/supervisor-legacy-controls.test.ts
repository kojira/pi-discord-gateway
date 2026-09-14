import { describe, expect, it, vi } from 'vitest';
import { handleInteraction } from '../src/discord/client.js';

// Old Discord messages survive gateway upgrades. They must never answer a child.
describe('retired supervisor controls', () => {
  for (const kind of ['button', 'modal']) {
    for (const action of ['once', 'always', 'best', 'cancel']) {
      it(`${kind} ${action} only reports retirement`, async () => {
        const reply = vi.fn().mockResolvedValue(undefined);
        const showModal = vi.fn();
        const getTextInputValue = vi.fn();
        await handleInteraction({
          customId: `${kind === 'button' ? 'supervisor' : 'supervisor-modal'}:${action}:old-request`,
          isButton: () => kind === 'button',
          isModalSubmit: () => kind === 'modal',
          isAutocomplete: () => false,
          isChatInputCommand: () => false,
          reply,
          showModal,
          fields: { getTextInputValue },
        } as any);
        expect(reply).toHaveBeenCalledExactlyOnceWith({
          content: 'この内部相談は親エージェントが処理します。この操作は無効です。',
          ephemeral: true,
          allowedMentions: { parse: [] },
        });
        expect(showModal).not.toHaveBeenCalled();
        expect(getTextInputValue).not.toHaveBeenCalled();
      });
    }
  }
});
