// ---- time simulation: runs the grid over a few days, logging generation, cost and per-customer load ----
// Relies on script.js (computeCustomerStatus, servedLoads, customerLoadKw, simView, render, nodeById).

const SIM_HOURS = 72;          // 3 days
const SAMPLE_H = 0.25;         // log every 15 simulated minutes
const PRICE_PER_KWH = 0.10;    // generation cost, $/kWh

const sim = {
  t: 0,               // simulated hours since start
  running: false,
  samples: [],        // {t, total, energy, cost, served, loads:{customerId: kW}}
  nextSample: 0,
  lastFrame: null,
};
let hoverT = null;    // simulated hour under the pointer on any chart (crosshair is synced across charts)

const $ = id => document.getElementById(id);

function speed(){ return Number($('simSpeed').value); }   // simulated hours per real second

function formatClock(t){
  const day = Math.min(Math.floor(t / 24) + 1, SIM_HOURS / 24);
  const mins = Math.round((t - Math.floor(t / 24) * 24) * 60);
  const hh = String(Math.floor(mins / 60) % 24).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  return {day: t >= SIM_HOURS ? SIM_HOURS / 24 : day, time: t >= SIM_HOURS ? '24:00' : `${hh}:${mm}`};
}
function clockText(t){ const c = formatClock(t); return `Day ${c.day} · ${c.time}`; }
const isNight = t => { const h = t % 24; return h < 6 || h >= 20; };

// log the grid's state at simulated hour t
function record(t){
  const statusMap = computeCustomerStatus();
  const {loads, total} = servedLoads(t, statusMap);
  const prev = sim.samples[sim.samples.length - 1];
  // energy over the interval since the last sample (trapezoid rule)
  const kwh = prev ? (prev.total + total) / 2 * (t - prev.t) : 0;
  const energy = (prev ? prev.energy : 0) + kwh;
  const served = Object.values(statusMap).filter(s => s !== 'out').length;
  sim.samples.push({t, total, energy, cost: energy * PRICE_PER_KWH, served, loads});
}

function frame(now){
  if (!sim.running) return;
  // capped so returning to a background tab doesn't jump the clock ahead
  const dt = sim.lastFrame == null ? 0 : Math.min((now - sim.lastFrame) / 1000, 0.25);
  sim.lastFrame = now;
  sim.t = Math.min(sim.t + dt * speed(), SIM_HOURS);
  let logged = false;
  while (sim.nextSample <= sim.t + 1e-9){
    record(sim.nextSample);
    sim.nextSample += SAMPLE_H;
    logged = true;
  }
  if (sim.t >= SIM_HOURS) sim.running = false;
  if (logged) syncGrid();
  updateControls();
  if (sim.running) requestAnimationFrame(frame);
}

// show the latest logged moment on the grid (labels with kW) and redraw everything
function syncGrid(){
  const last = sim.samples[sim.samples.length - 1];
  simView.active = !!last;
  simView.hour = last ? last.t : 0;
  render();   // calls onGridRender -> charts
}

function start(){
  if (sim.t >= SIM_HOURS) reset();
  if (!sim.samples.length){ record(0); sim.nextSample = SAMPLE_H; }
  sim.running = true;
  sim.lastFrame = null;
  syncGrid();
  requestAnimationFrame(frame);
}

function pause(){ sim.running = false; updateControls(); }

function reset(){
  sim.running = false;
  sim.t = 0; sim.samples = []; sim.nextSample = 0; sim.lastFrame = null;
  hoverT = null;
  syncGrid();
}

function updateControls(){
  const btn = $('simStartBtn');
  btn.textContent = sim.running ? 'Pause' : sim.t >= SIM_HOURS ? 'Restart simulation'
                  : sim.samples.length ? 'Resume' : 'Start simulation';
  btn.classList.toggle('active', sim.running);
  const c = formatClock(sim.t);
  $('simClock').textContent = sim.samples.length ? `Day ${c.day} · ${c.time}` : 'Not started';
  $('simPhase').textContent = !sim.samples.length ? '' : sim.t >= SIM_HOURS ? 'finished' : isNight(sim.t) ? '☾ night' : '☀ day';
}

// called by script.js at the end of every grid render (sim ticks, faults, edits, selection)
function onGridRender(){
  updateTiles();
  drawCharts();
  updateControls();
}

// ---- stat tiles ----
function updateTiles(){
  const last = sim.samples[sim.samples.length - 1];
  // "now" tiles follow the grid as it is (so edits while paused show up); totals come from the log
  const statusMap = computeCustomerStatus();
  const now = last ? servedLoads(simView.hour, statusMap) : null;
  const served = Object.values(statusMap).filter(s => s !== 'out').length;
  $('tileGen').textContent = now ? `${now.total.toFixed(1)} kW` : '–';
  $('tileEnergy').textContent = last ? `${last.energy.toFixed(1)} kWh` : '–';
  $('tileCost').textContent = last ? `$${last.cost.toFixed(2)}` : '–';
  $('tileServed').textContent = last ? `${served} / ${customerIds.length}` : '–';
  $('tileRate').textContent = `$${PRICE_PER_KWH.toFixed(2)}/kWh`;
}

// ---- charts (hand-built SVG: one y-axis each, 2px lines, recessive grid, synced crosshair) ----
const NS_SVG = 'http://www.w3.org/2000/svg';
const W = 360, H = 190, M = {l:46, r:12, t:12, b:26};
const PW = W - M.l - M.r, PH = H - M.t - M.b;
const xOf = t => M.l + t / SIM_HOURS * PW;
const tOf = x => (x - M.l) / PW * SIM_HOURS;

function svgEl(tag, attrs, text){
  const e = document.createElementNS(NS_SVG, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
}

// round the axis max up to 1, 2, 2.5 or 5 x 10^n so there are 4 tidy gridlines
function niceMax(v){
  if (v <= 0) return 1;
  const raw = v / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => s >= raw);
  return step * 4;
}

// series: [{name, color, dashed, points:[{t, v}]}]
function lineChart(svg, series, fmt){
  svg.innerHTML = '';
  const max = niceMax(Math.max(0, ...series.flatMap(s => s.points.map(p => p.v))) * 1.05);
  const yOf = v => M.t + PH - v / max * PH;

  // night shading (20:00-06:00) so the daily cycle is readable
  for (let d = 0; d < SIM_HOURS / 24; d++){
    [[d * 24, d * 24 + 6], [d * 24 + 20, Math.min(d * 24 + 30, SIM_HOURS)]].forEach(([a, b]) =>
      svg.appendChild(svgEl('rect', {x:xOf(a), y:M.t, width:xOf(b) - xOf(a), height:PH, class:'night'})));
  }
  // gridlines + y labels
  for (let i = 0; i <= 4; i++){
    const v = max / 4 * i, y = yOf(v);
    svg.appendChild(svgEl('line', {x1:M.l, x2:W - M.r, y1:y, y2:y, class: i ? 'grid' : 'axis'}));
    svg.appendChild(svgEl('text', {x:M.l - 6, y:y + 3, 'text-anchor':'end', class:'tick'}, fmt(v)));
  }
  // x labels: day starts and noons
  for (let t = 0; t <= SIM_HOURS; t += 12){
    const label = t === SIM_HOURS ? '' : t % 24 === 0 ? `Day ${t / 24 + 1}` : '12:00';
    svg.appendChild(svgEl('text', {x:xOf(t), y:H - 8, 'text-anchor': t === 0 ? 'start' : 'middle', class:'tick'}, label));
  }
  // lines
  series.forEach(s => {
    if (!s.points.length) return;
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.t).toFixed(1)},${yOf(p.v).toFixed(1)}`).join('');
    svg.appendChild(svgEl('path', {d, fill:'none', stroke:s.color, 'stroke-width':2, 'stroke-linejoin':'round',
                                   'stroke-dasharray': s.dashed ? '5,4' : 'none'}));
  });
  // crosshair + markers
  if (hoverT != null){
    svg.appendChild(svgEl('line', {x1:xOf(hoverT), x2:xOf(hoverT), y1:M.t, y2:M.t + PH, class:'crosshair'}));
    series.forEach(s => {
      const p = s.points.find(p => Math.abs(p.t - hoverT) < 1e-6);
      if (p) svg.appendChild(svgEl('circle', {cx:xOf(p.t), cy:yOf(p.v), r:4, fill:s.color, stroke:'var(--panel)', 'stroke-width':2}));
    });
  }
}

function customerSeries(id){
  const actual = {name:'Actual', color:'var(--series-1)', points:
    sim.samples.filter(s => id in s.loads).map(s => ({t:s.t, v:s.loads[id]}))};
  const typical = {name:'Typical', color:'var(--series-2)', dashed:true, points: []};
  for (let t = 0; t <= SIM_HOURS + 1e-9; t += SAMPLE_H) typical.points.push({t, v:customerLoadKw(t)});
  return [actual, typical];
}

const CHARTS = {
  gen:  {fmt: v => `${+v.toFixed(1)}`, series: () => [{name:'Generated', color:'var(--series-1)', unit:'kW',
          points: sim.samples.map(s => ({t:s.t, v:s.total}))}]},
  cost: {fmt: v => `$${v < 10 ? v.toFixed(2) : Math.round(v)}`, series: () => [{name:'Cost', color:'var(--series-1)', unit:'$',
          points: sim.samples.map(s => ({t:s.t, v:s.cost}))}]},
  cust: {fmt: v => `${+v.toFixed(1)}`, series: () => simView.selected ? customerSeries(simView.selected) : []},
};

function drawCharts(){
  for (const key in CHARTS) lineChart($('chart-' + key), CHARTS[key].series(), CHARTS[key].fmt);
  const sel = simView.selected && nodeById[simView.selected];
  $('custTitle').textContent = sel ? `Customer ${sel.label}: load (kW)` : 'Customer load (kW)';
  $('custEmpty').hidden = !!sel;
  $('custLegend').hidden = !sel;
  updateTable();
}

// tooltip for the chart being hovered; the other charts just show the synced crosshair
function showTooltip(key){
  const tip = $('tip-' + key);
  if (hoverT == null){ tip.hidden = true; return; }
  const rows = CHARTS[key].series().map(s => {
    const p = s.points.find(p => Math.abs(p.t - hoverT) < 1e-6);
    return p && {s, p};
  }).filter(Boolean);
  if (!rows.length){ tip.hidden = true; return; }
  tip.innerHTML = '';
  tip.appendChild(Object.assign(document.createElement('div'), {className:'tip-time', textContent: clockText(hoverT)}));
  rows.forEach(({s, p}) => {
    const row = document.createElement('div');
    row.className = 'tip-row';
    const swatch = document.createElement('i');
    swatch.className = 'tip-key' + (s.dashed ? ' dashed' : '');
    swatch.style.borderColor = s.color;
    const val = document.createElement('b');
    val.textContent = s.unit === '$' ? `$${p.v.toFixed(2)}` : `${p.v.toFixed(2)} kW`;
    const name = document.createElement('span');
    name.textContent = s.name;
    row.append(swatch, val, name);
    tip.appendChild(row);
  });
  tip.hidden = false;
  // keep the tooltip inside the chart: flip to the left of the crosshair past the midpoint
  const pct = xOf(hoverT) / W * 100;
  tip.style.left = pct < 55 ? `calc(${pct}% + 10px)` : '';
  tip.style.right = pct < 55 ? '' : `calc(${100 - pct}% + 10px)`;
}

for (const key in CHARTS){
  const svg = $('chart-' + key);
  svg.addEventListener('pointermove', ev => {
    const r = svg.getBoundingClientRect();
    const t = tOf((ev.clientX - r.left) / r.width * W);
    // snap to the logging grid; the typical-load line spans all 3 days, logged data only up to now
    const lastT = key === 'cust' ? SIM_HOURS : (sim.samples.length ? sim.samples[sim.samples.length - 1].t : 0);
    hoverT = Math.min(Math.max(Math.round(t / SAMPLE_H) * SAMPLE_H, 0), lastT);
    drawCharts();
    showTooltip(key);
  });
  svg.addEventListener('pointerleave', () => {
    hoverT = null;
    drawCharts();
    $('tip-' + key).hidden = true;
  });
}

// hourly table view of the same data (accessible alternative to the charts)
function updateTable(){
  if (!$('simTable').open) return;
  const sel = simView.selected && nodeById[simView.selected];
  $('tableCustHead').textContent = sel ? `${sel.label} (kW)` : 'Customer (kW)';
  const body = $('simTableBody');
  body.innerHTML = '';
  sim.samples.filter(s => Math.abs(s.t % 1) < 1e-9).forEach(s => {
    const tr = document.createElement('tr');
    [clockText(s.t), s.total.toFixed(2), s.energy.toFixed(2), `$${s.cost.toFixed(2)}`,
     sel && sel.id in s.loads ? s.loads[sel.id].toFixed(2) : '–'].forEach(v => {
      tr.appendChild(Object.assign(document.createElement('td'), {textContent: v}));
    });
    body.appendChild(tr);
  });
}

$('simTable').addEventListener('toggle', updateTable);
$('simStartBtn').addEventListener('click', () => sim.running ? pause() : start());
$('simResetBtn').addEventListener('click', reset);
document.getElementById('resetBtn').addEventListener('click', reset);   // resetting the grid also resets the simulation

onGridRender();
