export type HotkeyPlatform = "macos" | "windows" | "linux";

type HotkeyInputEvent = Pick<
  KeyboardEvent,
  "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

export function detectHotkeyPlatform(): HotkeyPlatform {
  if (typeof navigator === "undefined") return "linux";
  const raw = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  if (/Mac|iPhone|iPad|iPod/i.test(raw)) return "macos";
  if (/Win/i.test(raw)) return "windows";
  return "linux";
}

function formatHotkeyPart(part: string, platform: HotkeyPlatform): string {
  if (part === "CommandOrControl") return platform === "macos" ? "Cmd" : "Ctrl";
  if (part === "Ctrl") return platform === "macos" ? "Control" : "Ctrl";
  if (part === "ControlLeft") return platform === "macos" ? "Left Control" : "Left Ctrl";
  if (part === "ControlRight") return platform === "macos" ? "Right Control" : "Right Ctrl";
  if (part === "Alt") return platform === "macos" ? "Option" : "Alt";
  if (part === "AltLeft") return platform === "macos" ? "Left Option" : "Left Alt";
  if (part === "AltRight") return platform === "macos" ? "Right Option" : "Right Alt";
  if (part === "Super") return platform === "macos" ? "Cmd" : platform === "windows" ? "Win" : "Super";
  return part;
}

export function formatHotkeyParts(
  value: string,
  platform: HotkeyPlatform = detectHotkeyPlatform(),
): string[] {
  return value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => formatHotkeyPart(part, platform));
}

export function formatHotkeyText(
  value: string,
  platform: HotkeyPlatform = detectHotkeyPlatform(),
): string {
  return formatHotkeyParts(value, platform).join("+");
}

export function isModifierKey(event: Pick<KeyboardEvent, "code" | "key">): boolean {
  return (
    ["Control", "Shift", "Alt", "AltGraph", "Meta"].includes(event.key) ||
    /^(Control|Shift|Alt|Meta)(Left|Right)$/.test(event.code)
  );
}

const CODE_PRIMARY_MAP: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

function getPrimaryKey(event: Pick<KeyboardEvent, "code" | "key">): string | null {
  if (
    ["Escape", "Esc", "Backspace", "Delete", "Control", "Shift", "Alt", "AltGraph", "Meta"].includes(event.key) ||
    /^(Control|Shift|Alt|Meta)(Left|Right)$/.test(event.code) ||
    event.code === "Escape"
  ) {
    return null;
  }
  if (event.code.startsWith("Key")) return event.code.slice(3);
  if (event.code.startsWith("Digit")) return event.code.slice(5);
  if (/^F([1-9]|1[0-2])$/i.test(event.code)) return event.code.toUpperCase();
  if (/^F([1-9]|1[0-2])$/i.test(event.key)) return event.key.toUpperCase();
  if (event.key.startsWith("Arrow")) return event.key.replace("Arrow", "");
  if (CODE_PRIMARY_MAP[event.code]) return CODE_PRIMARY_MAP[event.code];
  if (event.key.length === 1 && /\S/.test(event.key)) return event.key.toUpperCase();
  return null;
}

function getModifierParts(event: Pick<HotkeyInputEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">, platform: HotkeyPlatform): string[] {
  const parts: string[] = [];
  if (platform === "macos") {
    if (event.ctrlKey) parts.push("Ctrl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
    if (event.metaKey) parts.push("CommandOrControl");
  } else {
    if (event.ctrlKey) parts.push("CommandOrControl");
    if (event.metaKey) parts.push("Super");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
  }
  return parts;
}

export function buildModifierPreviewHotkey(
  pressed: ReadonlySet<string>,
  platform: HotkeyPlatform = detectHotkeyPlatform(),
): string | null {
  const hasCtrl = ["Control", "ControlLeft", "ControlRight", "Ctrl"].some((key) => pressed.has(key));
  const hasAlt = ["Alt", "AltLeft", "AltRight", "Option"].some((key) => pressed.has(key));
  const hasShift = ["Shift", "ShiftLeft", "ShiftRight"].some((key) => pressed.has(key));
  const hasMeta = ["Meta", "MetaLeft", "MetaRight", "OS", "Super"].some((key) => pressed.has(key));
  const parts = getModifierParts(
    { ctrlKey: hasCtrl, altKey: hasAlt, shiftKey: hasShift, metaKey: hasMeta },
    platform,
  );
  return parts.length > 0 ? parts.join("+") : null;
}

export function buildPluginHotkeyFromKeyboardEvent(
  event: HotkeyInputEvent,
  platform: HotkeyPlatform = detectHotkeyPlatform(),
): string {
  const primary = getPrimaryKey(event);
  if (!primary) return "";
  const modifiers = getModifierParts(event, platform);
  return modifiers.length ? [...modifiers, primary].join("+") : "";
}
