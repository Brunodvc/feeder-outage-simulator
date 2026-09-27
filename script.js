const NODES = [
  {id:'sub', x:400, y:36,  type:'substation', label:'Substation'},
  {id:'jA',  x:400, y:130, type:'junction'},
  {id:'jB',  x:400, y:224, type:'junction'},
  {id:'jC',  x:400, y:318, type:'junction'},
  {id:'cA1', x:560, y:130, type:'customer', label:'A1'},
  {id:'cA2', x:710, y:130, type:'customer', label:'A2'},
  {id:'cB1', x:240, y:224, type:'customer', label:'B1'},
  {id:'cB2', x:90,  y:224, type:'customer', label:'B2'},
  {id:'cC1', x:560, y:318, type:'customer', label:'C1'},
  {id:'cC2', x:710, y:318, type:'customer', label:'C2'},
];

const EDGES = [
  {id:'e0', from:'sub', to:'jA',  label:'Main 1',     status:'normal'},
  {id:'e1', from:'jA',  to:'jB',  label:'Main 2',     status:'normal'},
  {id:'e2', from:'jB',  to:'jC',  label:'Main 3',     status:'normal'},
  {id:'e3', from:'jA',  to:'cA1', label:'Lateral A1', status:'normal'},
  {id:'e4', from:'cA1', to:'cA2', label:'Lateral A2', status:'normal'},
  {id:'e5', from:'jB',  to:'cB1', label:'Lateral B1', status:'normal'},
  {id:'e6', from:'cB1', to:'cB2', label:'Lateral B2', status:'normal'},
  {id:'e7', from:'jC',  to:'cC1', label:'Lateral C1', status:'normal'},
  {id:'e8', from:'cC1', to:'cC2', label:'Lateral C2', status:'normal'},
];

const TIE = {id:'tie', from:'cA2', to:'cC2', label:'Tie switch', status:'open'};

// snapshot of the starting feeder, restored by "Reset feeder"
const INITIAL = JSON.stringify({NODES, EDGES, TIE});

const nodeById = {};
let customerIds = [];
let nextId = 1;   // suffix for ids of added customers/edges

// rebuild lookups after nodes are added or removed
function reindex(){
  for (const k in nodeById) delete nodeById[k];
  NODES.forEach(n => nodeById[n.id] = n);
  customerIds = NODES.filter(n => n.type === 'customer').map(n => n.id);
}
reindex();

// parent of every node in the radial tree (ignores fault status and the tie)
function parentMap(){
  const adj = {};
  NODES.forEach(n => adj[n.id] = []);
  EDGES.forEach(e => { adj[e.from].push(e.to); adj[e.to].push(e.from); });
  const parent = {sub:null}, queue = ['sub'];
  while (queue.length){
    const cur = queue.shift();
    for (const next of adj[cur]) if (!(next in parent)){ parent[next] = cur; queue.push(next); }
  }
  return parent;
}

// junction or customer closest to point p (new customers hang off it as a leaf)
function nearestAttachPoint(p){
  let best = null, bestD = Infinity;
  NODES.forEach(n => {
    if (n.type === 'substation') return;
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d < bestD){ best = n; bestD = d; }
  });
  return best;
}

// next free label on the branch the parent belongs to, e.g. "A3"
function nextLabelFor(parentId){
  const parent = parentMap();
  let cur = parentId;
  while (cur && nodeById[cur].type !== 'junction') cur = parent[cur];
  const letter = cur ? cur.slice(1) : 'N';
  let max = 0;
  NODES.forEach(n => {
    if (n.type !== 'customer' || !n.label.startsWith(letter)) return;
    const num = Number(n.label.slice(letter.length));
    if (Number.isInteger(num)) max = Math.max(max, num);
  });
  return letter + (max + 1);
}

function clampToBoard(p){
  const M = 15;
  return {x: Math.min(Math.max(p.x, BASE.x + M), BASE.x + BASE.w - M),
          y: Math.min(Math.max(p.y, BASE.y + M), BASE.y + BASE.h - M)};
}

function addCustomer(p){
  const parent = nearestAttachPoint(p);
  const pos = clampToBoard(p);
  const label = nextLabelFor(parent.id);
  const id = 'cN' + nextId++;
  NODES.push({id, x:pos.x, y:pos.y, type:'customer', label});
  EDGES.push({id:'eN' + nextId++, from:parent.id, to:id, label:'Lateral ' + label, status:'normal'});
  reindex(); render();
}

// remove a customer; anything fed through it is re-attached to its parent so the feeder stays connected
function deleteCustomer(id){
  const parent = parentMap()[id];
  const upEdge = EDGES.find(e => (e.from === id && e.to === parent) || (e.to === id && e.from === parent));
  EDGES.filter(e => e !== upEdge && (e.from === id || e.to === id)).forEach(e => {
    const child = e.from === id ? e.to : e.from;
    e.from = parent; e.to = child;
    if (upEdge && upEdge.status === 'faulted') e.status = 'faulted';
  });
  if (upEdge) EDGES.splice(EDGES.indexOf(upEdge), 1);
  NODES.splice(NODES.findIndex(n => n.id === id), 1);
  if (TIE.from === id) TIE.from = parent;
  if (TIE.to === id) TIE.to = parent;
  reindex(); render();
}

function buildAdjacency(includeTie){
  const adj = {};
  NODES.forEach(n => adj[n.id] = []);
  EDGES.forEach(e => {
    if (e.status === 'faulted') return;
    adj[e.from].push(e.to);
    adj[e.to].push(e.from);
  });
  if (includeTie && TIE.status === 'closed'){
    adj[TIE.from].push(TIE.to);
    adj[TIE.to].push(TIE.from);
  }
  return adj;
}

function reachableFrom(root, adj){
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length){
    const cur = queue.shift();
    for (const next of adj[cur]){
      if (!seen.has(next)){ seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

function computeCustomerStatus(){
  const normalReach = reachableFrom('sub', buildAdjacency(false));
  const withTieReach = reachableFrom('sub', buildAdjacency(true));
  const result = {};
  customerIds.forEach(id => {
    if (normalReach.has(id)) result[id] = 'powered';
    else if (withTieReach.has(id)) result[id] = 'restored';
    else result[id] = 'out';
  });
  return result;
}

function colorFor(status){
  return status === 'powered' ? 'var(--powered)'
       : status === 'restored' ? 'var(--restored)'
       : 'var(--out)';
}

const svg = document.getElementById('svg');
const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs){
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

const FT_PER_UNIT = 10;   // drawing scale for wire lengths

function edgeLength(e){
  const a = nodeById[e.from], b = nodeById[e.to];
  return Math.hypot(b.x - a.x, b.y - a.y) * FT_PER_UNIT;
}

function formatFt(ft){
  return ft >= 5280 ? `${(ft / 5280).toFixed(2)} mi` : `${Math.round(ft).toLocaleString()} ft`;
}

function setText(id, text){ document.getElementById(id).textContent = text; }

// customers whose node falls inside the current zoom/pan viewport
function updateInViewCount(){
  const n = customerIds.filter(id => {
    const c = nodeById[id];
    return c.x >= view.x && c.x <= view.x + view.w && c.y >= view.y && c.y <= view.y + view.h;
  }).length;
  setText('statCustView', n);
}

function updateStats(statusMap){
  const counts = {powered:0, restored:0, out:0};
  customerIds.forEach(id => counts[statusMap[id]]++);
  setText('statCustTotal', customerIds.length);
  setText('statCustPowered', counts.powered);
  setText('statCustRestored', counts.restored);
  setText('statCustOut', counts.out);
  updateInViewCount();

  // a segment is energized if it isn't faulted and at least one end is fed from the substation
  const fed = reachableFrom('sub', buildAdjacency(true));
  let main = 0, lateral = 0, live = 0, fault = 0;
  EDGES.forEach(e => {
    const len = edgeLength(e);
    if (e.label.startsWith('Main')) main += len; else lateral += len;
    if (e.status === 'faulted') fault += len;
    else if (fed.has(e.from) || fed.has(e.to)) live += len;
  });
  const tie = edgeLength(TIE);
  if (TIE.status === 'closed' && (fed.has(TIE.from) || fed.has(TIE.to))) live += tie;
  setText('statWireTotal', formatFt(main + lateral + tie));
  setText('statWireMain', formatFt(main));
  setText('statWireLateral', formatFt(lateral));
  setText('statWireTie', formatFt(tie));
  setText('statWireLive', formatFt(live));
  setText('statWireFault', formatFt(fault));
}

function midpoint(a, b){ return {x:(a.x+b.x)/2, y:(a.y+b.y)/2}; }

function render(){
  svg.innerHTML = '';
  const statusMap = computeCustomerStatus();

  // main + lateral edges
  EDGES.forEach(e => {
    const a = nodeById[e.from], b = nodeById[e.to];
    const stroke = e.status === 'faulted' ? 'var(--fault)' : 'var(--line)';
    const hit = el('line', {x1:a.x,y1:a.y,x2:b.x,y2:b.y, class:'edge-hit'});
    hit.addEventListener('click', () => {
      e.status = e.status === 'faulted' ? 'normal' : 'faulted';
      render();
    });
    const line = el('line', {x1:a.x,y1:a.y,x2:b.x,y2:b.y, stroke, 'stroke-width':4, class:'edge'});
    const mid = midpoint(a,b);
    // vertical edges: label to the right; horizontal edges: centered above the line
    const vertical = a.x === b.x;
    const label = vertical
      ? el('text', {x:mid.x+10, y:mid.y+4, class:'edge-label'})
      : el('text', {x:mid.x, y:mid.y-10, 'text-anchor':'middle', class:'edge-label'});
    label.textContent = e.label;
    svg.appendChild(hit); svg.appendChild(line); svg.appendChild(label);
  });

  // tie switch (dashed); skipped if deletions collapsed both ends onto one node
  if (TIE.from !== TIE.to){
    const a = nodeById[TIE.from], b = nodeById[TIE.to];
    const stroke = TIE.status === 'closed' ? 'var(--tie-closed)' : 'var(--tie-open)';
    const hit = el('line', {x1:a.x,y1:a.y,x2:b.x,y2:b.y, class:'edge-hit'});
    hit.addEventListener('click', () => {
      TIE.status = TIE.status === 'closed' ? 'open' : 'closed';
      render();
    });
    const line = el('line', {x1:a.x,y1:a.y,x2:b.x,y2:b.y, stroke, 'stroke-width':3, 'stroke-dasharray':'7,6', class:'edge'});
    const mid = midpoint(a,b);
    // anchor to the left of the line so the label never runs off the right edge
    const label = el('text', {x:mid.x-10, y:mid.y+4, 'text-anchor':'end', class:'edge-label'});
    label.textContent = TIE.label + ' (' + TIE.status + ')';
    svg.appendChild(hit); svg.appendChild(line); svg.appendChild(label);
  }

  // nodes
  NODES.forEach(n => {
    if (n.type === 'substation'){
      svg.appendChild(el('rect', {x:n.x-22,y:n.y-16,width:44,height:32, rx:4, fill:'#1B2740', stroke:'var(--line)', 'stroke-width':2}));
      const t = el('text', {x:n.x+32, y:n.y+4, class:'node-label strong'});
      t.textContent = n.label; svg.appendChild(t);
    } else if (n.type === 'junction'){
      svg.appendChild(el('circle', {cx:n.x, cy:n.y, r:6, fill:'#1B2740', stroke:'var(--line)', 'stroke-width':2}));
    } else {
      const status = statusMap[n.id];
      svg.appendChild(el('circle', {cx:n.x, cy:n.y, r:11, fill:colorFor(status), stroke:'#0B1220', 'stroke-width':2,
                                    class:'customer', 'data-node':n.id}));
      const t = el('text', {x:n.x, y:n.y+26, 'text-anchor':'middle', class:'node-label'});
      t.textContent = n.label; svg.appendChild(t);
    }
  });

  // add-mode preview: where the new customer would go and what it would connect to
  if (mode === 'add' && ghost){
    const a = nearestAttachPoint(ghost), g = clampToBoard(ghost);
    svg.appendChild(el('line', {x1:a.x, y1:a.y, x2:g.x, y2:g.y, class:'ghost', stroke:'var(--muted)', 'stroke-width':2, 'stroke-dasharray':'4,4'}));
    svg.appendChild(el('circle', {cx:g.x, cy:g.y, r:11, class:'ghost', fill:'var(--powered)', opacity:.35}));
  }

  updateStats(statusMap);

  // status bar
  const counts = {powered:0, restored:0, out:0};
  customerIds.forEach(id => counts[statusMap[id]]++);
  const box = document.getElementById('statusBox');
  const outTotal = counts.out;
  if (outTotal === 0){
    box.className = 'status ok';
    box.textContent = counts.restored > 0
      ? `All customers served (${counts.restored} via backup tie)`
      : `${customerIds.length} of ${customerIds.length} customers powered`;
  } else {
    box.className = 'status';
    box.innerHTML = `<b>${outTotal}</b> of ${customerIds.length} customers out of service`;
  }
}

// ---- zoom & pan (manipulates the SVG viewBox) ----
const BASE = {x:0, y:0, w:800, h:420};
const MIN_ZOOM = 0.5, MAX_ZOOM = 5;
let view = {...BASE};

function applyView(){
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  updateInViewCount();
}

// keep the view centre within the diagram so it can't be panned away entirely
function clampView(){
  const cx = Math.min(Math.max(view.x + view.w/2, BASE.x), BASE.x + BASE.w);
  const cy = Math.min(Math.max(view.y + view.h/2, BASE.y), BASE.y + BASE.h);
  view.x = cx - view.w/2;
  view.y = cy - view.h/2;
}

// convert a client (screen) point to SVG user coordinates
function toSvgPoint(clientX, clientY){
  const r = svg.getBoundingClientRect();
  return {x: view.x + (clientX - r.left) / r.width * view.w,
          y: view.y + (clientY - r.top) / r.height * view.h};
}

// zoom by `factor` (>1 zooms in) keeping the SVG point `p` fixed on screen
function zoomAt(factor, p){
  const zoom = BASE.w / view.w;
  const next = Math.min(Math.max(zoom * factor, MIN_ZOOM), MAX_ZOOM);
  const k = zoom / next;
  view.x = p.x - (p.x - view.x) * k;
  view.y = p.y - (p.y - view.y) * k;
  view.w *= k; view.h *= k;
  clampView(); applyView();
}

function viewCenter(){ return {x: view.x + view.w/2, y: view.y + view.h/2}; }

svg.addEventListener('wheel', ev => {
  ev.preventDefault();
  zoomAt(Math.exp(-ev.deltaY * 0.0015), toSvgPoint(ev.clientX, ev.clientY));
}, {passive:false});

const pointers = new Map();   // pointerId -> {x, y} (client coords)
let dragged = false, pinchDist = 0;
let dragNode = null;          // {node, dx, dy} while a customer is being dragged
let pressedNode = null;       // customer id under the last press, if any
const DRAG_THRESHOLD = 4;     // px of movement before a press becomes a pan

svg.addEventListener('pointerdown', ev => {
  pointers.set(ev.pointerId, {x:ev.clientX, y:ev.clientY, startX:ev.clientX, startY:ev.clientY});
  if (pointers.size === 1){
    dragged = false;
    const node = nodeById[ev.target.getAttribute('data-node')];
    pressedNode = node ? node.id : null;
    if (node && mode !== 'delete'){
      // grab offset so the customer doesn't jump to centre on the cursor
      const pt = toSvgPoint(ev.clientX, ev.clientY);
      dragNode = {node, dx: node.x - pt.x, dy: node.y - pt.y};
      svg.setPointerCapture(ev.pointerId);
      svg.classList.add('moving');
    }
  }
  if (pointers.size === 2){
    dragNode = null;
    svg.classList.remove('moving');
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
  }
});

svg.addEventListener('pointermove', ev => {
  if (pointers.size === 0 && mode === 'add'){
    ghost = toSvgPoint(ev.clientX, ev.clientY);
    render();
    return;
  }
  const p = pointers.get(ev.pointerId);
  if (!p) return;
  if (pointers.size === 2){
    p.x = ev.clientX; p.y = ev.clientY;
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0) zoomAt(dist / pinchDist, toSvgPoint((a.x + b.x)/2, (a.y + b.y)/2));
    pinchDist = dist; dragged = true;
    return;
  }
  if (!dragged && Math.hypot(ev.clientX - p.startX, ev.clientY - p.startY) < DRAG_THRESHOLD) return;
  if (dragNode){
    // move the customer (kept inside the diagram); render() redraws its wires and updates the stats
    dragged = true;
    const pt = toSvgPoint(ev.clientX, ev.clientY);
    const pos = clampToBoard({x: pt.x + dragNode.dx, y: pt.y + dragNode.dy});
    dragNode.node.x = pos.x; dragNode.node.y = pos.y;
    render();
    return;
  }
  if (!dragged){
    dragged = true;
    svg.setPointerCapture(ev.pointerId);
    svg.classList.add('panning');
  }
  const r = svg.getBoundingClientRect();
  view.x -= (ev.clientX - p.x) / r.width * view.w;
  view.y -= (ev.clientY - p.y) / r.height * view.h;
  p.x = ev.clientX; p.y = ev.clientY;
  clampView(); applyView();
});

function endPointer(ev){
  pointers.delete(ev.pointerId);
  pinchDist = 0;
  if (pointers.size === 0){
    dragNode = null;
    svg.classList.remove('panning', 'moving');
  }
}
svg.addEventListener('pointerup', endPointer);
svg.addEventListener('pointercancel', endPointer);

svg.addEventListener('pointerleave', () => {
  if (ghost){ ghost = null; render(); }
});

// a drag shouldn't also toggle whatever line it started on; in add/delete mode, clicks don't toggle lines
svg.addEventListener('click', ev => {
  if (dragged){ ev.stopPropagation(); dragged = false; return; }
  if (mode === 'add'){
    ev.stopPropagation();
    if (!pressedNode) addCustomer(toSvgPoint(ev.clientX, ev.clientY));
  } else if (mode === 'delete'){
    ev.stopPropagation();
    if (pressedNode) deleteCustomer(pressedNode);
  }
}, true);

// ---- add / delete customer modes ----
let mode = null;     // null | 'add' | 'delete'
let ghost = null;    // hover point for the add-mode preview
const MODE_HINTS = {
  add: 'Click on the diagram to place a customer. It connects to the nearest junction or customer. Press Esc to finish.',
  delete: 'Click a customer to delete it. Customers fed through it are re-attached upstream. Press Esc to finish.',
};

function setMode(next){
  mode = mode === next ? null : next;
  ghost = null;
  document.getElementById('addBtn').classList.toggle('active', mode === 'add');
  document.getElementById('deleteBtn').classList.toggle('active', mode === 'delete');
  svg.classList.toggle('mode-add', mode === 'add');
  svg.classList.toggle('mode-delete', mode === 'delete');
  const hint = document.getElementById('modeHint');
  hint.hidden = !mode;
  hint.textContent = mode ? MODE_HINTS[mode] : '';
  render();
}

document.getElementById('addBtn').addEventListener('click', () => setMode('add'));
document.getElementById('deleteBtn').addEventListener('click', () => setMode('delete'));
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && mode) setMode(mode); });

document.getElementById('zoomIn').addEventListener('click', () => zoomAt(1.25, viewCenter()));
document.getElementById('zoomOut').addEventListener('click', () => zoomAt(0.8, viewCenter()));
document.getElementById('zoomReset').addEventListener('click', () => { view = {...BASE}; applyView(); });

document.getElementById('resetBtn').addEventListener('click', () => {
  const init = JSON.parse(INITIAL);
  NODES.splice(0, NODES.length, ...init.NODES);
  EDGES.splice(0, EDGES.length, ...init.EDGES);
  Object.assign(TIE, init.TIE);
  reindex(); render();
});

render();
