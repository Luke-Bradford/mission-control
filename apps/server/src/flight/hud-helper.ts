/** The owned helper process for one HUD screenshot: renders the job it is sent, replies, exits. */
import {
  type HudHelperJob,
  type HudHelperReply,
  hudRenderRequest,
  renderHudWithPlaywright,
} from "./hud-render.ts";

process.once("message", async (job: HudHelperJob) => {
  let reply: HudHelperReply;
  try {
    const png = await renderHudWithPlaywright(job.url, hudRenderRequest(job.hubOrigin), {
      deadlineMs: job.deadlineMs,
      ...(job.executablePath === undefined ? {} : { executablePath: job.executablePath }),
    });
    reply = { ok: true, png: png.toString("base64") };
  } catch (e) {
    reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  process.send?.(reply, () => process.exit(0));
});
