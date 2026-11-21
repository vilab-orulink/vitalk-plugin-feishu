// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentVoiceShortcut } from "./AgentVoiceShortcut";
import { experimentsRequest } from "./client";

vi.mock("./client", () => ({ experimentsRequest: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.resetAllMocks();
});

const config = {
  pluginShortcuts: [
    {
      pluginId: "vitalk-plugin-feishu",
      purpose: "message",
      hotkey: "CommandOrControl+U",
      trigger: "toggle",
    },
    {
      pluginId: "vitalk-plugin-feishu",
      purpose: "task",
      hotkey: "Shift+A",
      trigger: "toggle",
    },
    {
      pluginId: "vitalk-plugin-feishu",
      purpose: "calendar",
      hotkey: "Ctrl+Alt+F8",
      trigger: "toggle",
    },
  ],
};

function chipTexts(buttonName: string) {
  const button = screen.getByRole("button", { name: buttonName });
  return Array.from(
    button.querySelectorAll(".settings-hotkey-compact-chip"),
  ).map((node) => node.textContent);
}

it("renders ViTalk compact key chips, previews held modifiers, commits on keyup, and releases capture", async () => {
  vi.mocked(experimentsRequest).mockResolvedValue({} as never);
  const saved = vi.fn();
  render(
    <AgentVoiceShortcut
      config={config}
      enabled
      onToggleEnabled={vi.fn()}
      onSaved={saved}
    />,
  );
  expect(chipTexts("消息 唤醒快捷键")).toEqual(["Ctrl", "U"]);
  expect(chipTexts("任务 唤醒快捷键")).toEqual(["Shift", "A"]);
  expect(document.querySelector(".feishu-shortcut-capture")).toBeNull();

  const trigger = screen.getByRole("button", { name: "日程 唤醒快捷键" });
  fireEvent.click(trigger);
  await screen.findByText(/正在监听快捷键/);
  expect(trigger).toHaveProperty("disabled", false);

  // Holding modifiers shows live preview chips before committing.
  fireEvent.keyDown(window, {
    key: "Control",
    code: "ControlLeft",
    ctrlKey: true,
  });
  expect(chipTexts("日程 唤醒快捷键")).toEqual(["Ctrl"]);
  expect(experimentsRequest).not.toHaveBeenCalledWith(
    expect.objectContaining({ action: "feishuShortcutSet" }),
  );

  fireEvent.keyDown(window, {
    key: "F8",
    code: "F8",
    ctrlKey: true,
    altKey: true,
  });
  expect(chipTexts("日程 唤醒快捷键")).toEqual(["Ctrl", "Alt", "F8"]);
  expect(experimentsRequest).not.toHaveBeenCalledWith(
    expect.objectContaining({ action: "feishuShortcutSet" }),
  );

  fireEvent.keyUp(window, { key: "F8", code: "F8" });
  expect(experimentsRequest).not.toHaveBeenCalledWith(
    expect.objectContaining({ action: "feishuShortcutSet" }),
  );
  fireEvent.keyUp(window, { key: "Control", code: "ControlLeft" });

  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(experimentsRequest).toHaveBeenNthCalledWith(1, {
    action: "feishuShortcutCapture",
    active: true,
  });
  expect(experimentsRequest).toHaveBeenNthCalledWith(2, {
    action: "feishuShortcutSet",
    purpose: "calendar",
    hotkey: "CommandOrControl+Alt+F8",
  });
  expect(experimentsRequest).toHaveBeenNthCalledWith(3, {
    action: "feishuShortcutCapture",
    active: false,
  });
});

it("warns on modifier-only or bare key release while remaining in listening mode until valid chord", async () => {
  vi.useFakeTimers();
  vi.mocked(experimentsRequest).mockResolvedValue({} as never);
  render(
    <AgentVoiceShortcut config={config} enabled onToggleEnabled={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "任务 唤醒快捷键" }));
  await act(async () => {});
  expect(screen.getByText(/正在监听快捷键/)).toBeTruthy();

  fireEvent.keyDown(window, { key: "a", code: "KeyA" });
  fireEvent.keyUp(window, { key: "a", code: "KeyA" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });

  expect(screen.getByRole("alert").textContent).toContain("没有捕获到完整的组合键");
  expect(experimentsRequest).not.toHaveBeenCalledWith(
    expect.objectContaining({ action: "feishuShortcutSet" }),
  );
  expect(
    screen.getByRole("button", { name: "任务 唤醒快捷键" }).getAttribute("aria-pressed"),
  ).toBe("true");
});

it("clears shortcut via Backspace or the inline clear button", async () => {
  vi.mocked(experimentsRequest).mockResolvedValue({} as never);
  const saved = vi.fn();
  render(
    <AgentVoiceShortcut
      config={config}
      enabled
      onToggleEnabled={vi.fn()}
      onSaved={saved}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "清除任务快捷键" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(experimentsRequest).toHaveBeenCalledWith({
    action: "feishuShortcutSet",
    purpose: "task",
    hotkey: "",
  });

  fireEvent.click(screen.getByRole("button", { name: "消息 唤醒快捷键" }));
  await screen.findByText(/正在监听快捷键/);
  fireEvent.keyDown(window, { key: "Backspace", code: "Backspace" });
  await waitFor(() =>
    expect(experimentsRequest).toHaveBeenCalledWith({
      action: "feishuShortcutSet",
      purpose: "message",
      hotkey: "",
    }),
  );
});

it("shows conflict errors, retains the prior shortcut and resumes native capture", async () => {
  vi.mocked(experimentsRequest).mockImplementation(async (request) => {
    if (request.action === "feishuShortcutSet")
      throw new Error("快捷键与听写冲突");
    return {} as never;
  });
  const saved = vi.fn();
  render(
    <AgentVoiceShortcut
      config={config}
      enabled
      onToggleEnabled={vi.fn()}
      onSaved={saved}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "任务 唤醒快捷键" }));
  await screen.findByText(/正在监听快捷键/);
  fireEvent.keyDown(window, { key: "a", code: "KeyA", ctrlKey: true });
  fireEvent.keyUp(window, { key: "a", code: "KeyA" });
  expect((await screen.findByRole("alert")).textContent).toContain(
    "快捷键与听写冲突",
  );
  await waitFor(() => expect(chipTexts("任务 唤醒快捷键")).toEqual(["Shift", "A"]));
  expect(experimentsRequest).toHaveBeenCalledWith({
    action: "feishuShortcutCapture",
    active: false,
  });
  expect(saved).not.toHaveBeenCalled();
});

it("cancels keyboard capture on Escape or focus blur without overwriting the saved shortcut", async () => {
  vi.mocked(experimentsRequest).mockResolvedValue({} as never);
  render(
    <AgentVoiceShortcut config={config} enabled onToggleEnabled={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "消息 唤醒快捷键" }));
  await screen.findByText(/正在监听快捷键/);
  fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
  await waitFor(() => expect(chipTexts("消息 唤醒快捷键")).toEqual(["Ctrl", "U"]));
  expect(experimentsRequest).not.toHaveBeenCalledWith(
    expect.objectContaining({ action: "feishuShortcutSet" }),
  );
  expect(experimentsRequest).toHaveBeenCalledWith({
    action: "feishuShortcutCapture",
    active: false,
  });

  vi.mocked(experimentsRequest).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "任务 唤醒快捷键" }));
  await screen.findByText(/正在监听快捷键/);
  fireEvent(window, new Event("blur"));
  await waitFor(() =>
    expect(experimentsRequest).toHaveBeenCalledWith({
      action: "feishuShortcutCapture",
      active: false,
    }),
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("releases global capture when the component unmounts before acquisition finishes", async () => {
  const start = deferred<never>();
  vi.mocked(experimentsRequest).mockImplementation((request) =>
    request.action === "feishuShortcutCapture" && request.active
      ? start.promise
      : Promise.resolve({} as never),
  );
  const view = render(
    <AgentVoiceShortcut config={config} enabled onToggleEnabled={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "消息 唤醒快捷键" }));
  await waitFor(() =>
    expect(experimentsRequest).toHaveBeenCalledWith({
      action: "feishuShortcutCapture",
      active: true,
    }),
  );
  view.unmount();
  await act(async () => start.resolve({} as never));
  await waitFor(() =>
    expect(experimentsRequest).toHaveBeenCalledWith({
      action: "feishuShortcutCapture",
      active: false,
    }),
  );
});

it("can cancel pending capture via Escape and keeps the saved binding without saving", async () => {
  const start = deferred<never>();
  vi.mocked(experimentsRequest).mockImplementation((request) =>
    request.action === "feishuShortcutCapture" && request.active
      ? start.promise
      : Promise.resolve({} as never),
  );
  render(
    <AgentVoiceShortcut config={config} enabled onToggleEnabled={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "消息 唤醒快捷键" }));
  await waitFor(() =>
    expect(experimentsRequest).toHaveBeenCalledWith({
      action: "feishuShortcutCapture",
      active: true,
    }),
  );
  fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
  await act(async () => start.resolve({} as never));
  await waitFor(() =>
    expect(experimentsRequest).toHaveBeenCalledWith({
      action: "feishuShortcutCapture",
      active: false,
    }),
  );
  expect(experimentsRequest).not.toHaveBeenCalledWith(
    expect.objectContaining({ action: "feishuShortcutSet" }),
  );
  expect(chipTexts("消息 唤醒快捷键")).toEqual(["Ctrl", "U"]);
});

it("does not release a newer capture owned by a replacement component", async () => {
  const start = deferred<never>();
  let captures = 0;
  vi.mocked(experimentsRequest).mockImplementation((request) =>
    request.action === "feishuShortcutCapture" &&
    request.active &&
    ++captures === 1
      ? start.promise
      : Promise.resolve({} as never),
  );
  const first = render(
    <AgentVoiceShortcut config={config} enabled onToggleEnabled={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "消息 唤醒快捷键" }));
  first.unmount();
  render(
    <AgentVoiceShortcut config={config} enabled onToggleEnabled={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "任务 唤醒快捷键" }));
  await act(async () => start.resolve({} as never));
  await screen.findByText(/正在监听快捷键/);
  fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
  await waitFor(() =>
    expect(experimentsRequest).toHaveBeenLastCalledWith({
      action: "feishuShortcutCapture",
      active: false,
    }),
  );
  expect(experimentsRequest).not.toHaveBeenCalledWith(
    expect.objectContaining({ action: "feishuShortcutSet" }),
  );
});

it("releases capture on unmount while a save is pending without a late callback", async () => {
  const written = deferred<never>();
  const saved = vi.fn();
  vi.mocked(experimentsRequest).mockImplementation((request) =>
    request.action === "feishuShortcutSet"
      ? written.promise
      : Promise.resolve({} as never),
  );
  const view = render(
    <AgentVoiceShortcut
      config={config}
      enabled
      onToggleEnabled={vi.fn()}
      onSaved={saved}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "任务 唤醒快捷键" }));
  await screen.findByText(/正在监听快捷键/);
  fireEvent.keyDown(window, { key: "b", code: "KeyB", ctrlKey: true });
  fireEvent.keyUp(window, { key: "b", code: "KeyB" });
  await waitFor(() =>
    expect(experimentsRequest).toHaveBeenCalledWith({
      action: "feishuShortcutSet",
      purpose: "task",
      hotkey: "CommandOrControl+B",
    }),
  );
  view.unmount();
  await waitFor(() =>
    expect(experimentsRequest).toHaveBeenCalledWith({
      action: "feishuShortcutCapture",
      active: false,
    }),
  );
  await act(async () => written.resolve({} as never));
  expect(saved).not.toHaveBeenCalled();
});

it("restores shortcuts even when acquiring capture returns an error", async () => {
  vi.mocked(experimentsRequest).mockImplementation(async (request) => {
    if (request.action === "feishuShortcutCapture" && request.active)
      throw new Error("监听启动失败");
    return {} as never;
  });
  render(
    <AgentVoiceShortcut config={config} enabled onToggleEnabled={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "消息 唤醒快捷键" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "监听启动失败",
  );
  await waitFor(() =>
    expect(experimentsRequest).toHaveBeenCalledWith({
      action: "feishuShortcutCapture",
      active: false,
    }),
  );
  expect(chipTexts("消息 唤醒快捷键")).toEqual(["Ctrl", "U"]);
});

it("keeps a confirmed save and offers recovery if resuming shortcuts fails", async () => {
  let releases = 0;
  const saved = vi.fn();
  vi.mocked(experimentsRequest).mockImplementation(async (request) => {
    if (
      request.action === "feishuShortcutCapture" &&
      !request.active &&
      ++releases === 1
    )
      throw new Error("恢复暂不可用");
    return {} as never;
  });
  render(
    <AgentVoiceShortcut
      config={config}
      enabled
      onToggleEnabled={vi.fn()}
      onSaved={saved}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "任务 唤醒快捷键" }));
  await screen.findByText(/正在监听快捷键/);
  fireEvent.keyDown(window, { key: "b", code: "KeyB", ctrlKey: true });
  fireEvent.keyUp(window, { key: "b", code: "KeyB" });
  const retry = await screen.findByRole("button", { name: "重试恢复快捷键" });
  expect(chipTexts("任务 唤醒快捷键")).toEqual(["Ctrl", "B"]);
  fireEvent.click(retry);
  await screen.findByText("快捷键监听已恢复。");
  expect(saved).toHaveBeenCalledOnce();
  expect(releases).toBe(2);
});

it("dispatches release before unmount returns so SDK disposal cannot drop an idle cleanup", async () => {
  vi.mocked(experimentsRequest).mockResolvedValue({} as never);
  const view = render(
    <AgentVoiceShortcut config={config} enabled onToggleEnabled={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "消息 唤醒快捷键" }));
  await screen.findByText(/正在监听快捷键/);
  view.unmount();
  expect(experimentsRequest).toHaveBeenLastCalledWith({
    action: "feishuShortcutCapture",
    active: false,
  });
});

it("does not announce restored shortcuts when recovery fails repeatedly", async () => {
  let releases = 0;
  vi.mocked(experimentsRequest).mockImplementation(async (request) => {
    if (
      request.action === "feishuShortcutCapture" &&
      !request.active &&
      ++releases < 3
    )
      throw new Error("恢复仍失败");
    return {} as never;
  });
  render(
    <AgentVoiceShortcut config={config} enabled onToggleEnabled={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "消息 唤醒快捷键" }));
  await screen.findByText(/正在监听快捷键/);
  fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
  fireEvent.click(
    await screen.findByRole("button", { name: "重试恢复快捷键" }),
  );
  await waitFor(() => expect(releases).toBe(2));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "重试恢复快捷键" }),
    ).toHaveProperty("disabled", false),
  );
  expect(screen.queryByText("快捷键监听已恢复。")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("恢复仍失败");
  expect(
    screen.getByRole("button", { name: "消息 唤醒快捷键" }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "重试恢复快捷键" }));
  await screen.findByText("快捷键监听已恢复。");
  expect(screen.queryByRole("alert")).toBeNull();
});
