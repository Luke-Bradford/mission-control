// A stand-in for the preview browser helper process: behaves as the job path's `mode` query says.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

process.once("message", (message) => {
  const url = new URL(message.job.path, message.origin);
  const mode = url.searchParams.get("mode");
  const grandchild = spawn("sleep", ["60"], { stdio: "ignore" });
  writeFileSync(url.searchParams.get("pidfile"), String(grandchild.pid));
  if (mode === "ok")
    process.send({
      ok: true,
      url: url.toString(),
      report: ["step 1: screenshot wide"],
      shots: [{ label: "wide", png: Buffer.from("png").toString("base64") }],
    });
  else if (mode === "fail") process.send({ ok: false, error: "browser exploded" });
  else if (mode === "crash") process.exit(3);
  // "hang": do nothing, the parent must kill the group
});
