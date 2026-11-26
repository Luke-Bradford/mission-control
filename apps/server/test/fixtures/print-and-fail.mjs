// A failing check for the session-checks tests: prints `line 1` … `line 60`, then exits 2.
for (let i = 1; i <= 60; i++) process.stdout.write(`line ${i}\n`);
process.exitCode = 2;
