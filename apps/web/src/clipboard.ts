import { toast } from "./shell/Toast.tsx";

/** Copy `text` to the clipboard and toast `ok`, or `blocked` when the browser refuses. */
export async function copyText(text: string, ok: string, blocked: string): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error("no clipboard");
    await navigator.clipboard.writeText(text);
    toast(ok);
  } catch {
    toast(blocked);
  }
}
