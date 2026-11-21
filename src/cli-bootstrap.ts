export type CliRuntimeState = {
  installed: boolean;
  status: 'unknown' | 'installing' | 'ready' | 'failed';
  version?: string;
  error?: string;
};

type DependencyRequest = <M extends 'native.status' | 'native.install'>(
  method: M,
  params: { dependencyId: string },
  options: { timeoutMs: number },
) => Promise<unknown>;

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : '';
}

export function isTemporarilyUnavailable(error: unknown): boolean {
  return errorCode(error) === 'temporarily_unavailable';
}

function formatInstallError(error: unknown): string {
  if (errorCode(error) === 'unsupported_method') {
    return '请更新 ViTalk 桌面端后再安装飞书插件运行环境。';
  }
  const message = error instanceof Error ? error.message.trim() : '';
  return message || '飞书运行组件下载未完成，请检查网络后重试。';
}

function notify(eventName: string) {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(eventName));
  }
}

export function createCliBootstrap(getRequest: () => DependencyRequest) {
  let state: CliRuntimeState = { installed: false, status: 'unknown' };
  let statusInflight: Promise<unknown> | undefined;
  let installInflight: Promise<unknown> | undefined;

  function setState(next: CliRuntimeState, notifyWorkspace = false) {
    state = next;
    notify('feishu-cli-state-changed');
    if (notifyWorkspace) notify('feishu-workspace-changed');
  }

  async function requestStatus(timeoutMs = 60_000): Promise<unknown> {
    statusInflight ??= getRequest()('native.status', { dependencyId: 'lark-cli' }, { timeoutMs })
      .then((raw) => {
        const installed = !!(raw && typeof raw === 'object' && (raw as { installed?: unknown }).installed === true);
        const version =
          raw && typeof raw === 'object' && typeof (raw as { version?: unknown }).version === 'string'
            ? ((raw as { version: string }).version)
            : undefined;
        if (installed) {
          state = { installed: true, status: 'ready', ...(version ? { version } : {}) };
        } else if (!installInflight && state.status !== 'failed') {
          state = { installed: false, status: 'unknown' };
        }
        return raw;
      })
      .catch((error) => {
        if (errorCode(error) === 'unsupported_method') {
          throw Error('请更新 ViTalk 桌面端后再安装飞书插件运行环境。');
        }
        throw error;
      })
      .finally(() => {
        statusInflight = undefined;
      });
    return statusInflight;
  }

  function startInstall(timeoutMs = 210_000): Promise<unknown> {
    if (!installInflight) {
      setState({ installed: false, status: 'installing' });
      const current = getRequest()('native.install', { dependencyId: 'lark-cli' }, { timeoutMs })
        .then(
          (raw) => {
            if (installInflight === current) {
              installInflight = undefined;
              const version =
                raw && typeof raw === 'object' && typeof (raw as { version?: unknown }).version === 'string'
                  ? ((raw as { version: string }).version)
                  : undefined;
              setState({ installed: true, status: 'ready', ...(version ? { version } : {}) }, true);
            }
            return raw;
          },
          (error) => {
            const formatted = formatInstallError(error);
            if (installInflight === current) {
              installInflight = undefined;
              setState({ installed: false, status: 'failed', error: formatted }, true);
            }
            throw Error(formatted);
          },
        );
      void current.catch(() => {});
      installInflight = current;
    }
    return installInflight;
  }

  return {
    getState: (): CliRuntimeState => ({ ...state }),
    needsInteractiveInstall(): boolean {
      return !state.installed && Boolean(installInflight || state.status === 'installing' || state.status === 'failed');
    },
    markInstalled(version?: string) {
      if (!state.installed || state.status !== 'ready') {
        state = { installed: true, status: 'ready', ...(version ?? state.version ? { version: version ?? state.version } : {}) };
      }
    },
    status: requestStatus,
    install(options?: { manual?: boolean; timeoutMs?: number }): Promise<unknown> {
      const task = startInstall(options?.timeoutMs ?? 210_000);
      if (options?.manual) return task;
      return task.catch(() => ({ installed: false, managed: true }));
    },
    async ensureInstalledForInteractive(): Promise<void> {
      if (state.installed) return;
      if (installInflight || state.status === 'installing' || state.status === 'failed') {
        await startInstall();
      }
    },
    async recoverMissingCliFromRead(error: unknown): Promise<CliRuntimeState | null> {
      const code = errorCode(error);
      if (code === 'dependency_not_installed') {
        if (state.status !== 'installing' && state.status !== 'failed') {
          void startInstall().catch(() => {});
        }
        return { ...state };
      }
      if (code === 'native_outcome_unknown') {
        try {
          const raw = await requestStatus();
          const installed = !!(raw && typeof raw === 'object' && (raw as { installed?: unknown }).installed === true);
          if (!installed) {
            if (state.status !== 'installing' && state.status !== 'failed') {
              void startInstall().catch(() => {});
            }
            return { ...state };
          }
        } catch {
          return null;
        }
      }
      return null;
    },
    reset() {
      state = { installed: false, status: 'unknown' };
      statusInflight = undefined;
      installInflight = undefined;
    },
  };
}
