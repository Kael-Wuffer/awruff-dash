/* dash.awruff.org — front end.
 *
 * No framework on purpose. Fetch /api/state, draw it, do it again in ten
 * seconds. If you are reading this at 11pm six months from now: the whole
 * thing is three steps, and they are in render().
 */

'use strict';

const $ = (sel) => document.querySelector(sel);

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};

const toneClass = (tone) => ({
  good: 'is-good', warn: 'is-warn', bad: 'is-bad', muted: 'is-muted',
}[tone] || 'is-muted');

const toneColor = (tone) => ({
  good: 'var(--good)', warn: 'var(--warn)', bad: 'var(--bad)', muted: 'var(--faint)',
}[tone] || 'var(--faint)');

/* Counts an element's text from one number to another over half a second,
   instead of snapping straight to the new value. Only used for the handful
   of headline numbers — the point is a dashboard that feels alive, not a
   page where every digit is constantly flickering. 'from' being null/undefined
   means there's nothing to count up from (first load, or the card didn't
   exist a moment ago), so it just shows the final value immediately.

   Deliberately setInterval, not requestAnimationFrame: rAF is tied to the
   browser's paint cycle and gets throttled hard the moment this window
   isn't the focused one — exactly the normal state for a dashboard sitting
   on a second monitor. setInterval keeps counting regardless. */
function animateNumber(target, from, to, decimals, suffix) {
  if (from === null || from === undefined || from === to) {
    target.textContent = to.toFixed(decimals) + suffix;
    return;
  }
  const duration = 500;
  const start = Date.now();
  const timer = setInterval(() => {
    const t = Math.min(1, (Date.now() - start) / duration);
    const eased = 1 - (1 - t) * (1 - t); // ease-out: fast start, settles in
    target.textContent = (from + (to - from) * eased).toFixed(decimals) + suffix;
    if (t >= 1) clearInterval(timer);
  }, 40);
}

/* A meter is a labelled value plus a segmented bar. Above 90% it goes red,
   above 75% amber — so a problem is visible from across the room rather than
   requiring you to read the number. */
function meter(label, value, pct, prev, decimals = 1, suffix = '%') {
  const wrap = el('div', 'meter');
  const head = el('div', 'meter-head');
  const valueEl = el('b');
  head.append(el('span', null, label), valueEl);
  animateNumber(valueEl, prev, value, decimals, suffix);

  const track = el('div', 'track');
  if (pct >= 90) track.classList.add('is-bad');
  else if (pct >= 75) track.classList.add('is-warn');
  const fill = el('i');
  fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  track.append(fill);

  wrap.append(head, track);
  return wrap;
}

/* Last 5 minutes of host CPU and load, remembered in the browser only —
   there's no history store yet, so this resets on reload. Real multi-day
   history is a Prometheus job for later; this is an honest preview of that
   idea using data the page is already polling anyway.

   The card itself is built once (ensureActivityCard) and updated in place
   on every poll, rather than torn down and rebuilt like the vitals cards —
   that's what makes a real CSS transition possible: you can't smoothly
   animate an element into existence, only change one that already exists. */
const HISTORY_MAX = 30; // 30 x 10s polls = 5 minutes
const hostHistory = [];
const ACTIVITY_W = 1000, ACTIVITY_H = 170;
const PLOT_TOP = 16, PLOT_H = 96; // mountains live in this band
const SCROLL_MS = 900;

const svgEl = (tag, attrs) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

/* Returns true if this push is retiring an old point — i.e. the moment that
   should scroll rather than just grow. hostHistory is left one point longer
   than HISTORY_MAX in that case, on purpose: the caller draws that wider
   window first (so the new point can slide in from off-screen) and trims it
   back down only after the slide finishes. */
function pushHistory(v) {
  const wasFull = hostHistory.length >= HISTORY_MAX;
  hostHistory.push({ cpu: v.cpu_pct, load: v.load_pct });
  return wasFull;
}

let activityEls = null;

function ensureActivityCard() {
  if (activityEls) return activityEls;

  const card = vitalCard('ACTIVITY', '5 MIN', 'muted');
  card.classList.add('vital-wide');

  // The SVG holds ONLY shapes — no text. Text inside a viewBox that gets
  // stretched to an arbitrary card width (preserveAspectRatio: none, since
  // the mountains themselves don't care about proportion) comes out visibly
  // warped, which is exactly what happened the first time. Labels are
  // ordinary HTML laid over the top instead, positioned by percentage, so
  // they stay normal, crisp text regardless of how the card is stretched.
  const wrap = el('div', 'host-graph-wrap');
  const svg = svgEl('svg', {
    viewBox: `0 0 ${ACTIVITY_W} ${ACTIVITY_H}`, class: 'host-graph', preserveAspectRatio: 'none',
  });

  const grid50 = svgEl('line', { class: 'graph-grid' });
  const grid100 = svgEl('line', { class: 'graph-grid' });

  // The part that actually slides. overflow:hidden on the wrap (see CSS)
  // crops whatever extends past the left/right edge while it's mid-slide.
  const scrollGroup = svgEl('g', { class: 'activity-scroll' });
  const fillLoad = svgEl('path', { fill: 'rgba(255, 163, 71, 0.10)' });
  const fillCpu = svgEl('path', { fill: 'rgba(255, 163, 71, 0.17)' });
  const strokeLoad = svgEl('path', { fill: 'none', stroke: 'rgba(255, 179, 71, 0.5)', 'stroke-width': '2' });
  const strokeCpu = svgEl('path', { fill: 'none', stroke: 'rgba(255, 179, 71, 0.85)', 'stroke-width': '2' });
  scrollGroup.append(fillLoad, fillCpu, strokeLoad, strokeCpu);
  svg.append(grid50, grid100, scrollGroup);

  const label50 = el('div', 'graph-axis-label graph-label-50');
  const label100 = el('div', 'graph-axis-label graph-label-100');

  // Readouts pinned to the right edge — not part of the scrolling group, so
  // they hold the old value steady through the slide and snap to the new
  // one exactly when the new point finishes arriving, not before.
  const readoutCpu = el('div', 'graph-readout');
  const readoutLoad = el('div', 'graph-readout graph-readout-dim');

  const timeStart = el('div', 'graph-axis-label graph-time-start', '-5 MIN');
  const timeEnd = el('div', 'graph-axis-label graph-time-end', 'NOW');

  const labels = el('div', 'host-graph-labels');
  labels.append(label50, label100, readoutCpu, readoutLoad, timeStart, timeEnd);

  wrap.append(svg, labels);
  card.append(wrap);
  card.append(el('div', 'vital-note', 'CPU (bright) over LOAD (dim) — resets on reload'));
  $('#activity-wrap').append(card);

  activityEls = {
    card, svg, grid50, grid100, label50, label100,
    scrollGroup, fillLoad, fillCpu, strokeLoad, strokeCpu,
    readoutCpu, readoutLoad,
  };
  return activityEls;
}

/* Builds the fill+stroke path data for one series over a set of points
   already spaced stepX apart, starting at startX. Point-to-point rather
   than stepped — real spikes and dips, deliberately different in character
   from the squared-off meters and tiles everywhere else on the page. */
function mountainPath(values, stepX, startX, maxY) {
  let fillD = `M ${startX} ${PLOT_TOP + PLOT_H}`;
  let strokeD = '';
  let lastY = null;
  values.forEach((val, i) => {
    const x = startX + i * stepX;
    const y = PLOT_TOP + PLOT_H - (val / maxY) * PLOT_H;
    fillD += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
    strokeD += (lastY === null ? 'M' : 'L') + ` ${x.toFixed(1)} ${y.toFixed(1)}`;
    lastY = y;
  });
  const lastX = startX + (values.length - 1) * stepX;
  fillD += ` L ${lastX} ${PLOT_TOP + PLOT_H} Z`;
  return { fillD, strokeD, lastY };
}

function drawGrid(maxY) {
  const { grid50, grid100, label50, label100 } = ensureActivityCard();
  [[grid50, label50, 0.5], [grid100, label100, 1]].forEach(([line, label, frac]) => {
    const y = PLOT_TOP + PLOT_H - PLOT_H * frac;
    line.setAttribute('x1', 0); line.setAttribute('x2', ACTIVITY_W);
    line.setAttribute('y1', y.toFixed(1)); line.setAttribute('y2', y.toFixed(1));
    label.style.top = (y / ACTIVITY_H * 100).toFixed(2) + '%';
    label.textContent = Math.round(maxY * frac) + '%';
  });
}

/* The actual draw step. wide=true draws HISTORY_MAX+1 points at their
   about-to-scroll positions (one step further right than normal) with no
   transition — a pure data update that looks identical to the steady state,
   since the extra point is clipped off-screen. Call triggerScroll() right
   after to animate it sliding into place. */
function drawActivity(history, maxY, wide) {
  const { fillLoad, fillCpu, strokeLoad, strokeCpu, readoutCpu, readoutLoad, scrollGroup } = ensureActivityCard();
  // Fixed spacing once the window is full (so a point slides by exactly one
  // step at a time) — but while it's still filling up for the first time,
  // stretch whatever points exist to fill the full width instead of drawing
  // a stub stuck to the left edge. The two formulas agree exactly the
  // moment history reaches HISTORY_MAX, so there's no seam between them.
  const stepX = wide ? ACTIVITY_W / (HISTORY_MAX - 1) : ACTIVITY_W / (history.length - 1);
  const startX = wide ? -stepX : 0;
  scrollGroup.style.transform = 'translateX(0px)';

  const load = mountainPath(history.map((p) => p.load), stepX, startX, maxY);
  const cpu = mountainPath(history.map((p) => p.cpu), stepX, startX, maxY);
  fillLoad.setAttribute('d', load.fillD);
  strokeLoad.setAttribute('d', load.strokeD);
  fillCpu.setAttribute('d', cpu.fillD);
  strokeCpu.setAttribute('d', cpu.strokeD);

  if (!wide) {
    const last = history[history.length - 1];
    readoutCpu.textContent = 'CPU ' + last.cpu.toFixed(1) + '%';
    readoutLoad.textContent = 'LOAD ' + last.load.toFixed(1) + '%';

    // Two independent lines can land on nearly the same value — push the
    // labels apart by a minimum gap so they never overlap into an unreadable
    // mess, regardless of how close the actual numbers are.
    let cpuPct = cpu.lastY / ACTIVITY_H * 100;
    let loadPct = load.lastY / ACTIVITY_H * 100;
    const minGap = 9;
    if (Math.abs(cpuPct - loadPct) < minGap) {
      const mid = (cpuPct + loadPct) / 2;
      if (cpuPct <= loadPct) { cpuPct = mid - minGap / 2; loadPct = mid + minGap / 2; }
      else { cpuPct = mid + minGap / 2; loadPct = mid - minGap / 2; }
    }
    readoutCpu.style.top = cpuPct.toFixed(2) + '%';
    readoutLoad.style.top = loadPct.toFixed(2) + '%';
  }
}

/* Deliberately setInterval, not a CSS transition: tested it directly and a
   CSS transition freezes in place the moment this window isn't focused,
   same failure as requestAnimationFrame earlier — just less obvious, since
   it's the browser's compositor doing it rather than application code.
   setInterval is the one thing proven to keep running regardless. */
function triggerScroll() {
  const { scrollGroup } = ensureActivityCard();
  const stepX = ACTIVITY_W / (HISTORY_MAX - 1);
  const start = Date.now();
  const timer = setInterval(() => {
    const t = Math.min(1, (Date.now() - start) / SCROLL_MS);
    scrollGroup.style.transform = `translateX(${(-stepX * t).toFixed(2)}px)`;
    if (t >= 1) clearInterval(timer);
  }, 40);
}

function renderActivity(v) {
  if (!v) return;
  const wasFull = pushHistory(v);
  ensureActivityCard();

  const allValues = hostHistory.flatMap((p) => [p.cpu, p.load]);
  const maxY = Math.max(20, ...allValues) * 1.15;
  drawGrid(maxY);

  if (hostHistory.length < 2) return;

  if (wasFull) {
    drawActivity(hostHistory, maxY, true);
    triggerScroll();
    setTimeout(() => {
      hostHistory.shift();
      drawActivity(hostHistory, maxY, false);
    }, SCROLL_MS + 40);
  } else {
    drawActivity(hostHistory, maxY, false);
  }
}

function vitalCard(title, rightText, rightTone) {
  const card = el('div', 'vital');
  const head = el('div', 'vital-head');
  const right = el('span', toneClass(rightTone), rightText);
  head.append(el('span', null, title), right);
  card.append(head);
  return card;
}

/* ------------------------------------------------------------------ */

let prevVitals = null;

function renderVitals(v, containers, runningCount, totalCount) {
  const rail = $('#vitals');
  rail.replaceChildren();
  if (!v) return;
  const prev = prevVitals;

  // HOST
  const host = vitalCard('HOST', v.cpu_pct >= 80 ? 'BUSY' : 'NOMINAL',
                         v.cpu_pct >= 80 ? 'warn' : 'good');
  host.append(
    meter('CPU', v.cpu_pct, v.cpu_pct, prev && prev.cpu_pct),
    meter('MEMORY', v.mem_pct, v.mem_pct, prev && prev.mem_pct),
    meter('LOAD', v.load1, v.load_pct, prev && prev.load1, 2, ''),
  );
  host.append(el('div', 'vital-note', `${v.cores} CORES · UP ${v.uptime_days} DAYS`));
  rail.append(host);

  // THIN POOL — the one that can take the whole lab down at once
  const tp = v.thin_pool;
  if (tp) {
    const pct = tp.pct;
    const tone = pct >= 80 ? 'bad' : pct >= 60 ? 'warn' : 'warn';
    const card = vitalCard('THIN POOL', pct >= 80 ? 'ACT NOW' : 'WATCH', tone);
    const row = el('div', 'ring-row');
    const ring = el('div', 'ring');
    ring.style.background =
      `conic-gradient(${pct >= 80 ? 'var(--bad)' : 'var(--amber)'} 0 ${pct}%, rgba(255,163,71,0.12) ${pct}% 100%)`;
    const core = el('div', 'ring-core');
    const pctEl = el('b');
    animateNumber(pctEl, prev && prev.thin_pool && prev.thin_pool.pct, pct, 1, '%');
    core.append(pctEl, el('span', null, 'USED'));
    ring.append(core);

    const facts = el('div', 'ring-facts');
    const line = (k, val, cls) => {
      const d = el('div');
      d.append(document.createTextNode(k + ' '));
      d.append(el('b', cls, val));
      return d;
    };
    facts.append(
      line('POOL', tp.total_gb + ' GB'),
      line('USED', tp.used ? (tp.used / 1e9).toFixed(1) + ' GB' : '0 GB'),
      line('ALERT AT', '80%'),
    );
    row.append(ring, facts);
    card.append(row);
    rail.append(card);
  }

  // STORAGE-VAULT. No fallback to a different pool on purpose: that used to
  // quietly paper over storage-vault going missing instead of saying so —
  // see the error banner for why, when this happens.
  const vault = v.vault;
  if (vault) {
    const card = vitalCard(vault.name.toUpperCase(), vault.pct >= 85 ? 'FULL' : 'OK',
                           vault.pct >= 85 ? 'bad' : 'good');
    const big = el('div', 'vital-big');
    const freeEl = el('span');
    animateNumber(freeEl, prev && prev.vault && prev.vault.free_gb, vault.free_gb, 0, '');
    big.append(freeEl);
    big.append(el('small', null, ' GB FREE'));
    card.append(big);
    card.append(el('div', 'vital-note',
      `${Math.round(vault.total_gb - vault.free_gb)} GB USED OF ${Math.round(vault.total_gb)} GB`));
    const track = el('div', 'track');
    if (vault.pct >= 85) track.classList.add('is-bad');
    else if (vault.pct >= 70) track.classList.add('is-warn');
    const fill = el('i');
    fill.style.width = vault.pct + '%';
    track.append(fill);
    card.append(track);
    rail.append(card);
  } else {
    const card = vitalCard('STORAGE-VAULT', 'MISSING', 'bad');
    card.append(el('div', 'vital-note', 'See the error banner above.'));
    rail.append(card);
  }

  // CONTAINERS
  const ct = vitalCard('CONTAINERS', `${runningCount} / ${totalCount}`,
                       runningCount === totalCount ? 'good' : 'warn');
  containers.forEach((c) => {
    const row = el('div', 'ct-row');
    const chip = el('span', 'chip');
    chip.style.background = c.running ? 'var(--good)' : 'var(--faint)';
    row.append(chip, el('span', 'ct-id', c.vmid), el('span', 'ct-name', c.name),
               el('span', 'ct-mem', c.running ? c.mem_pct + '%' : '—'));
    ct.append(row);
  });
  rail.append(ct);

  prevVitals = v;
}

function renderTile(s) {
  const node = s.href ? el('a', 'tile') : el('div', 'tile');
  if (s.href) { node.href = s.href; node.rel = 'noopener'; }
  node.dataset.search = `${s.name} ${s.desc} ${s.abbr}`.toLowerCase();

  const head = el('div', 'tile-head');
  head.append(el('span', 'tile-abbr', s.abbr));

  const id = el('span', 'tile-id');
  id.append(el('span', 'tile-name', s.name),
            el('span', 'tile-desc', s.note || s.desc));
  head.append(id);

  const state = el('span', 'tile-state');
  state.append(el('span', 'tile-status ' + toneClass(s.tone), s.status));
  if (s.ms !== null && s.ms !== undefined) {
    state.append(el('span', 'tile-ms', s.ms + 'ms'));
  }
  head.append(state);
  node.append(head);

  if (s.bars && s.bars.length) {
    const bars = el('div', 'tile-bars');
    s.bars.forEach((b) => {
      const wrap = el('span', 'bar');
      const bh = el('span', 'bar-head');
      bh.append(el('span', null, b.label), el('span', null, Math.round(b.pct) + '%'));
      const track = el('span', 'track');
      if (b.pct >= 90) track.classList.add('is-bad');
      else if (b.pct >= 75) track.classList.add('is-warn');
      const fill = el('i');
      fill.style.width = Math.max(0, Math.min(100, b.pct)) + '%';
      track.append(fill);
      wrap.append(bh, track);
      bars.append(wrap);
    });
    node.append(bars);
  }
  return node;
}

function renderGroups(groups) {
  const host = $('#groups');
  host.replaceChildren();
  groups.forEach((g) => {
    const section = el('div', 'group');
    const head = el('div', 'rule-head');
    head.append(el('span', 'rule-label', g.label), el('span', 'rule-line'),
                el('span', 'rule-meta', g.count));
    const tiles = el('div', 'tiles');
    g.items.forEach((s) => tiles.append(renderTile(s)));
    section.append(head, tiles);
    host.append(section);
  });
}

function renderWorkshop(w, v) {
  const top = $('#wk-top');
  top.replaceChildren();
  if (!w || !w.capacity) return;

  const cap = w.capacity;
  // A verdict, not just numbers. The thin pool is the binding constraint
  // here, not free disk — it is overcommitted and it fails all at once.
  let verdict = 'YES — with room', tone = 'is-good';
  if (cap.thin_pool_pct >= 80 || (cap.disk_free_gb !== null && cap.disk_free_gb < 20)) {
    verdict = 'NO — clear space first'; tone = 'is-bad';
  } else if (cap.thin_pool_pct >= 60) {
    verdict = 'YES — but watch the pool'; tone = 'is-warn';
  }

  const c1 = el('div', 'wk-card is-lead');
  c1.append(el('div', 'wk-title', 'CAN I FIT ANOTHER ONE?'));
  c1.append(el('div', 'wk-verdict ' + tone, verdict));
  const facts = el('div', 'wk-facts');
  const fact = (k, val, cls) => {
    const d = el('div');
    d.append(el('span', null, k), el('b', cls, val));
    return d;
  };
  facts.append(
    fact('DISK FREE', cap.disk_free_gb !== null ? Math.round(cap.disk_free_gb) + ' GB' : '—'),
    fact('MEMORY FREE', cap.mem_free_gib + ' GiB'),
    fact('THIN POOL', cap.thin_pool_pct !== null ? cap.thin_pool_pct + '%' : '—',
         cap.thin_pool_pct >= 80 ? 'is-bad' : cap.thin_pool_pct >= 60 ? 'is-warn' : null),
  );
  c1.append(facts);
  c1.append(el('div', 'wk-foot',
    'Containers promise more disk than the pool actually has. Fine until it is not — ' +
    'a full thin pool breaks every container on it at once.'));
  top.append(c1);

  const c2 = el('div', 'wk-card');
  c2.append(el('div', 'wk-title', 'NEXT FREE'));
  const row = el('div', 'next-row');
  const box = (val, label) => {
    const b = el('div', 'next-box');
    b.append(el('b', null, val), el('span', null, label));
    return b;
  };
  row.append(box(w.next_vmid !== null && w.next_vmid !== undefined ? w.next_vmid : '—', 'VMID'));
  row.append(box(w.next_ip || '—', 'LAN IP'));
  c2.append(row);
  c2.append(el('div', 'wk-foot',
    'VMID comes from Proxmox itself. The IP does not — check it before you trust it. ' +
    '.15 looked free once and was CT104.'));
  top.append(c2);

  const c3 = el('div', 'wk-card');
  c3.append(el('div', 'wk-title', 'OPEN THREADS'));
  (w.threads || []).forEach((t) => {
    const row2 = el('div', 'thread');
    const chip = el('span', 'chip');
    chip.style.background = toneColor(t.tone);
    row2.append(chip, el('span', null, t.text));
    c3.append(row2);
  });
  if (!(w.threads || []).length) {
    c3.append(el('div', 'wk-foot', 'Nothing open. Suspicious.'));
  }
  top.append(c3);

  // link rows
  const host = $('#wk-groups');
  host.replaceChildren();
  const linkGroup = (label, items) => {
    if (!items || !items.length) return;
    const section = el('div', 'group');
    const head = el('div', 'rule-head');
    head.append(el('span', 'rule-label', label), el('span', 'rule-line'),
                el('span', 'rule-meta', String(items.length).padStart(2, '0')));
    const grid = el('div', 'tiles');
    items.forEach((i) => {
      const a = el('a', 'link-card');
      a.href = i.href || '#';
      a.rel = 'noopener';
      a.append(el('b', null, i.name), el('span', null, i.desc || ''));
      grid.append(a);
    });
    section.append(head, grid);
    host.append(section);
  };
  linkGroup('BEFORE YOU BUILD', w.before_you_build);
  linkGroup('REFERENCE', w.reference);
}

function renderSummary(groups) {
  const counts = { good: 0, bad: 0, muted: 0 };
  groups.forEach((g) => g.items.forEach((s) => {
    if (s.tone === 'good') counts.good++;
    else if (s.tone === 'bad') counts.bad++;
    else counts.muted++;
  }));
  const host = $('#summary');
  host.replaceChildren();
  const part = (color, text) => {
    const s = el('span');
    const chip = el('span', 'chip');
    chip.style.background = color;
    s.append(chip, document.createTextNode(text));
    return s;
  };
  host.append(part('var(--good)', `${counts.good} UP`));
  host.append(part('var(--bad)', `${counts.bad} DOWN`));
  if (counts.muted) host.append(part('var(--faint)', `${counts.muted} UNCHECKED`));
}

function renderErrors(errors) {
  const b = $('#banner');
  if (!errors || !errors.length) { b.hidden = true; b.replaceChildren(); return; }
  b.replaceChildren();
  errors.forEach((e) => {
    const line = el('div');
    line.append(el('b', null, 'PROBLEM  '));
    line.append(document.createTextNode(e));
    b.append(line);
  });
  b.hidden = false;
}

/* ------------------------------------------------------------------ */

let pollTimer = null;

async function refresh() {
  try {
    const r = await fetch('api/state', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const s = await r.json();

    if (s.site) {
      $('#site-title').textContent = s.site.title;
      $('#site-sub').textContent = s.site.subtitle;
      document.title = s.site.title + ' — homelab control';
    }

    renderErrors(s.errors);
    renderVitals(s.vitals, s.containers || [], s.running_count || 0, s.total_count || 0);
    renderActivity(s.vitals);
    renderGroups(s.groups || []);
    renderSummary(s.groups || []);
    renderWorkshop(s.workshop, s.vitals);
    applyFilter();

    $('#vitals-age').textContent = 'LIVE · ' + new Date().toLocaleTimeString('en-GB', { hour12: false });
    $('#foot-right').textContent = 'NODE ' + (s.node || '?').toUpperCase();
    $('#foot-right').className = '';
  } catch (err) {
    // Keep whatever is on screen — stale numbers beat an empty page — but
    // say so, so nobody trusts a frozen dashboard.
    $('#foot-right').textContent = 'LOST CONTACT WITH THE SERVICE — ' + err.message;
    $('#foot-right').className = 'is-bad';
  }
}

function applyFilter() {
  const q = $('#filter').value.trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll('#groups .tile').forEach((t) => {
    const hit = !q || (t.dataset.search || '').includes(q);
    t.style.display = hit ? '' : 'none';
    if (hit) shown++;
  });
  document.querySelectorAll('#groups .group').forEach((g) => {
    const any = [...g.querySelectorAll('.tile')].some((t) => t.style.display !== 'none');
    g.style.display = any ? '' : 'none';
  });
  $('#no-match').hidden = !(q && shown === 0);
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $('#panel-lab').hidden = name !== 'lab';
  $('#panel-workshop').hidden = name !== 'workshop';
  location.hash = name;
}

function tick() {
  const now = new Date();
  $('#clock').textContent = now.toLocaleTimeString('en-GB', { hour12: false }).slice(0, 5);
  $('#date').textContent = now.toLocaleDateString('en-GB',
    { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
}

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => showTab(t.dataset.tab)));

$('#filter').addEventListener('input', applyFilter);

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('#filter')) {
    e.preventDefault();
    $('#filter').focus();
  }
  if (e.key === 'Escape' && document.activeElement === $('#filter')) {
    $('#filter').value = '';
    applyFilter();
    $('#filter').blur();
  }
});

showTab(location.hash === '#workshop' ? 'workshop' : 'lab');
tick();
setInterval(tick, 1000);
refresh();
pollTimer = setInterval(refresh, 10000);

// Stop hammering Proxmox for a tab nobody is looking at.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInterval(pollTimer);
  } else {
    refresh();
    pollTimer = setInterval(refresh, 10000);
  }
});
