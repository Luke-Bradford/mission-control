(function () {
  const D = JSON.parse(document.getElementById("data").textContent);
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const AREA = { server: css("--area-server"), web: css("--area-web"), core: css("--area-core"), docs: css("--area-docs"), other: css("--area-other"), ext: css("--area-ext") };
  const AGENT_COLORS = { "guido-1": "#1fb6ff", "guido-2": "#19e68c", "inco-1": "#ff3fa4", "retro-1": "#ffd23f", "fao-1": "#b084ff", "flight-1": "#ff7a1a" }; // vivid hues, kept apart from the muted area colours
  const ROLES = { guido: "Backend developer", inco: "Frontend developer", retro: "Reviewer (QA)", fao: "Planner", flight: "Flight director" };
  const AREA_NAME = { server: "apps/server", web: "apps/web", core: "packages/core", docs: "docs · roles", other: "other", ext: "outside the repo" };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  // lifetimes in event seconds; animation lengths in screen seconds
  const RECENT = 10 * 60, QUIET = 20 * 60, ANCHOR_HOLD = 5 * 60;
  const ACT = 10, DOCK_AFTER = 60; // a running turn with no tool call for 10 s is the model thinking; a seat idle for a minute docks
  const SETTLE = 6, TRAVEL = 2.2, ARC_LIFE = 4, LIVE_WINDOW = 4; // calls are seconds apart even at the peak: each one's effects overlap the next

  // ---- graph ---------------------------------------------------------------------------------
  const nodes = [{ id: "", kind: "root", parent: -1, area: "other", kids: [] }];
  const dirIndex = new Map();
  const areaOf = (p) => p.startsWith("apps/server") ? "server" : p.startsWith("apps/web") ? "web" : p.startsWith("packages/core") ? "core" : (p.startsWith("docs") || p.startsWith("roles")) ? "docs" : "other";
  function ensureDir(p) {
    if (p === "") return 0;
    if (dirIndex.has(p)) return dirIndex.get(p);
    const parent = ensureDir(p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
    const i = nodes.push({ id: p, kind: "dir", parent, area: areaOf(p), kids: [] }) - 1;
    nodes[parent].kids.push(i); dirIndex.set(p, i); return i;
  }
  D.dirs.forEach(ensureDir);
  const fileNode = D.files.map((f, k) => { const parent = ensureDir(f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ""); const i = nodes.push({ id: f, kind: "file", parent, area: areaOf(f), kids: [], lines: D.lines[k] }) - 1; nodes[parent].kids.push(i); return i; });
  const dirNode = D.dirs.map((d) => dirIndex.get(d));
  const NT = nodes.length;
  const extNode = D.ext.map((name) => nodes.push({ id: name, kind: "ext", parent: -1, area: "ext", kids: [] }) - 1);
  const N = nodes.length, HUB = extNode[0];
  const targetOf = (t) => t === "R" ? 0 : typeof t === "string" ? extNode[+t.slice(1)] : t < 0 ? dirNode[-t - 1] : fileNode[t];
  const imports = D.links.map(([a, b]) => [fileNode[a], fileNode[b]]);
  const importsOf = nodes.map(() => []); imports.forEach(([a, b], k) => { importsOf[a].push(k); importsOf[b].push(k); });
  const weight = new Float32Array(N);
  (function w(i) { const n = nodes[i]; weight[i] = n.kind === "file" ? n.lines + 20 : 0; n.kids.forEach((k) => { w(k); weight[i] += weight[k]; }); })(0);

  // ---- layout: compact folder neighbourhoods; big folders get room for their contents, not longer branches
  const pos = new Float32Array(N * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const AREA_DIR = { server: [-1, 0.15, 0], web: [1, 0.1, 0], core: [0.05, -1, 0], docs: [0.15, 1, 0], other: [-0.2, 0.7, 0] };
  function placeKids(i, dir, spread) {
    const kids = nodes[i].kids; if (!kids.length) return;
    const up = Math.abs(dir.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(dir, up).normalize(), v = new THREE.Vector3().crossVectors(dir, u);
    const sorted = kids.slice().sort((a, b) => weight[b] - weight[a]);
    sorted.forEach((k, j) => {
      const n = nodes[k];
      let d;
      if (i === 0 || nodes[i].id === "apps" || nodes[i].id === "packages") { const a = AREA_DIR[n.area] || AREA_DIR.other; d = new THREE.Vector3(a[0], a[1], a[2]).normalize().add(new THREE.Vector3((j % 3 - 1) * 0.15, 0, (j % 2 ? 0.2 : -0.2))).normalize(); }
      else {
        const f = (j + 0.5) / sorted.length, theta = Math.acos(1 - f * (1 - Math.cos(spread))), phi = j * golden;
        d = dir.clone().multiplyScalar(Math.cos(theta)).add(u.clone().multiplyScalar(Math.sin(theta) * Math.cos(phi))).add(v.clone().multiplyScalar(Math.sin(theta) * Math.sin(phi))).normalize();
      }
      const len = n.kind === "dir" ? 9 + Math.min(14, Math.log1p(weight[k]) * 1.3) : 3 + Math.min(5, Math.log1p(n.lines) * 0.6);
      pos[k * 3] = pos[i * 3] + d.x * len; pos[k * 3 + 1] = pos[i * 3 + 1] + d.y * len; pos[k * 3 + 2] = pos[i * 3 + 2] + d.z * len;
      if (n.kind === "dir") placeKids(k, d, Math.min(1.6, 0.7 + n.kids.length * 0.04));
    });
  }
  placeKids(0, new THREE.Vector3(0, 0, 1), Math.PI);
  const rest = new Float32Array(N), F = new Float32Array(N * 3);
  nodes.forEach((n, i) => { if (n.parent >= 0) rest[i] = Math.hypot(pos[i * 3] - pos[n.parent * 3], pos[i * 3 + 1] - pos[n.parent * 3 + 1], pos[i * 3 + 2] - pos[n.parent * 3 + 2]); });
  const spring = (a, b, L, k) => { const dx = pos[b * 3] - pos[a * 3], dy = pos[b * 3 + 1] - pos[a * 3 + 1], dz = pos[b * 3 + 2] - pos[a * 3 + 2]; const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01, f = (d - L) * k / d; F[a * 3] += dx * f; F[a * 3 + 1] += dy * f; F[a * 3 + 2] += dz * f; F[b * 3] -= dx * f; F[b * 3 + 1] -= dy * f; F[b * 3 + 2] -= dz * f; };
  for (let step = 0; step < 80; step++) {
    F.fill(0);
    for (let i = 0; i < NT; i++) for (let j = i + 1; j < NT; j++) {
      const dx = pos[i * 3] - pos[j * 3], dy = pos[i * 3 + 1] - pos[j * 3 + 1], dz = pos[i * 3 + 2] - pos[j * 3 + 2], d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 225) continue; const f = 5 / (d2 + 1);
      F[i * 3] += dx * f; F[i * 3 + 1] += dy * f; F[i * 3 + 2] += dz * f; F[j * 3] -= dx * f; F[j * 3 + 1] -= dy * f; F[j * 3 + 2] -= dz * f;
    }
    nodes.forEach((n, i) => { if (n.parent >= 0) spring(i, n.parent, rest[i], 0.3); });
    imports.forEach(([a, b]) => spring(a, b, 12, 0.006));
    for (let i = 3; i < NT * 3; i++) pos[i] += Math.max(-1.5, Math.min(1.5, F[i] * 0.5));
  }
  const P = (i) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  const box3 = new THREE.Box3(); for (let i = 0; i < NT; i++) box3.expandByPoint(P(i));
  const C0 = box3.getCenter(new THREE.Vector3()), size = box3.getSize(new THREE.Vector3());
  // the reference rail: outside-the-repo resources in a column beside the brain
  extNode.forEach((i, k) => { pos[i * 3] = box3.max.x + size.x * 0.04; pos[i * 3 + 1] = C0.y + size.y * 0.28 - k * size.y * 0.14; pos[i * 3 + 2] = C0.z - size.z * 0.2; });
  const R = Math.max(size.x, size.y) * 0.62;

  // ---- scene: renders only when something changes, capped at 30 fps ----------------------------
  const stage = document.getElementById("stage");
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(1.5, devicePixelRatio)); renderer.setClearColor(new THREE.Color(css("--void")), 1);
  stage.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 1, R * 40);
  const HOME = { pos: new THREE.Vector3(C0.x + R * 0.9, C0.y + R * 0.35, C0.z + R * 1.6), target: C0.clone().add(new THREE.Vector3(size.x * 0.06, 0, 0)) };
  camera.position.copy(HOME.pos);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.copy(HOME.target); controls.enableDamping = true; controls.dampingFactor = 0.1; controls.autoRotate = false; controls.autoRotateSpeed = 0.25;
  let needs = true; controls.addEventListener("change", () => { needs = true; });
  let fly = null; // a user-asked camera move: Home, or frame an agent or a file; never automatic
  function flyTo(target, distance) { fly = { from: controls.target.clone(), to: target.clone(), pFrom: camera.position.clone(), pTo: target.clone().add(camera.position.clone().sub(controls.target).normalize().multiplyScalar(distance)), u: 0 }; }

  const flat = {}; for (const k in AREA) flat[k] = new THREE.Color(AREA[k]);
  const baseCol = nodes.map((n) => n.kind === "root" ? new THREE.Color("#c8d2e6") : n.kind === "ext" ? flat.ext.clone().multiplyScalar(0.75) : flat[n.area].clone().multiplyScalar(n.kind === "file" ? 0.7 : 0.6)); // untouched files: muted area colours, so the agents' colours stand out
  const baseScale = nodes.map((n, i) => n.kind === "ext" ? 0 : n.kind === "root" ? 1.3 : n.kind === "dir" ? 0 : 0.85); // folders are line junctions; files carry the weight
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial(), N);
  const dummy = new THREE.Object3D();
  const place = (i, s) => { dummy.position.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); dummy.scale.setScalar(s); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); };
  nodes.forEach((n, i) => { place(i, baseScale[i]); mesh.setColorAt(i, baseCol[i]); });
  scene.add(mesh);
  function lineSet(pairs, colorOf, opacity) {
    const g = new THREE.BufferGeometry(), p = new Float32Array(Math.max(1, pairs.length) * 6), c = new Float32Array(Math.max(1, pairs.length) * 6);
    pairs.forEach(([a, b], k) => { p.set([pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2], pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]], k * 6); const col = colorOf(a, b); c.set([col.r, col.g, col.b, col.r, col.g, col.b], k * 6); });
    g.setAttribute("position", new THREE.BufferAttribute(p, 3)); g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false })); scene.add(l); return l;
  }
  lineSet(nodes.map((n, i) => [n.parent, i]).filter(([p]) => p >= 0), (a, b) => baseCol[b].clone().multiplyScalar(nodes[b].kind === "dir" ? 1.0 : 0.7), 0.75); // the backbone
  const linkDim = new THREE.Color(css("--link"));
  lineSet(imports, () => linkDim, 0.35);
  const hiImports = lineSet([], () => linkDim, 0.9); // the selected file's imports

  // sprite textures: a soft puff, a thin ring, a solid square, a dashed ring (shared), a double ring (write overlap)
  const tex = (draw) => { const c = document.createElement("canvas"); c.width = c.height = 64; draw(c.getContext("2d")); return new THREE.CanvasTexture(c); };
  const PUFF = tex((g) => { const r = g.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, "rgba(255,255,255,0.9)"); r.addColorStop(0.4, "rgba(255,255,255,0.35)"); r.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = r; g.fillRect(0, 0, 64, 64); });
  const RING = tex((g) => { g.strokeStyle = "#fff"; g.lineWidth = 5; g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.stroke(); });
  const SQUARE = tex((g) => { g.fillStyle = "#fff"; g.fillRect(14, 14, 36, 36); });
  const DASH = tex((g) => { g.strokeStyle = "#fff"; g.lineWidth = 4; g.setLineDash([8, 7]); g.beginPath(); g.arc(32, 32, 27, 0, Math.PI * 2); g.stroke(); });
  const DOUBLE = tex((g) => { g.strokeStyle = "#fff"; g.lineWidth = 4; [28, 19].forEach((r) => { g.beginPath(); g.arc(32, 32, r, 0, Math.PI * 2); g.stroke(); }); });
  const points = (map, size, opacity, blending) => { const p = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ map, size, transparent: true, opacity, depthWrite: false, alphaTest: 0.02, blending: blending || THREE.NormalBlending })); scene.add(p); return p; };
  const setPts = (p, arr) => { p.geometry.dispose(); const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(arr), 3)); p.geometry = g; };
  const overlapCol = new THREE.Color(css("--overlap"));
  const sharedPts = points(DASH, 8, 0.7); sharedPts.material.color = overlapCol;   // two or more branches touched it, one wrote it
  const overlapPts = points(DOUBLE, 11, 0.95); overlapPts.material.color = overlapCol; // two or more branches wrote it: write overlap, not a confirmed conflict
  const nowPts = points(RING, 10, 1); nowPts.material.color = new THREE.Color("#ffffff");  // being accessed now: the files of the step in progress
  const mindPts = points(RING, 7.5, 0.5); mindPts.material.color = new THREE.Color("#ffffff");   // in mind while it thinks
  let nowSig = "";
  const SEV_COL = ["#ff4d4d", "#ffa63d", "#9aa6bf"], SEV_NAME = ["Critical", "Important", "Minor"];
  const PIN = tex((g) => { g.fillStyle = "#fff"; g.beginPath(); g.moveTo(32, 6); g.lineTo(58, 54); g.lineTo(6, 54); g.closePath(); g.fill(); });
  const findPts = SEV_COL.map((c, k) => { const p = points(PIN, [14, 12, 9][k], 1); p.material.color = new THREE.Color(c); p.material.depthTest = false; p.renderOrder = 5; return p; }); // drawn over the spheres
  const findOf = new Map(); let findSig = ""; // file → the current review's findings on it

  // ---- CAPCOM: the operator, a fixed point above the brain, so messages from and to it have somewhere to go
  const CAP = { pos: new THREE.Vector3(C0.x, box3.max.y + size.y * 0.1, C0.z), col: new THREE.Color(css("--signal")) };
  const capOrb = new THREE.Mesh(new THREE.OctahedronGeometry(2.2), new THREE.MeshBasicMaterial({ color: CAP.col })); capOrb.position.copy(CAP.pos); scene.add(capOrb);
  const HUBPOS = CAP.pos.clone().add(new THREE.Vector3(size.x * 0.14, -size.y * 0.02, 0)); // the hub: where its own notices come from
  const hubOrb = new THREE.Mesh(new THREE.OctahedronGeometry(1.8), new THREE.MeshBasicMaterial({ color: flat.ext })); hubOrb.position.copy(HUBPOS); scene.add(hubOrb);

  // ---- agents ----------------------------------------------------------------------------------
  const labels = document.getElementById("labels");
  const capLabel = document.createElement("div"); capLabel.className = "glabel"; capLabel.style.color = capLabel.style.borderColor = CAP.col.getStyle(); capLabel.textContent = "CAPCOM · operator"; labels.appendChild(capLabel);
  const hubLabel = document.createElement("div"); hubLabel.className = "glabel"; hubLabel.style.color = hubLabel.style.borderColor = flat.ext.getStyle(); hubLabel.textContent = "HUB"; labels.appendChild(hubLabel);
  // modified files carry their +/− lines for the ticket, the most recent first; a new edit makes the label pulse
  const DIFFS = 40; let diffs = []; const bump = new Map();
  const diffPool = Array.from({ length: DIFFS }, () => { const el = document.createElement("div"); el.className = "diff"; el.hidden = true; labels.appendChild(el); return el; });
  const BANDS = [10, 50, 200, Infinity], BAND_SIZE = [2.2, 3.2, 4.4, 5.8];
  const FIL = 12;
  const agents = D.agents.map((id, a) => {
    const col = new THREE.Color(AGENT_COLORS[id] || "#ffffff");
    const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.8 })); trail.visible = false; scene.add(trail); // shown for the focused agent only
    const label = document.createElement("div"); label.className = "glabel"; label.style.color = col.getStyle(); label.style.borderColor = col.getStyle(); labels.appendChild(label);
    const off = new THREE.Vector3(Math.cos(a * 1.05), Math.sin(a * 1.05), 0).multiplyScalar(1.6); // each agent's change marker sits on its own side of a file
    const orb = new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 12), new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(1.15) }));
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: PUFF, color: col, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(FIL * 6), 3)); bg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(FIL * 6), 3));
    const beam = new THREE.LineSegments(bg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
    orb.userData.agent = a;
    scene.add(orb, halo, beam);
    return { id, a, col, trail, label, off, orb, halo, beam, at: -1, kind: -1, state: "idle", stateFor: 0, docked: true, more: 0, orbPos: null, step: [], stepT: -1, mind: [], foot: new Map(), recent: new Map(), wrote: new Map(), sinceCommit: new Set(), lastCommit: null, reviewT: null, pending: [], trouble: [], tests: null, reviews: [], review: null, lastCallEnd: -1e9, lastWriteT: -1e9, mergedNum: "", ticket: "", ticketIdx: 0, lastT: -1e9, startT: 0, tokens: 0, dirty: true, anchor: -1, anchorCand: -1, anchorSince: 0, hist: [], on: true, prev: -1, lastStepT: -1 };
  });
  const agentById = new Map(agents.map((ag) => [ag.id, ag]));
  agents.forEach((ag, a) => { ag.window = (D.windows && D.windows[a]) || 1e6; }); // measured: each run's result line states its model's context window
  // the session look of each node: tinted by the agent whose branch touched it, brighter and larger if written
  const sessCol = nodes.map((n, i) => baseCol[i].clone()), sessScale = Float32Array.from(baseScale);
  const shareOf = new Map(); // file → the agents whose current tickets touched it, when more than one
  function restyle() {
    const sh = [], ov = []; shareOf.clear();
    for (let i = 0; i < N; i++) {
      let best = null, wrote = false, last = -1;
      for (const ag of agents) { if (!ag.on) continue; const t0 = ag.foot.get(i); if (t0 === undefined) continue; const w = ag.wrote.has(i); if (ag.stale && !w) continue; if (w > wrote || (w === wrote && t0 > last)) { best = ag; wrote = w; last = t0; } }
      let churn = 0; for (const ag of agents) { const w = ag.wrote.get(i); if (w) churn += w.add + w.rem; }
      const c = best ? best.col.clone().multiplyScalar(wrote ? (best.stale ? 0.75 : 1.15) : 0.72) : baseCol[i], s = best && nodes[i].kind === "file" ? baseScale[i] * (wrote ? 1.35 + level(churn) * 0.4 : 1.1) : baseScale[i];
      if (!sessCol[i].equals(c) || sessScale[i] !== s) { sessCol[i].copy(c); sessScale[i] = s; if (!active.has(i)) { mesh.setColorAt(i, c); place(i, s); } }
      if (nodes[i].kind !== "file") continue;
      const touched = agents.filter((ag) => ag.foot.has(i) && (!ag.stale || ag.wrote.has(i))), writers = touched.filter((ag) => ag.wrote.has(i));
      if (touched.length < 2 || !writers.length) continue;
      if (focused && !touched.includes(focused)) continue;
      shareOf.set(i, { touched, writers });
      const p = P(i); (writers.length >= 2 ? ov : sh).push(p.x, p.y, p.z);
    }
    setPts(sharedPts, sh); setPts(overlapPts, ov);
    diffs = [];
    for (const ag of agents) if (ag.on && !ag.stale) for (const [i, w] of ag.wrote) if (w.add || w.rem) diffs.push({ i, add: w.add, rem: w.rem, col: ag.col, t: ag.foot.get(i) });
    diffs.sort((p, q) => q.t - p.t); diffs = diffs.slice(0, DIFFS);
    diffPool.forEach((el, k) => { const d = diffs[k]; if (!d) { el.hidden = true; return; } el.hidden = false; el.style.borderColor = d.col.getStyle(); el.innerHTML = `<b class="add">+${d.add}</b> <b class="rem">−${d.rem}</b>`; });
    mesh.instanceColor.needsUpdate = true; mesh.instanceMatrix.needsUpdate = true; needs = true;
  }
  function rebuild(ag) {
    ag.dirty = false;
    const tr = []; ag.hist.forEach((i) => { const p = P(i); tr.push(p.x, p.y, p.z); }); ag.trail.geometry.dispose(); const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(tr.length ? tr : [0, 0, 0]), 3)); ag.trail.geometry = g;
    needs = true;
  }

  // ---- agent cards -----------------------------------------------------------------------------
  const box = document.getElementById("agents");
  agents.forEach((ag) => {
    const row = document.createElement("div"); row.className = "agent"; row.setAttribute("role", "button"); row.tabIndex = 0; row.setAttribute("aria-pressed", "false");
    row.innerHTML = `<span class="dot" style="background:${ag.col.getStyle()}"></span>
      <div><div class="name">${ag.id.toUpperCase()} <button type="button" class="zoom" aria-label="Zoom to ${ag.id.toUpperCase()}" title="Zoom to ${ag.id.toUpperCase()}">⌖</button></div><div class="role">${ROLES[ag.id.replace(/-\d+$/, "")] || ""}</div></div>
      <div class="tkt">—</div>
      <div class="title"></div>
      <div class="where"></div>
      <div class="badges"></div>
      <div class="stats"></div>
      <div class="mem"><div class="bar"><b style="background:${ag.col.getStyle()}"></b></div><span>—</span></div>`;
    const go = () => focusAgent(ag);
    row.querySelector(".zoom").addEventListener("click", (ev) => { ev.stopPropagation(); zoomTo(ag); });
    row.addEventListener("click", go); row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    box.appendChild(row);
    Object.assign(ag, { row, tktEl: row.querySelector(".tkt"), titleEl: row.querySelector(".title"), whereEl: row.querySelector(".where"), badgeEl: row.querySelector(".badges"), statEl: row.querySelector(".stats"), barEl: row.querySelector(".bar b"), memEl: row.querySelector(".mem span") });
  });
  let focused = null;
  function focusAgent(ag) {
    focused = focused === ag ? null : ag;
    agents.forEach((a) => { a.on = !focused || a === focused; a.row.classList.toggle("dim", !a.on); a.row.setAttribute("aria-pressed", String(focused === a)); a.trail.visible = focused === a; a.dirty = true; });
    restyle(); needs = true; // highlights only; the camera stays where the operator put it
  }
  function zoomTo(ag) { controls.autoRotate = false; spin.checked = false; flyTo(ag.orbPos || P(ag.anchor >= 0 ? ag.anchor : 0), R * 0.75);
  }
  const spin = document.getElementById("spin"); spin.checked = controls.autoRotate; spin.addEventListener("change", () => { controls.autoRotate = spin.checked; needs = true; });
  document.getElementById("home").addEventListener("click", () => { if (focused) focusAgent(focused); flyTo(HOME.target, HOME.pos.distanceTo(HOME.target)); });

  // ---- messages between the crew: the brain only notices them; the drawer is where they are read
  const NAME = (id) => id === "MC" ? "HUB" : id.toUpperCase();
  const colOf = (id) => id === "CAPCOM" ? CAP.col : id === "MC" ? flat.ext : agentById.has(id) ? agentById.get(id).col : flat.other;
  const laneKey = (x, y) => [x, y].sort().join("|");
  const MSG = D.comms.map(([mt, f, to, kind, tk, text]) => ({ t: mt, f, to, kind, tk, text }));
  D.questions.forEach(([qt, a, ans, pas, text]) => { // a seat's question; the comms log already carries the ones passed on to the operator
    const dup = MSG.find((m) => m.f === a && Math.abs(m.t - qt) < 3);
    if (dup) { dup.kind = "question"; dup.answered = ans; dup.passed = pas; } else MSG.push({ t: qt, f: a, to: "flight-1", kind: "question", tk: "", text, answered: ans, passed: pas });
  });
  MSG.sort((p, q) => p.t - q.t); MSG.forEach((m, k) => { m.k = k; m.lane = laneKey(m.f, m.to); });
  // a question's answer often travels another lane (asked of CAPCOM, answered by FLIGHT): it joins the question's thread too
  MSG.filter((m) => m.kind === "question" && m.answered != null).forEach((q) => { const r = MSG.find((x) => x.to === q.f && x.t >= q.t && Math.abs(x.t - q.answered) < 30); if (r) { r.alsoLane = q.lane; r.answers = q.k; } });
  const KIND_LABEL = { assign: "assigned", review: "review", plan: "plan", hub: "hub notice", operator: "operator", "to operator": "to operator", question: "question", message: "message" };
  const endPos = (id) => id === "CAPCOM" ? CAP.pos : id === "MC" ? HUBPOS : agentById.has(id) && agentById.get(id).orbPos ? agentById.get(id).orbPos : HUBPOS;
  const ARCS = 10, ARC_SEG = 24, arcs = [];
  const arcPool = Array.from({ length: ARCS }, () => {
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array((ARC_SEG + 1) * 3), 3));
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })); line.visible = false; scene.add(line);
    const el = document.createElement("button"); el.type = "button"; el.className = "arclabel"; el.hidden = true; labels.appendChild(el);
    return { line, el, busy: false };
  });
  function bezier(a, b, k) { const mid = a.clone().add(b).multiplyScalar(0.5); mid.y += a.distanceTo(b) * 0.35 + 6; const u = k / ARC_SEG, v = 1 - u; return new THREE.Vector3(v * v * a.x + 2 * v * u * mid.x + u * u * b.x, v * v * a.y + 2 * v * u * mid.y + u * u * b.y, v * v * a.z + 2 * v * u * mid.z + u * u * b.z); }
  function arcFor(m) {
    const same = arcs.find((x) => x.m.f === m.f && x.m.to === m.to); // a burst between one pair is one arc, ×N; every message stays in the list
    if (same) { same.n++; same.age = 0; same.m = m; return; }
    const slot = arcPool.find((s) => !s.busy); if (!slot) return;
    slot.busy = true; slot.line.visible = true; slot.line.material.color.copy(colOf(m.f)); slot.el.hidden = false; slot.el.style.color = colOf(m.f).getStyle(); slot.el.style.borderColor = colOf(m.f).getStyle();
    const x = { slot, m, n: 1, age: 0 }; slot.el.onclick = () => openLane(x.m); arcs.push(x);
    const a = endPos(m.f).clone(), b = endPos(m.to).clone(), pts = []; for (let k = 0; k <= ARC_SEG; k++) pts.push(bezier(a, b, k));
    if (signals.length < SMAX) signals.push({ path: pathPoints(pts), u: 0, col: colOf(m.f), size: 6.5 });
  }
  const pending = new Map(); // agent → open items the operator should be able to see
  function message(m, visual) {
    if (m.kind === "review" && agentById.has(m.to)) agentById.get(m.to).reviewT = m.t;
    msgDirty = true;
    if (visual) arcFor(m);
  }


  // ---- replay ----------------------------------------------------------------------------------
  const E = D.events, C = D.commits, T = (D.t1 - D.t0) / 1000;
  // three real recorded stretches to watch; the messages log only begins mid-morning, so only the last has message arcs
  const STRETCHES = [[27300, "the night's peak: 3–4 seats running at once"], [29280, "the most calls in five minutes"], [46900, "the morning HUD push, with crew messages"]];
  let START = Math.max(0, D.start - 120) + (+new URLSearchParams(location.search).get("skip") || 0); // ?skip=N: preview only
  let t = 0, ptr = 0, cptr = 0, mptr = 0, selDirty = false, msgDirty = true;
  const perNode = new Map();
  const glow = new Float32Array(N), glowCol = nodes.map(() => new THREE.Color()), active = new Set();
  const cur = nodes.map((n, i) => baseCol[i].clone());
  const SMAX = 160, TAIL = 5, PTS = SMAX * TAIL, signals = [];
  const sg = new THREE.BufferGeometry(), sPos = new Float32Array(PTS * 3), sCol = new Float32Array(PTS * 3), sSize = new Float32Array(PTS);
  sg.setAttribute("position", new THREE.BufferAttribute(sPos, 3)); sg.setAttribute("color", new THREE.BufferAttribute(sCol, 3));
  const sigMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, vertexColors: true, uniforms: { scale: { value: 1 } },
    vertexShader: "attribute float size; varying vec3 vC; void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * (300.0 / -mv.z); gl_Position = projectionMatrix * mv; }",
    fragmentShader: "varying vec3 vC; void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; gl_FragColor = vec4(vC, smoothstep(0.5, 0.2, d)); }" });
  sg.setAttribute("size", new THREE.BufferAttribute(sSize, 1));
  scene.add(new THREE.Points(sg, sigMat));
  function treePath(x, y) {
    const up = []; for (let c = x; c >= 0; c = nodes[c].parent) up.push(c);
    const seen = new Map(up.map((c, k) => [c, k]));
    const down = []; let c = y; while (c >= 0 && !seen.has(c)) { down.push(c); c = nodes[c].parent; }
    if (c < 0) return [x, y];
    return up.slice(0, seen.get(c) + 1).concat(down.reverse());
  }
  function pathPoints(path) { const pts = path.map((x) => x instanceof THREE.Vector3 ? x.clone() : P(x)), len = [0]; for (let k = 1; k < pts.length; k++) len.push(len[k - 1] + pts[k].distanceTo(pts[k - 1])); return { pts, len, total: len[len.length - 1] || 1 }; }
  function along(pp, u) { const d = u * pp.total; let k = 1; while (k < pp.len.length - 1 && pp.len[k] < d) k++; const a = pp.pts[k - 1], b = pp.pts[k] || a, seg = (pp.len[k] - pp.len[k - 1]) || 1; return a.clone().lerp(b, Math.min(1, Math.max(0, (d - pp.len[k - 1]) / seg))); }
  const tokBand = (tok) => tok < 400 ? 4 : tok < 1500 ? 5.4 : tok < 4000 ? 7 : 8.8;
  function lastAt(arr, s, key) { let lo = 0, hi = arr.length - 1, v = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (key(arr[m]) <= s) { v = m; lo = m + 1; } else hi = m - 1; } return v; }
  const ctxAt = (a, s) => { const k = lastAt(D.ctx[a], s, (x) => x[0]); return k < 0 ? 0 : D.ctx[a][k][1]; };
  // the hub's own seat state: running (a turn is open), idle (the turn ended), error, stopped
  const stateAt = (ag, s) => { const arr = D.states[ag.id] || [], k = lastAt(arr, s, (x) => x[0]); return k < 0 ? ["idle", -1e9] : [arr[k][1], arr[k][0]]; };
  // a new ticket starts a clean constellation: nothing from the last one carries over
  function newTicket(ag, name, idx, et) { Object.assign(ag, { ticket: name, ticketIdx: idx, hist: [], tokens: 0, startT: et, prev: -1, mind: [], step: [], stepT: -1, anchor: -1, anchorCand: -1, reviewT: null, lastCommit: null, tests: null, lastWriteT: -1e9, dirty: true }); ag.foot.clear(); ag.recent.clear(); ag.wrote.clear(); ag.sinceCommit.clear(); }
  const LEVELS = [10, 50, 200, 500], level = (ch) => LEVELS.filter((b) => ch > b).length; // lines changed: 1–10, –50, –200, –500, more
  const GREEN = new THREE.Color("#4fdc8a"), RED = new THREE.Color("#ff6b6b"), WHITE = new THREE.Color("#ffffff");
  const rnd = () => new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
  // what a call moved, as a stream: reads flow from the file into the agent, writes from the agent into the file;
  // sized and counted by the tokens it carried (what came back, or what was written), never a share of the message
  const flowSize = (tok) => tok < 100 ? 3.6 : tok < 1000 ? 5.2 : tok < 4000 ? 7 : 9, flowN = (tok) => tok < 100 ? 1 : tok < 1000 ? 2 : tok < 4000 ? 3 : 4;
  function flow(a, b, col, tok) { const pp = pathPoints([a.clone(), b.clone()]), n = flowN(tok), size = flowSize(tok); for (let q = 0; q < n && signals.length < SMAX; q++) signals.push({ path: pp, u: -q * 0.16, col, size }); }
  const floats = [];
  function floatText(i, html, cls) { if (floats.length > 20) return; const el = document.createElement("div"); el.className = "float " + (cls || ""); el.innerHTML = html; labels.appendChild(el); floats.push({ el, i, age: 0 }); }
  const RIPPLES = 70, ripples = [];
  const ripplePool = Array.from({ length: RIPPLES }, () => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: RING, transparent: true, opacity: 0, depthWrite: false })); s.visible = false; scene.add(s); return s; });
  function ripple(i, col, strong, max) { const sp = ripplePool.find((s) => !s.visible); if (!sp) return; sp.visible = true; sp.material.color.copy(col); sp.position.copy(P(i)); ripples.push({ sp, age: 0, max: max || (strong ? 9 : 6) }); }
  function apply(e, visual) {
    const [et, a, k, tg, tk, add, rem, tok] = e, i = targetOf(tg), ag = agents[a];
    let rec = perNode.get(i); if (!rec) perNode.set(i, (rec = {})); const r = (rec[a] = rec[a] || { acc: 0, add: 0, rem: 0, tok: 0 }); r.acc++;
    const name = D.tickets[tk] || "";
    if (name !== ag.ticket && (name || et - ag.lastT > QUIET)) newTicket(ag, name, tk, et);
    const step = et !== ag.lastStepT; // events in one tool call share a timestamp: one step, one cost
    if (step) { ag.tokens += tok; r.tok += tok; }
    ag.lastT = et; ag.lastStepT = et;
    if (i === selected) selDirty = true;
    if (nodes[i].kind === "ext") { ag.extName = D.ext[extNode.indexOf(i)]; ag.extT = et; return; } // outside this repo (a hub call, a reference read): not scope, and it doesn't move the orb
    if (nodes[i].kind === "file" || nodes[i].kind === "ext") { if (!ag.foot.has(i)) ag.dirty = true; ag.foot.set(i, et); if (!ag.recent.has(i)) ag.dirty = true; ag.recent.set(i, et); }
    if (k === 1 && nodes[i].kind === "file") { ag.lastWriteT = et; const w = ag.wrote.get(i) || { add: 0, rem: 0 }; w.add += add; w.rem += rem; r.add += add; r.rem += rem; ag.wrote.set(i, w); ag.sinceCommit.add(i); ag.dirty = true; }
    if (nodes[i].kind !== "ext" && i !== ag.hist[ag.hist.length - 1]) { ag.hist.push(i); if (ag.hist.length > 10) ag.hist.shift(); ag.dirty = true; }
    if (visual && ag.on) {
      glow[i] = 1; glowCol[i].copy(ag.col); active.add(i);
      if (nodes[i].kind !== "dir") ripple(i, ag.col, k === 1);
      if (k === 1 && nodes[i].kind === "file" && (add || rem)) {
        bump.set(i, performance.now()); const p0 = P(i);
        for (let q = 0; q < Math.min(5, Math.ceil(add / 8)) && signals.length < SMAX; q++) signals.push({ path: pathPoints([p0.clone().add(rnd().multiplyScalar(10)), p0.clone()]), u: -q * 0.1, col: GREEN, size: 3.6, spark: true });
        for (let q = 0; q < Math.min(5, Math.ceil(rem / 8)) && signals.length < SMAX; q++) signals.push({ path: pathPoints([p0.clone(), p0.clone().add(rnd().multiplyScalar(10))]), u: -q * 0.1, col: RED, size: 3.6, spark: true });
        const w = ag.wrote.get(i), ch = w.add + w.rem;
        if (level(ch) > level(ch - add - rem)) { ripple(i, WHITE, true, 22); floatText(i, `▲ <b class="add">+${w.add}</b> <b class="rem">−${w.rem}</b>`, "big"); }
      }
    }
    if (step) ag.prev = i;
    if (nodes[i].kind !== "dir") {
      ag.at = i; ag.kind = k;
      if (et !== ag.stepT) { ag.step = []; ag.stepT = et; }
      if (!ag.step.includes(i)) ag.step.push(i);
      ag.mind = ag.mind.filter((m) => m !== i); ag.mind.push(i); if (ag.mind.length > 8) ag.mind.shift();
    }
  }
  // commits are history and live in the agent's own view; here a commit only closes the review it answered
  function commit(c) { const [, a, , by] = c; if (by !== "hub") { agents[a].sinceCommit.clear(); agents[a].reviewT = null; } }
  // tool calls, from a call to its result: what is in flight, what was refused or failed, what the tests said
  const CL = D.calls, RV = D.reviews, MG = D.merges; let clp = 0, rvp = 0, mgp = 0;
  const TOOL_VERB = { Read: "reading", Edit: "editing", MultiEdit: "editing", Write: "writing", Grep: "searching", Glob: "searching" };
  const shortCmd = (c) => c.replace(/^cd \S+ && /, "").split(/\s+/).slice(0, 4).join(" ").slice(0, 34);
  const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
  const callFiles = (c) => c[7].map(targetOf).filter((i) => nodes[i].kind === "file" || nodes[i].kind === "dir").slice(0, 6);
  function callStart(ag, c) {
    if (!ag.on || !ag.orbPos) return;
    if (WRITE_TOOLS.includes(c[2])) callFiles(c).forEach((i) => flow(ag.orbPos, P(i), ag.col, c[9]));
    else if (c[2].startsWith("mcp__mc__")) flow(ag.orbPos, HUBPOS, ag.col, Math.max(50, c[9]));
  }
  function settle(ag, c, visual) {
    if (visual && ag.on && ag.orbPos && !c[5] && !WRITE_TOOLS.includes(c[2]) && c[10] > 0) {
      const into = ag.col.clone().lerp(WHITE, 0.45);
      if (c[2].startsWith("mcp__mc__")) flow(HUBPOS, ag.orbPos, into, c[10]); else callFiles(c).forEach((i) => flow(P(i), ag.orbPos, into, c[10]));
    }
    ag.lastCallEnd = c[4];
    // a call cut off because the run was stopped (the hub ends a run once its plan or review is in) is not the agent failing
    if (c[5]) { const why = c[8] || "", stopped = !(c[5] & 2) && why.startsWith("The user doesn't want to proceed"); ag.trouble.push({ t: c[4], kind: c[5] & 2 ? "refused" : stopped ? "stopped" : "failed", tool: c[2], detail: c[3], why: stopped ? "The run was stopped while this call was waiting." : why }); if (ag.trouble.length > 40) ag.trouble.shift(); }
    if (c[6]) ag.tests = { t: c[4], failed: c[6][0], passed: c[6][1] };
  }
  function callsTo(s, visual) {
    while (clp < CL.length && CL[clp][0] <= s) { const c = CL[clp++]; agents[c[1]].pending.push(c); if (visual && s - c[0] < LIVE_WINDOW) callStart(agents[c[1]], c); }
    while (rvp < RV.length && RV[rvp][0] <= s) { const r = RV[rvp++]; agents[r[1]].reviews.push(r); }
    while (mgp < MG.length && MG[mgp][0] <= s) { const [, num] = MG[mgp++]; agents.forEach((ag) => { if (ag.ticket && ag.ticket.split("#")[1] === num) { ag.mergedNum = num; ag.wrote.clear(); ag.dirty = true; } }); } // merged: no longer unmerged change
    agents.forEach((ag) => { ag.pending = ag.pending.filter((c) => { if (c[4] != null && c[4] <= s) { settle(ag, c, visual && s - c[4] < LIVE_WINDOW); return false; } return c[4] != null || s - c[0] < 900; }); });
  }
  // events, commits and messages in time order; only the last few seconds animate, the rest is caught up quietly
  function advance(to, live) {
    const away = { e: 0, c: 0, m: 0 };
    for (;;) {
      const te = ptr < E.length ? E[ptr][0] : Infinity, tc = cptr < C.length ? C[cptr][0] : Infinity, tm = mptr < MSG.length ? MSG[mptr].t : Infinity;
      const nx = Math.min(te, tc, tm); if (nx > to) break;
      const vis = live > 0 && to - nx < live;
      if (nx === te) { apply(E[ptr++], vis); if (!vis) away.e++; } else if (nx === tc) { commit(C[cptr++], vis); if (!vis) away.c++; } else { message(MSG[mptr++], vis); if (!vis) away.m++; }
    }
    return away;
  }
  function seek(s) {
    t = Math.max(0, Math.min(T, s)); ptr = cptr = mptr = 0; perNode.clear(); signals.length = 0; glow.fill(0); bump.clear(); floats.forEach((f) => f.el.remove()); floats.length = 0;
    for (let i = 0; i < N; i++) active.add(i);
    clp = rvp = mgp = 0;
    agents.forEach((ag) => { newTicket(ag, "", 0, 0); Object.assign(ag, { lastT: -1e9, lastStepT: -1, at: -1, orbPos: null, pending: [], trouble: [], reviews: [], lastCallEnd: -1e9, mergedNum: "" }); });
    advance(t, 0); callsTo(t);
    agents.forEach(updateAnchor); needs = true;
  }
  // an agent's anchor: the folder holding most of its recent work, moved only after a new one holds for a while
  function updateAnchor(ag) {
    const count = new Map();
    for (const [i] of ag.recent) { if (nodes[i].kind !== "file") continue; const d = nodes[i].parent; count.set(d, (count.get(d) || 0) + 1); }
    let best = -1, bc = 0; for (const [d, c] of count) if (c > bc) { bc = c; best = d; }
    if (best < 0) return;
    if (ag.anchor < 0) { ag.anchor = best; return; }
    if (best !== ag.anchorCand) { ag.anchorCand = best; ag.anchorSince = t; }
    if (best !== ag.anchor && t - ag.anchorSince >= ANCHOR_HOLD) ag.anchor = best;
  }

  const fmt = (s) => new Date(D.t0 + s * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const dur = (s) => s < 90 ? Math.round(s) + "s" : s < 5400 ? Math.round(s / 60) + "m" : Math.round(s / 3600) + "h";
  const ago = (s) => dur(s) + " ago";

  // ---- the conversation drawer: one lane (a pair of agents), its threads by ticket, the chosen message in view
  const drawer = document.getElementById("drawer");
  let lane = null; // { key, a, b, sel, tk }
  function openLane(m) { fileOpen = false; lane = { key: m.lane, a: m.f, b: m.to, sel: m.k, tk: "" }; drawer.hidden = false; renderLane(true); }
  drawer.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-act]"); if (!btn) return;
    const act = btn.dataset.act;
    if (act === "close") { lane = null; fileOpen = false; drawer.hidden = true; }
    else if (act === "tk") { lane.tk = btn.dataset.tk; renderLane(false); }
    else if (act === "files") { const ag = agentById.get(btn.dataset.agent); if (ag && focused !== ag) focusAgent(ag); }
    else if (act === "sel") { selectNode(+btn.dataset.i, false, false); }
    else if (act === "zoomfile") { flyTo(P(+btn.dataset.i), R * 0.45); }
    else if (act === "all") { document.getElementById("msgs").scrollIntoView({ block: "nearest" }); }
  });
  function renderLane(scroll) {
    if (!lane) return;
    const all = MSG.filter((m) => (m.lane === lane.key || m.alsoLane === lane.key) && m.t <= t), tks = [...new Set(all.map((m) => m.tk).filter(Boolean))];
    const shown = lane.tk ? all.filter((m) => m.tk === lane.tk) : all;
    const seat = [lane.a, lane.b].find((id) => agentById.has(id) && id !== "flight-1") || [lane.a, lane.b].find((id) => agentById.has(id));
    drawer.innerHTML = `<div class="dhead"><b style="color:${colOf(lane.a).getStyle()}">${NAME(lane.a)}</b> ↔ <b style="color:${colOf(lane.b).getStyle()}">${NAME(lane.b)}</b>
        <button type="button" data-act="close" aria-label="Close the conversation">Close</button></div>
      <div class="dsub">${all.length} message${all.length === 1 ? "" : "s"} so far${tks.length ? " · " + tks.length + " ticket thread" + (tks.length === 1 ? "" : "s") : ""}</div>
      ${tks.length > 1 ? `<div class="chips"><button type="button" data-act="tk" data-tk="" aria-pressed="${!lane.tk}">All</button>${tks.map((k) => `<button type="button" data-act="tk" data-tk="${esc(k)}" aria-pressed="${lane.tk === k}">#${esc(k)}</button>`).join("")}</div>` : ""}
      <div class="dlist">${shown.map((m) => `<div class="dmsg${m.k === lane.sel ? " sel" : ""}" data-k="${m.k}">
        <div class="dmeta"><span>${fmt(m.t)}</span> <b style="color:${colOf(m.f).getStyle()}">${NAME(m.f)}</b> → <b style="color:${colOf(m.to).getStyle()}">${NAME(m.to)}</b> · ${KIND_LABEL[m.kind]}${m.tk ? " · #" + esc(m.tk) : ""}${m.kind === "question" ? " · " + qState(m) : ""}${m.answers != null && m.lane !== lane.key ? " · the answer" : ""}</div>
        <div class="dtext">${esc(m.text)}</div></div>`).join("") || "<div class='dmeta'>Nothing in this thread yet.</div>"}</div>
      ${seat ? `<div class="dfoot"><button type="button" data-act="files" data-agent="${seat}">Show ${NAME(seat)}'s files</button></div>` : ""}`;
    lane.count = all.length;
    if (scroll) { const s = drawer.querySelector(".dmsg.sel"); if (s) s.scrollIntoView({ block: "nearest" }); }
  }
  function openTrouble(ag) {
    fileOpen = false;
    lane = null; drawer.hidden = false;
    const rows = ag.trouble.filter((x) => t - x.t <= 3600).reverse();
    drawer.innerHTML = `<div class="dhead"><b style="color:${ag.col.getStyle()}">${ag.id.toUpperCase()}</b> · refused and failed calls <button type="button" data-act="close" aria-label="Close">Close</button></div>
      <div class="dsub">The last hour, newest first. Refused: the CLI's permissions or the hub's guard said no. Failed: the call ran and returned an error. Stopped: the run ended while the call waited (not counted on the card).</div>
      <div class="dlist">${rows.map((x) => `<div class="dmsg"><div class="dmeta"><span>${fmt(x.t)}</span> <b class="${x.kind === "refused" ? "rem" : x.kind === "failed" ? "warn" : ""}">${x.kind}</b> · ${esc(x.tool.replace("mcp__mc__", "mc "))}${x.detail && x.detail !== x.tool.replace("mcp__mc__", "mc ") ? " · " + esc(x.detail) : ""}</div><div class="dtext">${esc(x.why)}</div></div>`).join("") || "<div class='dmeta'>Nothing refused or failed in the last hour.</div>"}</div>`;
  }
  function openFindings(ag) {
    fileOpen = false;
    lane = null; drawer.hidden = false; const rv = ag.review; if (!rv) return;
    drawer.innerHTML = `<div class="dhead"><b style="color:${ag.col.getStyle()}">${ag.id.toUpperCase()}</b> · #${esc(rv[2])} review round ${rv[4]} <button type="button" data-act="close" aria-label="Close">Close</button></div>
      <div class="dsub">RETRO's review of PR ${rv[3]} at ${esc(rv[5])}, ${ago(t - rv[0])}: ${rv[6].length} findings. They stay until the next review or the merge; the hub doesn't mark a finding fixed.</div>
      <div class="dlist">${rv[6].map((f) => `<div class="dmsg"><div class="dmeta"><b style="color:${SEV_COL[f[3]]}">${SEV_NAME[f[3]]}</b> · ${f[0] >= 0 ? `<button type="button" data-act="sel" data-i="${fileNode[f[0]]}">${esc(f[1])}:${f[2]}</button>` : esc(f[1]) + ":" + f[2]}</div><div class="dtext">${esc(f[4])}</div><div class="dtext fix">Fix: ${esc(f[5])}</div></div>`).join("") || "<div class='dmeta'>No findings.</div>"}</div>`;
  }
  const qState = (m) => m.answered != null && m.answered <= t ? "answered" : m.passed != null && m.passed <= t ? "with the operator" : "awaiting reply";

  // ---- hover, select, search -------------------------------------------------------------------
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2(), tip = document.getElementById("tip");
  let selected = -1;
  const setMouse = (ev) => { const r = renderer.domElement.getBoundingClientRect(); mouse.set((ev.clientX - r.left) / r.width * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(mouse, camera); };
  const pickOrb = () => { const h = ray.intersectObjects(agents.filter((ag) => ag.orb.visible).map((ag) => ag.orb))[0]; return h ? agents[h.object.userData.agent] : null; };
  const pick = () => { const h = ray.intersectObject(mesh)[0]; return h ? h.instanceId : -1; };
  const who = (i) => agents.filter((ag) => ag.foot.has(i)).map((ag) => { const w = ag.wrote.get(i); return `<span style="color:${ag.col.getStyle()}">${ag.id.toUpperCase()}</span>${w ? ` wrote +${w.add} −${w.rem}` : " read"}${ag.ticket ? " · #" + ag.ticket.split("#")[1] : ""}`; });
  renderer.domElement.addEventListener("pointermove", (ev) => {
    setMouse(ev); const r = stage.getBoundingClientRect(), place = () => { tip.hidden = false; tip.style.left = Math.min(r.width - 330, ev.clientX - r.left + 14) + "px"; tip.style.top = ev.clientY - r.top + 14 + "px"; };
    const ag = pickOrb();
    if (ag) { place(); tip.innerHTML = `<span style="color:${ag.col.getStyle()}">${ag.id.toUpperCase()}</span> · ${ag.state}${ag.stateFor ? " " + dur(ag.stateFor) : ""}<br><span style="color:var(--muted)">click to follow</span>`; return; }
    const i = pick(); if (i < 0) { tip.hidden = true; return; }
    const n = nodes[i], h = who(i), so = shareOf.get(i);
    place();
    tip.innerHTML = `${esc(n.id || D.repo)}<br><span style="color:var(--muted)">${n.kind === "file" ? n.lines + " lines" : n.kind}</span>${so ? `<br><span style="color:var(--overlap)">${so.writers.length >= 2 ? "write overlap" : "shared"}: ${so.touched.length} branches touched it, ${so.writers.length} wrote it</span>` : ""}${h.length ? "<br>" + h.join("<br>") : ""}${(findOf.get(i) || []).map((x) => `<br><span style="color:${SEV_COL[x.f[3]]}">▲ ${SEV_NAME[x.f[3]]} · line ${x.f[2]}</span> ${esc(x.f[4].slice(0, 90))}`).join("")}`;
  });
  renderer.domElement.addEventListener("pointerleave", () => { tip.hidden = true; });
  renderer.domElement.addEventListener("click", (ev) => { setMouse(ev); const ag = pickOrb(); if (ag) { focusAgent(ag); return; } const i = pick(); if (i >= 0) selectNode(i, false); });
  let fileOpen = false;
  function selectNode(i, frame, open) { selected = i; fileOpen = open !== false; showDetail(); glow[i] = 1; glowCol[i].copy(CAP.col); active.add(i); if (frame) flyTo(P(i), R * 0.45); needs = true; }
  function showFile() { // the selected file in the drawer, refreshed while it is open
    if (!fileOpen || selected < 0) return;
    lane = null; drawer.hidden = false;
    drawer.innerHTML = `<div class="dhead">File <button type="button" data-act="zoomfile" data-i="${selected}">⌖ Zoom</button><button type="button" data-act="close" aria-label="Close">Close</button></div><div class="dlist detail">${document.getElementById("detail").innerHTML}</div>`;
  }
  function showDetail() {
    if (selected < 0) return;
    const n = nodes[selected], rec = perNode.get(selected) || {}, so = shareOf.get(selected);
    const rows = Object.keys(rec).map((a) => { const r = rec[a], ag = agents[a]; return `<div><span style="color:${ag.col.getStyle()}">${D.agents[a].toUpperCase()}</span> · ${r.acc} touches${r.add || r.rem ? ` · wrote +${r.add} −${r.rem}` : ""}${ag.foot.has(selected) ? " · in its current ticket" : ""}</div>`; }).join("");
    document.getElementById("detail").innerHTML = `<b>${esc(n.id || D.repo)}</b><br>${n.kind}${n.kind === "file" ? " · " + n.lines + " lines" : ""} · ${AREA_NAME[n.area]}${importsOf[selected].length ? " · " + importsOf[selected].length + " import links (highlighted)" : ""}${so ? `<br><span style="color:var(--overlap)">${so.writers.length >= 2 ? "Write overlap" : "Shared"}: ${so.writers.map((ag) => ag.id.toUpperCase()).join(", ")} wrote it on separate branches${so.writers.length >= 2 ? "; a merge may or may not conflict" : ""}</span>` : ""}<br>${rows || "Nobody has touched it in the recorded window yet."}${(findOf.get(selected) || []).map((x) => `<div style="margin-top:6px"><span style="color:${SEV_COL[x.f[3]]}">▲ ${SEV_NAME[x.f[3]]}</span> · line ${x.f[2]} · review of #${esc(x.rv[2])} round ${x.rv[4]}<br>${esc(x.f[4])}<br><span style="color:var(--muted)">Fix: ${esc(x.f[5])}</span></div>`).join("")}`;
    const g = new THREE.BufferGeometry(), p = [], c = [];
    importsOf[selected].forEach((k) => { const [a, b] = imports[k]; p.push(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2], pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]); const col = new THREE.Color(css("--signal")); c.push(col.r, col.g, col.b, col.r, col.g, col.b); });
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(p.length ? p : [0, 0, 0, 0, 0, 0]), 3)); g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(c.length ? c : [0, 0, 0, 0, 0, 0]), 3));
    hiImports.geometry.dispose(); hiImports.geometry = g; needs = true; showFile();
  }
  const find = document.getElementById("find"), found = document.getElementById("found");
  find.addEventListener("input", () => {
    const q = find.value.trim().toLowerCase();
    const hits = q.length < 2 ? [] : nodes.map((n, i) => [n, i]).filter(([n]) => (n.kind === "file" || n.kind === "dir") && n.id.toLowerCase().includes(q)).slice(0, 8);
    found.innerHTML = hits.map(([n, i]) => `<button type="button" data-i="${i}">${esc(n.id)}</button>`).join("") || (q.length >= 2 ? "<span>No file or folder matches.</span>" : "");
  });
  found.addEventListener("click", (ev) => { const b = ev.target.closest("button[data-i]"); if (b) selectNode(+b.dataset.i, true); });

  // ---- cards, updated on change, not every frame -------------------------------------------------
  function refreshCards() {
    // the current review of each agent's ticket, and its findings pinned on files
    findOf.clear(); const fp = [[], [], []];
    agents.forEach((ag) => {
      ag.review = null; const num = ag.ticket ? ag.ticket.split("#")[1] : "";
      if (!num || !ag.on || ag.mergedNum === num) return;
      for (let q = ag.reviews.length - 1; q >= 0; q--) if (ag.reviews[q][2] === num) { ag.review = ag.reviews[q]; break; }
      if (ag.review) ag.review[6].forEach((f) => { if (f[0] < 0) return; const i = fileNode[f[0]]; if (!findOf.has(i)) findOf.set(i, []); findOf.get(i).push({ ag, f, rv: ag.review }); });
    });
    const fsig = [...findOf.keys()].join(",");
    if (fsig !== findSig) { findSig = fsig; for (const [i, list] of findOf) { const p = P(i).add(new THREE.Vector3(0, 6, 0)); fp[Math.min(...list.map((x) => x.f[3]))].push(p.x, p.y, p.z); } findPts.forEach((fpts, k) => setPts(fpts, fp[k])); needs = true; }
    agents.forEach((ag, a) => {
      let add = 0, rem = 0; for (const w of ag.wrote.values()) { add += w.add; rem += w.rem; }
      const recentN = [...ag.recent.values()].filter((et) => t - et <= RECENT).length;
      const num = ag.ticket ? ag.ticket.split("#")[1] : "";
      ag.tktEl.textContent = num ? "#" + num : "—";
      ag.titleEl.textContent = num ? (D.titles[ag.ticketIdx] || "") : "";
      ag.whereEl.textContent = ag.anchor >= 0 ? "in " + (nodes[ag.anchor].id || D.repo) : "";
      const nowN = ag.docked ? 0 : new Set(ag.pending.filter((c) => c[0] <= t).flatMap((c) => c[7])).size;
      ag.row.classList.toggle("idle", ag.docked);
      if (ag.docked) { ag.tktEl.textContent = "—"; ag.titleEl.textContent = ""; ag.whereEl.textContent = ""; }
      ag.statEl.textContent = ag.lastT < 0 ? "no activity on this repo in this window" : ag.docked ? `${ag.state}${ag.stateFor ? " " + dur(ag.stateFor) : ""}` : `${ag.state}${ag.stateFor ? " " + dur(ag.stateFor) : ""} · in scope ${ag.foot.size} files · modified ${ag.wrote.size} (+${add} −${rem}) · accessing ${nowN} now`;
      // open items: questions waiting for an answer, review findings not yet answered by a commit
      const badges = [];
      const qs = MSG.filter((m) => m.kind === "question" && m.f === ag.id && m.t <= t && qState(m) !== "answered");
      if (qs.length) { const w = qs.filter((m) => qState(m) === "awaiting reply"), o = qs.length - w.length; badges.push([qs[0], (w.length ? `${w.length} awaiting reply · oldest ${dur(t - w[0].t)}` : "") + (o ? `${w.length ? " · " : ""}${o} with the operator` : "")]); }
      const html0 = badges.map(([m, text]) => `<button type="button" class="badge" data-k="${m.k}">${esc(text)}</button>`).join("");
      // stuck signals: calls refused or failed in the last 10 minutes, with the latest reason
      const tr = ag.trouble.filter((x) => t - x.t <= 600 && x.kind !== "stopped"), nr = tr.filter((x) => x.kind === "refused").length, nf = tr.length - nr;
      const trHtml = tr.length ? `<button type="button" class="badge bad" data-tr="${a}">${esc([nr ? nr + " refused" : "", nf ? nf + " failed" : ""].filter(Boolean).join(" · ") + " in 10 min · " + (tr[tr.length - 1].why || tr[tr.length - 1].detail).slice(0, 60))}</button>` : "";
      // checks: the last local test run, and whether the branch was edited after it; the current review round
      const ts = ag.tests && !ag.docked && ag.tests.t >= ag.startT ? ag.tests : null; // this ticket's tests only
      const tsHtml = ts ? `<span class="badge ${ts.failed ? "bad" : "ok"}">${esc(`local tests: ${ts.failed ? ts.failed + " failed, " : ""}${ts.passed} passed · ${ago(t - ts.t)}${ag.lastWriteT > ts.t ? " · edited since" : ""}`)}</span>` : "";
      const rv = ag.review, cnt = rv ? [0, 1, 2].map((k) => rv[6].filter((f) => f[3] === k).length) : null;
      const rvHtml = rv ? `<button type="button" class="badge ${cnt[0] + cnt[1] ? "bad" : "ok"}" data-rv="${a}">${esc(`review round ${rv[4]} @${rv[5]}: ${rv[6].length ? cnt.map((n, k) => n ? n + " " + SEV_NAME[k] : "").filter(Boolean).join(", ") : "no findings"} · ${ago(t - rv[0])}`)}</button>` : "";
      const html = html0 + trHtml + rvHtml + tsHtml;
      if (ag.badgeHtml !== html) { ag.badgeHtml = html; ag.badgeEl.innerHTML = html; ag.badgeEl.querySelectorAll("button").forEach((b) => b.addEventListener("click", (ev) => { ev.stopPropagation(); if (b.dataset.k) openLane(MSG[+b.dataset.k]); else if (b.dataset.tr) openTrouble(agents[+b.dataset.tr]); else if (b.dataset.rv) openFindings(agents[+b.dataset.rv]); })); }
      const ctx = ctxAt(a, t), live = !ag.docked && ag.state !== "idle" && ag.state !== "error";
      ag.barEl.style.width = live ? Math.min(100, ctx / ag.window * 100) + "%" : "0%";
      ag.memEl.textContent = live && ctx ? `context ${Math.round(ctx / 1000)}k of ${ag.window >= 1e6 ? ag.window / 1e6 + "M" : Math.round(ag.window / 1000) + "k"}` : "—";
      ag.label.textContent = ag.id.toUpperCase() + (num && !ag.docked ? " · #" + num : "") + " · " + ag.state + (ag.stateFor ? " " + dur(ag.stateFor) : "") + (ag.more ? ` · +${ag.more} more files` : "");
    });
    if (msgDirty) { msgDirty = false; if (lane && MSG.slice(0, mptr).filter((m) => m.lane === lane.key || m.alsoLane === lane.key).length !== lane.count) renderLane(false); }
    if (selDirty) { selDirty = false; showDetail(); }
  }

  // ---- frame loop: event time follows the wall clock, not the frame rate ------------------------
  const clock = document.getElementById("clock"), proj = new THREE.Vector3(), tmp = new THREE.Color(), toast = document.getElementById("toast");
  const areaLabels = ["server", "web", "core", "docs"].map((k) => {
    const el = document.createElement("div"); el.className = "alabel"; el.style.color = AREA[k]; el.textContent = AREA_NAME[k]; labels.appendChild(el);
    const c = new THREE.Vector3(); let n = 0; nodes.forEach((nd, i) => { if (nd.area === k && nd.kind === "file") { c.add(P(i)); n++; } });
    return { el, p: c.multiplyScalar(1 / Math.max(1, n)) };
  });
  let prev = performance.now(), lastDraw = 0, lastRebuild = 0, lastCards = 0, lastClock = "", toastT = 0;
  let wall0 = performance.now();
  const stretchSel = document.getElementById("stretch");
  stretchSel.innerHTML = STRETCHES.map(([s, name]) => `<option value="${s}">${fmt(s)} · ${name}</option>`).join("");
  stretchSel.value = String(D.start);
  stretchSel.addEventListener("change", () => { // start the chosen stretch from its beginning, at real speed
    START = Math.max(0, +stretchSel.value - 120); wall0 = performance.now(); arcs.slice().forEach((x) => { x.slot.busy = false; x.slot.line.visible = false; x.slot.el.hidden = true; }); arcs.length = 0;
    lane = null; drawer.hidden = true; seek(START); restyle(); needs = true;
  });
  function resize() { const w = stage.clientWidth, h = stage.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); needs = true; }
  new ResizeObserver(resize).observe(stage);
  function loop(now) {
    requestAnimationFrame(loop);
    if (document.hidden || now - lastDraw < 1000 / 30) return;
    const dt = Math.min(0.1, (now - prev) / 1000); prev = now; lastDraw = now;
    const target = Math.min(T, START + (now - wall0) / 1000);
    if (target > t) {
      const away = advance(target, LIVE_WINDOW); t = target;
      if (away.e + away.c + away.m > 0) { // back from a hidden tab: say what was missed instead of replaying it
        toast.textContent = `While this tab was hidden: ${away.e} tool events, ${away.c} commits, ${away.m} messages. The map shows where things stand now.`; toast.hidden = false; toastT = now;
        agents.forEach((ag) => { ag.orbPos = null; });
      }
    }
    if (!toast.hidden && now - toastT > 7000) toast.hidden = true;
    // recent attention fades by event time; footprint and writes stay for the ticket
    agents.forEach((ag) => { for (const [i, et] of ag.recent) if (t - et > RECENT) { ag.recent.delete(i); ag.dirty = true; } });
    if (now - lastRebuild > 250) { lastRebuild = now; let any = false; agents.forEach((ag) => { updateAnchor(ag); if (ag.dirty) { rebuild(ag); any = true; } }); if (any) restyle(); }
    // a node just touched brightens once and settles
    const k = Math.pow(0.5, dt / (SETTLE / 2.5));
    for (const i of active) {
      glow[i] *= k;
      tmp.copy(sessCol[i]).lerp(glowCol[i].clone().multiplyScalar(1.35).addScalar(0.15), Math.min(1, glow[i]));
      cur[i].copy(tmp); mesh.setColorAt(i, cur[i]); place(i, sessScale[i] * (1 + glow[i] * (nodes[i].kind === "file" ? 0.9 : nodes[i].kind === "ext" ? 0.25 : 0)));
      if (glow[i] < 0.01) { glow[i] = 0; mesh.setColorAt(i, sessCol[i]); place(i, sessScale[i]); active.delete(i); }
    }
    if (active.size) { mesh.instanceColor.needsUpdate = true; mesh.instanceMatrix.needsUpdate = true; needs = true; }
    for (let s = signals.length - 1; s >= 0; s--) { signals[s].u += dt / (signals[s].spark ? 0.8 : signals[s].mote ? 2.2 : TRAVEL * Math.min(1.8, 0.6 + signals[s].path.total / 120)); if (signals[s].u >= 1 + TAIL * 0.045) signals.splice(s, 1); }
    if (signals.length || sg.userData.had) {
      for (let s = 0; s < SMAX; s++) {
        const sgl = signals[s];
        for (let q = 0; q < TAIL; q++) {
          const o = s * TAIL + q;
          const u = sgl ? sgl.u - q * 0.045 : -1;
          if (!sgl || u < 0) { sSize[o] = 0; continue; }
          const v = along(sgl.path, Math.min(1, u));
          sPos[o * 3] = v.x; sPos[o * 3 + 1] = v.y; sPos[o * 3 + 2] = v.z;
          const f = Math.min(1, Math.sin(Math.PI * Math.min(1, sgl.u)) * 1.4) * (1 - q / TAIL);
          sCol[o * 3] = Math.min(1, sgl.col.r * 1.2) * f; sCol[o * 3 + 1] = Math.min(1, sgl.col.g * 1.2) * f; sCol[o * 3 + 2] = Math.min(1, sgl.col.b * 1.2) * f; sSize[o] = q === 0 ? sgl.size : Math.max(2.4, sgl.size * (1 - q * 0.15));
        }
      }
      sg.attributes.position.needsUpdate = true; sg.attributes.color.needsUpdate = true; sg.attributes.size.needsUpdate = true; needs = true;
      sg.userData.had = signals.length > 0; // one more pass after the last signal clears its points
    }
    if (fly) { fly.u = Math.min(1, fly.u + dt / 0.9); const e = 1 - Math.pow(1 - fly.u, 3); controls.target.lerpVectors(fly.from, fly.to, e); camera.position.lerpVectors(fly.pFrom, fly.pTo, e); if (fly.u >= 1) fly = null; needs = true; }
    // the hub's seat state decides where an orb is: running and calling tools, over the step's files;
    // running with no tool call, thinking, over the files in mind, which pulse; idle a minute, the dock
    agents.forEach((ag) => {
      const [st, stT] = stateAt(ag, t), since = t - ag.lastT, running = st === "running";
      const cur = ag.pending[ag.pending.length - 1];
      const verb = !cur ? "" : cur[2].startsWith("mcp__mc__") ? "using " + cur[3] : cur[2] === "Bash" ? "running " + shortCmd(cur[3]) : (TOOL_VERB[cur[2]] ? TOOL_VERB[cur[2]] + " " + cur[3] : cur[2]);
      ag.state = running || cur ? (cur ? verb : "thinking") : st === "error" ? "error" : st === "stopped" ? "stopped" : "idle";
      ag.stateFor = cur ? t - cur[0] : running ? t - Math.max(ag.lastCallEnd, stT) : t - stT;
      if (ag.stateFor > 1e6) ag.stateFor = 0;
      ag.docked = !cur && (ag.lastT < 0 || (!running && t - stT > DOCK_AFTER) || since > QUIET);
      const stale = ag.lastT < 0 || ag.docked; // docked: not working here now, so its files stop tinting the map
      if (stale !== ag.stale) { ag.stale = stale; ag.dirty = true; }
      if (!ag.ticket && running && ag.turnStart !== stT) { // no ticket (FLIGHT): its scope is the turn in progress
        ag.turnStart = stT; // the hub logs a turn's start up to ~2 s after its first tool call, so keep those
        for (const [i, ft] of ag.foot) if (ft < stT - 3) { ag.foot.delete(i); ag.wrote.delete(i); ag.recent.delete(i); }
        ag.mind = ag.mind.filter((i) => ag.foot.has(i)); ag.step = ag.step.filter((i) => ag.foot.has(i)); ag.dirty = true;
      }
      const focus = ag.docked ? [] : (cur ? ag.step : ag.mind).filter((i) => i >= 0);
      const centre = new THREE.Vector3(); focus.forEach((i) => centre.add(P(i)));
      const dock = new THREE.Vector3(box3.min.x - size.x * 0.16, C0.y + size.y * 0.3 - ag.a * size.y * 0.13, C0.z - size.z * 0.2); // the dock: a column left of the brain, mirroring the rail
      const goal = focus.length ? centre.multiplyScalar(1 / focus.length).add(new THREE.Vector3(0, ag.state === "thinking" ? 16 : 9, 0)) : dock;
      if (!ag.orbPos) ag.orbPos = goal.clone();
      const before = ag.orbPos.clone(); ag.orbPos.lerp(goal, 1 - Math.pow(0.12, dt)); // glides, never jumps
      if (before.distanceToSquared(ag.orbPos) > 1e-4) needs = true;
      ag.orb.position.copy(ag.orbPos); ag.halo.position.copy(ag.orbPos);
      const ctx = ctxAt(ag.a, t), thinking = ag.state === "thinking", pulse = thinking && !reduced ? 0.88 + 0.12 * Math.sin(now / 520) : 1;
      ag.halo.scale.setScalar((7 + Math.sqrt(ctx / 200000) * 16) * pulse);
      ag.halo.material.opacity = ag.docked ? 0.05 : ag.state === "idle" ? 0.08 : thinking ? 0.2 : 0.35;
      ag.orb.material.color.copy(ag.col).multiplyScalar(ag.docked ? 0.3 : ag.state === "idle" ? 0.55 : 1.15);
      // filaments: one per file in focus, up to FIL; the rest are counted on the label, never implied
      const bp = ag.beam.geometry.attributes.position.array, bc = ag.beam.geometry.attributes.color.array;
      const links = ag.docked ? [] : !cur ? ag.mind.map((i) => [i, thinking ? 0.3 : 0.12]) : ag.step.map((i) => [i, 0.9]).concat(ag.mind.filter((i) => !ag.step.includes(i)).slice(-4).map((i) => [i, 0.18]));
      ag.more = cur ? Math.max(0, ag.step.length - FIL) : 0;
      for (let q = 0; q < FIL; q++) {
        const l = links[q], p = l ? P(l[0]) : ag.orbPos, f = l ? l[1] : 0;
        bp.set([ag.orbPos.x, ag.orbPos.y, ag.orbPos.z, p.x, p.y, p.z], q * 6);
        bc.set([ag.col.r * f, ag.col.g * f, ag.col.b * f, ag.col.r * f * 0.6, ag.col.g * f * 0.6, ag.col.b * f * 0.6], q * 6);
      }
      ag.beam.geometry.attributes.position.needsUpdate = true; ag.beam.geometry.attributes.color.needsUpdate = true;
      ag.beam.visible = ag.on && links.length > 0; ag.orb.visible = ag.halo.visible = ag.on && ag.lastT >= 0;
      if (ag.on && thinking && !reduced) needs = true; // only the orb's halo breathes; nothing claims to know which files it is thinking about
    });
    // being accessed now: rings on the files of each call in flight (and, fainter, the files a thinking agent touched last)
    const nowA = [], mindA = [];
    callsTo(t, true);
    agents.forEach((ag) => { if (!ag.on || ag.docked) return; const open = ag.pending.filter((c) => c[0] <= t); if (open.length) open.forEach((c) => c[7].forEach((x) => { const i = targetOf(x); if (nodes[i].kind === "file") nowA.push(i); })); else if (ag.state === "thinking") mindA.push(...ag.mind); });
    const sig = nowA.join(",") + "|" + mindA.join(",");
    if (sig !== nowSig) { nowSig = sig; const f = (arr) => arr.flatMap((i) => { const p = P(i); return [p.x, p.y, p.z]; }); setPts(nowPts, f(nowA)); setPts(mindPts, f(mindA)); needs = true; }
    // message arcs: fade in, hold, fade out; they follow the orbs while they last
    for (let q = arcs.length - 1; q >= 0; q--) {
      const x = arcs[q]; x.age += dt;
      if (x.age >= ARC_LIFE) { x.slot.busy = false; x.slot.line.visible = false; x.slot.el.hidden = true; arcs.splice(q, 1); continue; }
      const a = endPos(x.m.f), b = endPos(x.m.to), arr = x.slot.line.geometry.attributes.position.array;
      for (let s = 0; s <= ARC_SEG; s++) { const v = bezier(a, b, s); arr[s * 3] = v.x; arr[s * 3 + 1] = v.y; arr[s * 3 + 2] = v.z; }
      x.slot.line.geometry.attributes.position.needsUpdate = true;
      x.op = Math.min(1, x.age / 0.25, (ARC_LIFE - x.age) / 0.6); x.slot.line.material.opacity = 0.75 * x.op; x.mid = bezier(a, b, ARC_SEG / 2);
      x.slot.el.textContent = KIND_LABEL[x.m.kind] + (x.n > 1 ? " ×" + x.n : "");
      needs = true;
    }
    if (now - lastCards > 400) { lastCards = now; refreshCards(); }
    const d = new Date(D.t0 + t * 1000), cl = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (cl !== lastClock) { lastClock = cl; clock.firstChild.nodeValue = cl; document.getElementById("clockday").textContent = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); }
    controls.update(); if (controls.autoRotate) needs = true;
    if (ripples.length || floats.length) needs = true;
    const nowMs = performance.now(); for (const v of bump.values()) if (nowMs - v < 1300) { needs = true; break; }
    if (!needs) return; // settled: nothing moved, nothing to draw
    needs = false;
    const r = stage.getBoundingClientRect();
    const toScreen = (v) => { proj.copy(v).project(camera); return { x: (proj.x + 1) / 2 * r.width, y: (1 - proj.y) / 2 * r.height, vis: proj.z < 1 }; };
    agents.forEach((ag) => {
      if (ag.orbPos && ag.on && ag.lastT >= 0) { const s = toScreen(ag.orbPos); ag.lx = s.x; ag.ly = s.y - 12; ag.label.style.opacity = s.vis ? (ag.docked ? 0.45 : 1) : 0; }
      else { ag.lx = null; ag.label.style.opacity = 0; }
    });
    // labels sit on their orb; only labels that would overlap are nudged up, one row each
    const placed = [];
    agents.filter((ag) => ag.lx != null).sort((p, q) => p.ly - q.ly).forEach((ag) => {
      let y = ag.ly; while (placed.some((p) => Math.abs(p.x - ag.lx) < 120 && Math.abs(p.y - y) < 18)) y -= 18;
      placed.push({ x: ag.lx, y }); ag.label.style.left = ag.lx + "px"; ag.label.style.top = y + "px";
    });
    { const s = toScreen(CAP.pos); capLabel.style.left = s.x + "px"; capLabel.style.top = s.y - 10 + "px"; capLabel.style.opacity = s.vis ? 0.9 : 0; }
    { const s = toScreen(HUBPOS); hubLabel.style.left = s.x + "px"; hubLabel.style.top = s.y - 10 + "px"; hubLabel.style.opacity = s.vis ? 0.8 : 0; }
    const taken = [];
    diffPool.forEach((el, k) => { const d = diffs[k]; if (!d) return; const s = toScreen(P(d.i)); let y = s.y - 12; while (taken.some((p) => Math.abs(p.x - s.x) < 56 && Math.abs(p.y - y) < 14)) y -= 14; taken.push({ x: s.x, y }); el.style.left = s.x + "px"; el.style.top = y + "px"; el.style.opacity = s.vis ? 1 : 0; el.classList.toggle("bump", nowMs - (bump.get(d.i) || -1e9) < 1200); });
    arcs.forEach((x) => { const s = toScreen(x.mid); x.slot.el.style.left = s.x + "px"; x.slot.el.style.top = s.y + "px"; x.slot.el.style.opacity = s.vis ? x.op : 0; });
    areaLabels.forEach((l) => { const s = toScreen(l.p); l.el.style.left = s.x + (l.right ? 10 : 0) + "px"; l.el.style.top = s.y + (l.right ? 0 : 22) + "px"; l.el.style.opacity = s.vis ? (l.right ? 0.75 : 0.55) : 0; });
    for (let q = ripples.length - 1; q >= 0; q--) {
      const rp = ripples[q]; rp.age += dt;
      const u = rp.age / 1.4; if (u >= 1) { rp.sp.visible = false; ripples.splice(q, 1); continue; }
      rp.sp.scale.setScalar(2 + u * rp.max); rp.sp.material.opacity = 0.7 * (1 - u);
    }
    for (let q = floats.length - 1; q >= 0; q--) {
      const fl = floats[q]; fl.age += dt;
      if (fl.age > 2.4) { fl.el.remove(); floats.splice(q, 1); continue; }
      const s = toScreen(P(fl.i)); fl.el.style.left = s.x + "px"; fl.el.style.top = s.y - 22 - fl.age * 18 + "px"; fl.el.style.opacity = s.vis ? Math.min(1, (2.4 - fl.age) / 0.6) : 0;
    }
    renderer.render(scene, camera);
  }
  document.getElementById("foot").textContent = `Recorded crew activity on ${D.repo} only, playing at real speed from the stretch picked below (an artifact can't reach the hub, so it isn't live). Commits, merges and history are in each agent's own view. Colour code: a file a ticket's branch has read is dim in the agent's colour (in scope); a file it has modified is bright, sized by lines changed, with a +/− label that pulses on each new edit (edit churn, not the final diff). A white ring marks a file a tool call in flight is using; a faint one, the files a thinking agent touched last. Docked agents drop their reads but keep their unmerged changes (dimmer) until the PR merges. ▲ pins are the findings of the current RETRO review of that agent's ticket: red Critical, amber Important, grey Minor; the hub doesn't mark findings fixed, so they stay until the next review or the merge. Particles are the calls: a read, search or command flows from its files into the agent once its result is back, a write flows from the agent into the file as it starts, and a hub call flows to and from HUB; each is sized and counted by the tokens it carried (what came back, or what was written, at about four characters a token). An edit sparks green into the file for lines added and red out for lines removed; a modified file grows in levels (1–10, 50, 200, 500 lines changed, more), and crossing one bursts and shows its total. Agents often issue several calls at once (29% of tool-calling messages here, up to 16), so one orb can link to many files. Orbs: the call in flight names the state ("running pnpm -s vitest run 42s"); a running turn with no call in flight is thinking (the model generating); idle a minute, the dock. Cards: calls refused (CLI permissions or the hub's guard) or failed (ran and errored) in the last 10 minutes with the latest reason; the last local test result, and whether the branch was edited after it; the current review round. A dashed ring: a modified file another branch also touched; a double ring: two branches modified it (write overlap, not a confirmed conflict). Messages arc between seats, HUB and CAPCOM. Context is measured against the window each run reports (1M for every seat here).`;
  if (location.search.includes("debug")) window.__mc = { findOf, findPts, agents, signals, floats, camera }; // preview only
  seek(START);
  resize(); refreshCards(); restyle();
  requestAnimationFrame(loop);
})();
