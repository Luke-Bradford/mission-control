/** The owned helper process for one HUD screenshot: renders the job it is sent, replies, exits. */
import {
  HUD_RENDER_CLOSE_MS,
  type HudHelperJob,
  type HudHelperReply,
  hudRenderRequest,
  renderHudWithPlaywright,
} from "./hud-render.ts";

// The parent stops a render with SIGTERM. Playwright's own handler starts a graceful close but never
// exits, and the parent's SIGKILL comes only after HUD_RENDER_CLOSE_MS and spares Chrome (its own
// process group). So exit by ourselves inside that window: process.exit runs Playwright's exit
// handler, which kills Chrome's group and removes its profile folder.
process.once("SIGTERM", () => {
  setTimeout(() => process.exit(0), HUD_RENDER_CLOSE_MS / 2);
});

process.once("message", async (job: HudHelperJob) => {
  let reply: HudHelperReply;
  try {
    const png = await renderHudWithPlaywright(job.url, hudRenderRequest(job.hubOrigin), {
      deadlineMs: job.deadlineMs,
      ...(job.executablePath === undefined ? {} : { executablePath: job.executablePath }),
      ...(job.colorScheme === undefined ? {} : { colorScheme: job.colorScheme }),
    });
    reply = { ok: true, png: png.toString("base64") };
  } catch (e) {
    reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  process.send?.(reply, () => process.exit(0));
});
