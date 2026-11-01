/** The owned helper process for one preview browser call: runs the job it is sent, replies, exits. */
import {
  type PreviewHelperJob,
  type PreviewHelperReply,
  previewRequest,
  runPreviewBrowser,
} from "./preview-browser.ts";

process.once("message", async (message: PreviewHelperJob) => {
  let reply: PreviewHelperReply;
  try {
    const result = await runPreviewBrowser(message.job, previewRequest(message.origin), {
      deadlineMs: message.deadlineMs,
      ...(message.executablePath === undefined ? {} : { executablePath: message.executablePath }),
    });
    reply = {
      ok: true,
      url: result.url,
      report: result.report,
      shots: result.shots.map((s) => ({ label: s.label, png: s.png.toString("base64") })),
    };
  } catch (e) {
    reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  process.send?.(reply, () => process.exit(0));
});
