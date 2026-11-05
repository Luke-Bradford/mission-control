// A stand-in for the HUD helper process: behaves as the job's `mode` query says.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

process.once("message", (job) => {
  const url = new URL(job.url);
  const mode = url.searchParams.get("mode");
  const grandchild = spawn("sleep", ["60"], { stdio: "ignore" });
  writeFileSync(url.searchParams.get("pidfile"), String(grandchild.pid));
  if (mode === "ok") process.send({ ok: true, png: Buffer.from("png").toString("base64") });
  else if (mode === "env")
    process.send({
      ok: true,
      png: Buffer.from(String(process.env.MC_TEST_SECRET)).toString("base64"),
    });
  else if (mode === "fail") process.send({ ok: false, error: "render exploded" });
  else if (mode === "crash") process.exit(3);
  // "term-hang" and "term-exit": note the SIGTERM in the marker file, then keep running or exit
  else if (mode === "term-hang" || mode === "term-exit") {
    setInterval(() => {}, 1000); // the SIGTERM must not be what ends the process
    process.on("SIGTERM", () => {
      writeFileSync(url.searchParams.get("marker"), "SIGTERM");
      if (mode === "term-exit") process.exit(0);
    });
  }
  // "hang": do nothing, the parent must kill the group
});
