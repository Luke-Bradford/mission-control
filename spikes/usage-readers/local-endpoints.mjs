// Spike: fetch the two local engine endpoints and print the account shape.
// Prints field names and numbers only.
const get = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return await r.json();
  } catch (e) {
    return { error: String(e) };
  }
};
const state = await get('http://127.0.0.1:8787/api/state');
const a = state.account ?? {};
console.log('8787 /api/state account.claude =', JSON.stringify(a.claude ?? null));
console.log('8787 /api/state account.codex  =', JSON.stringify(a.codex ? { plan: a.codex.plan, five_hour: a.codex.five_hour, seven_day: a.codex.seven_day } : null));
console.log('8788 /api/quota =', JSON.stringify(await get('http://127.0.0.1:8788/api/quota')));
