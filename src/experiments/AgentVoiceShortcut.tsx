import { useCallback, useEffect, useRef, useState, type FocusEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  buildModifierPreviewHotkey,
  buildPluginHotkeyFromKeyboardEvent,
  detectHotkeyPlatform,
  formatHotkeyParts,
  isModifierKey,
} from "../lib/hotkeys";
import { experimentsRequest, type ExperimentsConfig } from "./client";
import "./agent-voice-shortcut.css";

type Purpose = "message" | "task" | "calendar";
type Phase = "idle" | "starting" | "listening" | "saving" | "restoring";

const HOTKEY_CAPTURE_SETTLE_MS = 160;
const HOTKEY_CAPTURE_WATCHDOG_MS = 15_000;

const actions: { purpose: Purpose; label: string; description: string }[] = [
  {
    purpose: "message",
    label: "消息",
    description: "按一次开始，再按一次结束；生成草稿后确认发送。",
  },
  {
    purpose: "task",
    label: "任务",
    description: "按一次开始，再按一次结束；按指令创建或处理任务。",
  },
  {
    purpose: "calendar",
    label: "日程",
    description: "按一次开始，再按一次结束；按指令创建或处理日程。",
  },
];

// The native protocol pauses capture with a boolean. Serialize transitions and
// track the owner so a late cleanup cannot resume shortcuts in a newer capture.
let nativeTransition: Promise<unknown> = Promise.resolve();
let queuedTransitions = 0;
let captureOwner: symbol | undefined;

function transition<T>(work: () => Promise<T>): Promise<T> {
  // Start an idle release synchronously: pagehide disposes the SDK immediately
  // after React cleanup, so deferring the send to a microtask can drop it.
  const idle = queuedTransitions === 0;
  queuedTransitions++;
  let result: Promise<T>;
  try {
    result = idle ? work() : nativeTransition.then(work, work);
  } catch (error) {
    result = Promise.reject(error);
  }
  nativeTransition = result.then(
    (value) => {
      queuedTransitions--;
      return value;
    },
    () => {
      queuedTransitions--;
    },
  );
  return result;
}

function acquireCapture() {
  const owner = Symbol("shortcut capture");
  let cancelled = false;
  let releasing: Promise<void> | undefined;
  const ready = transition(async () => {
    if (cancelled) return;
    captureOwner = owner;
    await experimentsRequest({ action: "feishuShortcutCapture", active: true });
  });
  return {
    ready,
    release() {
      cancelled = true;
      if (releasing) return releasing;
      releasing = transition(async () => {
        if (captureOwner !== owner) return;
        await experimentsRequest({
          action: "feishuShortcutCapture",
          active: false,
        });
        captureOwner = undefined;
      }).catch((error) => {
        releasing = undefined;
        throw error;
      });
      return releasing;
    },
  };
}

type Capture = ReturnType<typeof acquireCapture>;
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function shortcutFromKey(
  event: Pick<
    KeyboardEvent,
    "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code"
  > & { key?: string },
) {
  return buildPluginHotkeyFromKeyboardEvent({
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    code: event.code,
    key: event.key ?? "",
  });
}

export function AgentVoiceShortcut({
  config,
  enabled,
  onToggleEnabled,
  onSaved,
}: {
  config: ExperimentsConfig;
  enabled: boolean;
  onToggleEnabled: () => void;
  onSaved?: () => void;
}) {
  const platform = detectHotkeyPlatform();
  const [listening, setListening] = useState<Purpose | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [previewHotkey, setPreviewHotkey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [errorPurpose, setErrorPurpose] = useState<Purpose | null>(null);
  const [feedback, setFeedback] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [confirmed, setConfirmed] = useState<Partial<Record<Purpose, string>>>(
    {},
  );

  const mounted = useRef(true);
  const version = useRef(0);
  const pending = useRef(false);
  const lease = useRef<Capture | null>(null);
  const buttons = useRef<Partial<Record<Purpose, HTMLButtonElement | null>>>(
    {},
  );
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const recentlyReleasedModifierKeysRef = useRef<Set<string>>(new Set());
  const pendingHotkeyRef = useRef<string | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const watchdogTimerRef = useRef<number | null>(null);
  const listeningRef = useRef<Purpose | null>(null);
  const phaseRef = useRef<Phase>("idle");
  listeningRef.current = listening;
  phaseRef.current = phase;

  const current = (value: number) =>
    mounted.current && version.current === value;

  const savedKey = (purpose: Purpose) =>
    config.pluginShortcuts?.find(
      (item) =>
        item.pluginId === "vitalk-plugin-feishu" &&
        (item.purpose || "message") === purpose,
    )?.hotkey ?? "";

  const clearTimers = useCallback(() => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    if (watchdogTimerRef.current !== null) {
      window.clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
  }, []);

  const resetChordState = useCallback(() => {
    clearTimers();
    pressedKeysRef.current.clear();
    recentlyReleasedModifierKeysRef.current.clear();
    pendingHotkeyRef.current = null;
    setPreviewHotkey(null);
  }, [clearTimers]);

  useEffect(() => {
    setConfirmed((previous) => {
      const next = { ...previous };
      let changed = false;
      for (const { purpose } of actions)
        if (
          next[purpose] !== undefined &&
          next[purpose] === savedKey(purpose)
        ) {
          delete next[purpose];
          changed = true;
        }
      return changed ? next : previous;
    });
  }, [config.pluginShortcuts]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      version.current++;
      clearTimers();
      // release queues behind an in-flight acquisition, including a late ACK.
      void lease.current?.release().catch(() => undefined);
    };
  }, [clearTimers]);

  const restore = useCallback(
    async (capture: Capture | null, operation: number, targetPurpose: Purpose | null) => {
      if (!capture) return true;
      try {
        await capture.release();
        if (lease.current === capture) lease.current = null;
        if (current(operation)) setRecovery(false);
        return true;
      } catch (failure) {
        if (current(operation)) {
          setRecovery(true);
          if (targetPurpose) setErrorPurpose(targetPurpose);
          setError(
            (previous) =>
              `${previous ? previous + "；" : ""}快捷键监听恢复失败：${messageOf(failure)}`,
          );
        }
        return false;
      }
    },
    [],
  );

  const cancel = useCallback(async () => {
    const activePhase = phaseRef.current;
    if (activePhase === "saving" || activePhase === "restoring") return;
    const purpose = listeningRef.current;
    const recovering = recovery;
    const operation = ++version.current;
    pending.current = true;
    resetChordState();
    setPhase("restoring");
    setListening(null);
    setFeedback("");
    const restored = await restore(lease.current, operation, purpose);
    if (current(operation)) {
      pending.current = false;
      setPhase("idle");
      if (restored) {
        if (recovering) {
          setError("");
          setErrorPurpose(null);
        }
        setFeedback(
          recovering ? "快捷键监听已恢复。" : "已取消，原快捷键保持不变。",
        );
      }
    }
  }, [recovery, resetChordState, restore]);

  async function begin(purpose: Purpose) {
    if (pending.current || listening || recovery) return;
    buttons.current[purpose]?.focus();
    const operation = ++version.current;
    pending.current = true;
    resetChordState();
    setPhase("starting");
    setListening(purpose);
    setError("");
    setErrorPurpose(null);
    setFeedback("");
    watchdogTimerRef.current = window.setTimeout(() => {
      if (current(operation)) void cancel();
    }, HOTKEY_CAPTURE_WATCHDOG_MS);
    const capture = acquireCapture();
    lease.current = capture;
    try {
      await capture.ready;
      if (!current(operation)) {
        await capture.release();
        return;
      }
      pending.current = false;
      setPhase("listening");
      buttons.current[purpose]?.focus();
    } catch (failure) {
      if (current(operation)) {
        setErrorPurpose(purpose);
        setError(messageOf(failure));
      }
      await restore(capture, operation, purpose);
      if (current(operation)) {
        clearTimers();
        pending.current = false;
        setPhase("idle");
        setListening(null);
      }
    }
  }

  const save = useCallback(
    async (purpose: Purpose, hotkey: string) => {
      if (pending.current || recovery) return;
      const operation = ++version.current;
      pending.current = true;
      resetChordState();
      setPhase("saving");
      setError("");
      setErrorPurpose(null);
      setFeedback("");
      const capture = lease.current;
      let saved = false;
      try {
        await experimentsRequest({
          action: "feishuShortcutSet",
          purpose,
          hotkey,
        });
        saved = true;
        if (current(operation))
          setConfirmed((previous) => ({ ...previous, [purpose]: hotkey }));
      } catch (failure) {
        if (current(operation)) {
          setErrorPurpose(purpose);
          setError(messageOf(failure));
        }
      } finally {
        await restore(capture, operation, purpose);
        if (current(operation)) {
          pending.current = false;
          setPhase("idle");
          setListening(null);
          if (saved) {
            setFeedback(hotkey ? "快捷键已保存。" : "快捷键已清除。");
            onSaved?.();
          }
          buttons.current[purpose]?.focus();
        }
      }
    },
    [onSaved, recovery, resetChordState, restore],
  );

  const pressedKeysContain = (keys: string[]) =>
    keys.some(
      (key) =>
        pressedKeysRef.current.has(key) ||
        recentlyReleasedModifierKeysRef.current.has(key),
    );

  const withTrackedModifiers = (
    event: Pick<
      KeyboardEvent,
      "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
    >,
  ) => ({
    altKey:
      event.altKey || pressedKeysContain(["Alt", "AltLeft", "AltRight", "Option"]),
    ctrlKey:
      event.ctrlKey ||
      pressedKeysContain(["Control", "ControlLeft", "ControlRight", "Ctrl"]),
    metaKey:
      event.metaKey ||
      pressedKeysContain(["Meta", "MetaLeft", "MetaRight", "OS", "Super"]),
    shiftKey:
      event.shiftKey || pressedKeysContain(["Shift", "ShiftLeft", "ShiftRight"]),
    code: event.code,
    key: event.key,
  });

  useEffect(() => {
    if (!listening) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (
        event.key === "Escape" ||
        event.key === "Esc" ||
        event.code === "Escape"
      ) {
        void cancel();
        return;
      }
      if (pending.current || phaseRef.current !== "listening") return;
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      setError("");
      setErrorPurpose(null);

      if (
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey &&
        (event.key === "Backspace" || event.key === "Delete")
      ) {
        void save(listening, "");
        return;
      }

      const keyId = event.code || event.key;
      if (keyId) pressedKeysRef.current.add(keyId);
      const tracked = withTrackedModifiers(event);
      const candidate = buildPluginHotkeyFromKeyboardEvent(tracked, platform);
      if (candidate) {
        pendingHotkeyRef.current = candidate;
        setPreviewHotkey(candidate);
        return;
      }
      const modifierSet = new Set(pressedKeysRef.current);
      if (tracked.ctrlKey) modifierSet.add("Ctrl");
      if (tracked.altKey) modifierSet.add("Alt");
      if (tracked.shiftKey) modifierSet.add("Shift");
      if (tracked.metaKey) modifierSet.add("Super");
      setPreviewHotkey(buildModifierPreviewHotkey(modifierSet, platform));
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (
        event.key === "Escape" ||
        event.key === "Esc" ||
        event.code === "Escape"
      ) {
        void cancel();
        return;
      }
      if (pending.current || phaseRef.current !== "listening") return;
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      const releasedId = event.code || event.key;
      if (releasedId && isModifierKey(event)) {
        recentlyReleasedModifierKeysRef.current.add(releasedId);
      }
      if (releasedId) pressedKeysRef.current.delete(releasedId);

      if (!pendingHotkeyRef.current) {
        const recovered = buildPluginHotkeyFromKeyboardEvent(
          withTrackedModifiers({
            altKey: false,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            code: event.code,
            key: event.key,
          }),
          platform,
        );
        if (recovered) {
          pendingHotkeyRef.current = recovered;
          setPreviewHotkey(recovered);
        }
      }

      if (pressedKeysRef.current.size > 0) return;

      const hotkey = pendingHotkeyRef.current;
      if (hotkey) {
        pendingHotkeyRef.current = null;
        void save(listening, hotkey);
        return;
      }

      const activePurpose = listening;
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        if (!mounted.current || listeningRef.current !== activePurpose) return;
        recentlyReleasedModifierKeysRef.current.clear();
        setPreviewHotkey(null);
        setErrorPurpose(activePurpose);
        setError("没有捕获到完整的组合键，请包含修饰键（如 Ctrl+U）后重试");
      }, HOTKEY_CAPTURE_SETTLE_MS);
    };

    const handleWindowBlur = () => {
      if (phaseRef.current === "starting" || phaseRef.current === "listening") {
        void cancel();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") handleWindowBlur();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [cancel, listening, platform, save]);

  useEffect(() => {
    if (!recovery) return;
    const tryRecover = () => {
      if (!pending.current && phaseRef.current === "idle" && lease.current) {
        void cancel();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") tryRecover();
    };
    window.addEventListener("focus", tryRecover);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", tryRecover);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [cancel, recovery]);

  const busy = phase !== "idle" && phase !== "listening";
  const handleShellBlur = (
    purpose: Purpose,
    event: FocusEvent<HTMLDivElement>,
  ) => {
    if (listening !== purpose) return;
    if (phase !== "starting" && phase !== "listening") return;
    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && event.currentTarget.contains(nextTarget)) return;
    void cancel();
  };

  return (
    <div className="feishu-shortcut-settings">
      <div className="feishu-shortcut-settings-header">
        <div>
          <strong>语音快捷键</strong>
          <p>按一次开始录音，再按一次结束。</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={enabled}
          disabled={busy || !!listening || recovery}
          onClick={onToggleEnabled}
        >
          {enabled ? "语音已开启" : "开启语音指令"}
        </Button>
      </div>
      <div className="feishu-shortcut-settings-list">
        {actions.map(({ purpose, label, description }) => {
          const hotkey = confirmed[purpose] ?? savedKey(purpose);
          const isCurrent = listening === purpose;
          const rowError = errorPurpose === purpose ? error : "";
          const displayHotkey = isCurrent ? (previewHotkey ?? "") : hotkey;
          const hotkeyParts = displayHotkey
            ? formatHotkeyParts(displayHotkey, platform)
            : [];
          const placeholder = isCurrent
            ? phase === "starting"
              ? "正在准备…"
              : phase === "saving"
                ? "正在保存…"
                : "按下组合键"
            : "点击后直接按下你想要的快捷键";
          const rowStatus = isCurrent
            ? phase === "starting"
              ? "正在准备快捷键监听…"
              : phase === "saving"
                ? "正在保存…"
                : "正在监听快捷键...（按 Esc 取消，Backspace 清空）"
            : "";

          return (
            <div className="feishu-shortcut-settings-row" key={purpose}>
              <div className="feishu-shortcut-row-copy">
                <span className="feishu-shortcut-row-title">{label}</span>
                <p className="feishu-shortcut-row-desc">{description}</p>
              </div>
              <div
                className="settings-hotkey-compact"
                onBlur={(event) => handleShellBlur(purpose, event)}
              >
                <div
                  className={`settings-hotkey-compact-shell${isCurrent ? " is-listening" : ""}${rowError ? " has-error" : ""}`}
                >
                  <button
                    ref={(node) => {
                      buttons.current[purpose] = node;
                    }}
                    type="button"
                    className="settings-hotkey-compact-trigger"
                    aria-label={`${label} 唤醒快捷键`}
                    aria-pressed={isCurrent}
                    disabled={
                      recovery ||
                      (!!listening && !isCurrent) ||
                      (busy && !isCurrent)
                    }
                    title={
                      isCurrent
                        ? "正在监听快捷键...（按 Esc 取消，Backspace 清空）"
                        : "点击后直接按下你想要的快捷键"
                    }
                    onClick={() => void begin(purpose)}
                  >
                    {hotkeyParts.length > 0 ? (
                      hotkeyParts.map((part, index) => (
                        <span
                          className="settings-hotkey-compact-chip"
                          key={`${part}-${index}`}
                        >
                          {part}
                        </span>
                      ))
                    ) : (
                      <span className="settings-hotkey-compact-placeholder">
                        {placeholder}
                      </span>
                    )}
                    {!isCurrent && (
                      <span
                        className="settings-hotkey-edit-label"
                        aria-hidden="true"
                      >
                        修改
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="settings-hotkey-compact-clear"
                    aria-label={`清除${label}快捷键`}
                    disabled={
                      busy ||
                      recovery ||
                      (!!listening && !isCurrent) ||
                      (!hotkey && !isCurrent)
                    }
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      if (isCurrent || !listening) void save(purpose, "");
                    }}
                  />
                </div>
                {(rowError || rowStatus) && (
                  <div
                    role={rowError ? "alert" : "status"}
                    aria-live="polite"
                    className={`settings-hotkey-compact-status${rowError ? " has-error" : ""}`}
                  >
                    {rowError || rowStatus}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {phase === "restoring" && <p role="status">正在恢复快捷键监听…</p>}
      {error && !errorPurpose && <p role="alert">{error}</p>}
      {recovery && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void cancel()}
        >
          重试恢复快捷键
        </Button>
      )}
      {feedback && <p role="status">{feedback}</p>}
      <p className="feishu-shortcut-settings-note">
        消息发送前会显示确认；任务与日程按指令执行。
      </p>
    </div>
  );
}
