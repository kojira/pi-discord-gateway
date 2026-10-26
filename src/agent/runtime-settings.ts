/** Runtime settings are parent-local; this never retires a process or its children. */
export interface RuntimeSettings {
  model?: string;
  thinking?: string;
  processIdentity: string;
}

export interface SettingsRpcResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

export type SettingsAdmission =
  { ready: true; revision?: number } | { ready: false; reason: string };

interface RuntimeState {
  capabilities?: { guardedSettings?: number };
  settingsRevision?: number;
  model?: { provider?: string; id?: string };
  thinkingLevel?: string;
}

function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** One transaction at a time, shared by background reconciliation and prompt admission. */
export class RuntimeSettingsReconciler {
  private inFlight?: Promise<SettingsAdmission>;
  private lastManaged: RuntimeSettings;
  private status = 'Runtime settings not yet verified';
  private managedModel: boolean;
  private managedThinking: boolean;

  constructor(
    private readonly launched: RuntimeSettings,
    private readonly desired: () => RuntimeSettings,
    private readonly send: (command: Record<string, unknown>) => Promise<SettingsRpcResponse>,
    private readonly isCurrent: () => boolean,
  ) {
    this.lastManaged = launched;
    this.managedModel = Boolean(launched.model);
    this.managedThinking = Boolean(launched.thinking);
  }

  describe(): string {
    return this.matchesDesired() ? this.status : `Desired settings pending. ${this.status}`;
  }

  matchesDesired(): boolean {
    return JSON.stringify(this.desired()) === JSON.stringify(this.lastManaged);
  }

  reconcile(): Promise<SettingsAdmission> {
    if (this.inFlight) return this.inFlight;
    const operation = this.apply().catch((error: unknown) =>
      this.pending(error instanceof Error ? error.message : String(error)),
    );
    this.inFlight = operation;
    void operation.finally(() => {
      if (this.inFlight === operation) this.inFlight = undefined;
    });
    return operation;
  }

  private pending(reason: string): SettingsAdmission {
    this.status = `Pending: ${reason}`;
    return { ready: false, reason };
  }

  private async apply(): Promise<SettingsAdmission> {
    const desired = this.desired();
    const unchanged = () =>
      this.isCurrent() && JSON.stringify(this.desired()) === JSON.stringify(desired);
    if (desired.processIdentity !== this.launched.processIdentity) {
      return this.pending(
        'Executable, working directory or arguments changed; retained work is preserved. Safe process retirement is not verified.',
      );
    }
    if ((!desired.model && this.managedModel) || (!desired.thinking && this.managedThinking)) {
      return this.pending(
        'Implicit Pi defaults cannot be resolved on a retained connection; choose explicit settings.',
      );
    }
    const response = await this.send({ type: 'get_state' });
    if (!unchanged())
      return this.pending('Desired settings changed or connection closed during verification');
    if (!response.success)
      return this.pending(response.error || 'Could not verify runtime settings');
    const state = response.data as RuntimeState | undefined;
    if (state?.capabilities?.guardedSettings !== 1) {
      // Unchanged legacy launch settings keep the existing protocol. Never mutate
      // an older runtime based on an idle snapshot or silently reuse a changed selection.
      if (JSON.stringify(desired) !== JSON.stringify(this.launched)) {
        return this.pending('Pi update required for guarded runtime settings');
      }
      this.status = 'Launch settings unchanged (runtime verification requires Pi update)';
      return { ready: true };
    }
    if (!revision(state.settingsRevision)) return this.pending('Invalid Pi settings revision');
    const actualModel =
      state.model?.provider && state.model.id
        ? `${state.model.provider}/${state.model.id}`
        : undefined;
    const agrees = (model: string | undefined, thinking: string | undefined) =>
      (!desired.model || desired.model === model) &&
      (!desired.thinking || desired.thinking === thinking);
    if (agrees(actualModel, state.thinkingLevel)) {
      this.lastManaged = desired;
      this.status = `Applied: ${actualModel || '(none)'} / ${state.thinkingLevel || '(unknown)'}`;
      return { ready: true, revision: state.settingsRevision };
    }
    let provider: string | undefined;
    let modelId: string | undefined;
    if (desired.model) {
      const slash = desired.model.indexOf('/');
      if (slash <= 0 || slash === desired.model.length - 1) {
        return this.pending(
          'Choose a canonical provider/model reference for runtime reconciliation',
        );
      }
      provider = desired.model.slice(0, slash);
      modelId = desired.model.slice(slash + 1);
    }
    // A lost ACK can still mean the mutation committed. An implicit reset must
    // not be mistaken for omission/retain even after a superseding selection.
    this.managedModel ||= Boolean(desired.model);
    this.managedThinking ||= Boolean(desired.thinking);
    const applied = await this.send({
      type: 'set_runtime_settings',
      expectedRevision: state.settingsRevision,
      ...(provider ? { provider, modelId } : {}),
      ...(desired.thinking ? { thinkingLevel: desired.thinking } : {}),
    });
    if (!unchanged())
      return this.pending('Desired settings changed or connection closed during reconciliation');
    if (!applied.success) return this.pending(applied.error || 'Pi rejected runtime settings');
    const data = applied.data as
      (RuntimeState & { applied?: boolean; reason?: string }) | undefined;
    if (data?.applied === false && ['busy', 'revision_changed'].includes(data.reason || '')) {
      return this.pending(`Pi ${data.reason}; retrying automatically`);
    }
    const appliedModel =
      data?.model?.provider && data.model.id
        ? `${data.model.provider}/${data.model.id}`
        : undefined;
    if (
      data?.applied !== true ||
      !revision(data.settingsRevision) ||
      !agrees(appliedModel, data.thinkingLevel)
    ) {
      return this.pending('Pi did not acknowledge the desired effective model and thinking level');
    }
    this.lastManaged = desired;
    this.status = `Applied: ${appliedModel || '(none)'} / ${data.thinkingLevel || '(unknown)'}`;
    return { ready: true, revision: data.settingsRevision };
  }
}
