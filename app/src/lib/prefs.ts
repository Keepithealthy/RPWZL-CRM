/** Per-viewer UI preferences in localStorage. Every access is guarded: storage may be blocked or empty. */
export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(`rpwzl.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(`rpwzl.${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable: the preference is simply not remembered */
  }
}
