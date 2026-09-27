// Power flows plant -> step-up substation -> transmission -> step-down substation -> primary distribution
//   -> distribution transformer -> secondary distribution -> customers.
const NODES = [
  {id:'plant1', x:-250, y:36, type:'plant',    label:'Plant 1', running:true},
  {id:'up1',    x:-90,  y:36, type:'stepup',   label:'Step-up 1'},
  {id:'sub',    x:400,  y:36, type:'stepdown', label:'Step-down 1'},
  {id:'jA',  x:400, y:130, type:'junction'},
  {id:'jB',  x:400, y:224, type:'junction'},
  {id:'jC',  x:400, y:318, type:'junction'},
  {id:'tA',  x:470, y:130, type:'transformer', label:'T1'},
  {id:'tB',  x:330, y:224, type:'transformer', label:'T2'},
  {id:'tC',  x:470, y:318, type:'transformer', label:'T3'},
  {id:'cA1', x:600, y:130, type:'customer', label:'A1'},
  {id:'cA2', x:740, y:130, type:'customer', label:'A2'},
  {id:'cB1', x:200, y:224, type:'customer', label:'B1'},
  {id:'cB2', x:70,  y:224, type:'customer', label:'B2'},
  {id:'cC1', x:600, y:318, type:'customer', label:'C1'},
  {id:'cC2', x:740, y:318, type:'customer', label:'C2'},
];

// kind is the voltage level: 'lead' (plant to step-up), 'transmission' (between substations),
// 'primary' (step-down to transformers), 'secondary' (transformer to customers)
const EDGES = [
  {id:'l1', from:'plant1', to:'up1', kind:'lead',         label:'Gen lead',       status:'normal'},
  {id:'x1', from:'up1',    to:'sub', kind:'transmission', label:'Transmission 1', status:'normal'},
  {id:'e0', from:'sub', to:'jA',  kind:'primary',   label:'Main 1',     status:'normal'},
  {id:'e1', from:'jA',  to:'jB',  kind:'primary',   label:'Main 2',     status:'normal'},
  {id:'e2', from:'jB',  to:'jC',  kind:'primary',   label:'Main 3',     status:'normal'},
  {id:'e3', from:'jA',  to:'tA',  kind:'primary',   label:'Lateral A',  status:'normal'},
  {id:'e4', from:'tA',  to:'cA1', kind:'secondary', label:'Service A1', status:'normal'},
  {id:'e5', from:'cA1', to:'cA2', kind:'secondary', label:'Service A2', status:'normal'},
  {id:'e6', from:'jB',  to:'tB',  kind:'primary',   label:'Lateral B',  status:'normal'},
  {id:'e7', from:'tB',  to:'cB1', kind:'secondary', label:'Service B1', status:'normal'},
  {id:'e8', from:'cB1', to:'cB2', kind:'secondary', label:'Service B2', status:'normal'},
  {id:'e9', from:'jC',  to:'tC',  kind:'primary',   label:'Lateral C',  status:'normal'},
  {id:'e10', from:'tC', to:'cC1', kind:'secondary', label:'Service C1', status:'normal'},
  {id:'e11', from:'cC1', to:'cC2', kind:'secondary', label:'Service C2', status:'normal'},
];

// normally-open switches linking two points of the network
const TIES = [
  {id:'t1', from:'cA2', to:'cC2', kind:'secondary', label:'Tie 1', status:'open'},
];

// voltage levels, highest first
const VOLTAGE = {transmission:'500 kV', primary:'35 kV', lead:'13 kV', secondary:'120 V'};
const LEVEL_ORDER = ['transmission', 'primary', 'lead', 'secondary'];

// voltage levels each kind of equipment connects at (transformers/substations bridge two levels)
const NODE_LEVELS = {
  plant:       ['lead'],
  stepup:      ['lead', 'transmission'],
  stepdown:    ['transmission', 'primary'],
  junction:    ['primary'],
  transformer: ['primary', 'secondary'],
  customer:    ['secondary'],
};
const TYPE_NAME = {plant:'power plant', stepup:'step-up substation', stepdown:'step-down substation',
                   junction:'junction', transformer:'distribution transformer', customer:'customer'};

// snapshot of the starting grid, restored by "Reset"
const INITIAL = JSON.stringify({NODES, EDGES, TIES});

const nodeById = {};
let customerIds = [];
let sourceIds = [];   // running power plants
let nextId = 1;       // suffix for ids of added nodes/edges/ties

// rebuild lookups after nodes are added or removed
function reindex(){
  for (const k in nodeById) delete nodeById[k];
  NODES.forEach(n => nodeById[n.id] = n);
  customerIds = NODES.filter(n => n.type === 'customer').map(n => n.id);
  sourceIds = NODES.filter(n => n.type === 'plant' && n.running).map(n => n.id);
}
reindex();

const isSubstation = n => n.type === 'stepup' || n.type === 'stepdown';

const levelsText = type => NODE_LEVELS[type].map(k => VOLTAGE[k]).join(' / ');

// which kind of line may join nodes a and b (the highest voltage they share), or why they can't be joined
function lineKind(a, b){
  const ta = nodeById[a].type, tb = nodeById[b].type;
  if (ta === 'plant' && tb === 'plant') return {error:'Connect each power plant to a step-up substation instead.'};
  const shared = LEVEL_ORDER.filter(k => NODE_LEVELS[ta].includes(k) && NODE_LEVELS[tb].includes(k));
  if (shared.length) return {kind: shared[0]};
  // suggest equipment that could sit between them
  const bridge = Object.keys(NODE_LEVELS).find(t =>
    NODE_LEVELS[t].some(k => NODE_LEVELS[ta].includes(k)) && NODE_LEVELS[t].some(k => NODE_LEVELS[tb].includes(k)));
  return {error:`A ${TYPE_NAME[ta]} (${levelsText(ta)}) can't connect directly to a ${TYPE_NAME[tb]} (${levelsText(tb)}).` +
                (bridge ? ` Put a ${TYPE_NAME[bridge]} between them.` : '')};
}

// parent of every node (ignores fault status and ties), rooted at plants where possible
function parentMap(){
  const adj = {};
  NODES.forEach(n => adj[n.id] = []);
  EDGES.forEach(e => { adj[e.from].push(e.to); adj[e.to].push(e.from); });
  const parent = {};
  const order = ['plant', 'stepup', 'stepdown', 'junction', 'transformer', 'customer'];
  const roots = order.flatMap(t => NODES.filter(n => n.type === t).map(n => n.id));
  roots.forEach(root => {
    if (root in parent) return;
    parent[root] = null;
    const queue = [root];
    while (queue.length){
      const cur = queue.shift();
      for (const next of adj[cur]) if (!(next in parent)){ parent[next] = cur; queue.push(next); }
    }
  });
  return parent;
}

// closest node that connects at the given voltage level (where new customers/transformers hang off)
function nearestAttachPoint(p, level){
  let best = null, bestD = Infinity;
  NODES.forEach(n => {
    if (!NODE_LEVELS[n.type].includes(level)) return;
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d < bestD){ best = n; bestD = d; }
  });
  return best;
}

// next free number for labels like "Plant 3"
function nextNum(prefix, labels){
  return Math.max(0, ...labels.filter(l => l && l.startsWith(prefix + ' ')).map(l => Number(l.slice(prefix.length + 1)) || 0)) + 1;
}
const allLabels = () => [...NODES, ...EDGES, ...TIES].map(o => o.label);

// next free customer label on the branch the parent belongs to, e.g. "A3", or "S2-1" directly off Step-down 2
function nextLabelFor(parentId){
  const parent = parentMap();
  let cur = parentId;
  while (cur && ['customer', 'transformer'].includes(nodeById[cur].type)) cur = parent[cur];
  const top = cur && nodeById[cur];
  const prefix = top && top.type === 'junction' ? cur.slice(1)
               : top && top.type === 'stepdown' ? 'S' + top.label.split(' ')[1] + '-'
               : 'N';
  let max = 0;
  NODES.forEach(n => {
    if (n.type !== 'customer' || !n.label.startsWith(prefix)) return;
    const num = Number(n.label.slice(prefix.length));
    if (Number.isInteger(num)) max = Math.max(max, num);
  });
  return prefix + (max + 1);
}

// how far from the edge of the buildable area each node type must stay
const MARGIN = {plant:25, stepup:25, stepdown:25};
function clampToBoard(p, margin = 15){
  return {x: Math.min(Math.max(p.x, BASE.x + margin), BASE.x + BASE.w - margin),
          y: Math.min(Math.max(p.y, BASE.y + margin), BASE.y + BASE.h - margin)};
}

// customers take 120 V service from the nearest transformer or customer
function addCustomer(p){
  const parent = nearestAttachPoint(p, 'secondary');
  if (!parent) return 'Add a distribution transformer first; customers are fed at 120 V.';
  const pos = clampToBoard(p);
  const label = nextLabelFor(parent.id);
  const id = 'c' + nextId++;
  NODES.push({id, x:pos.x, y:pos.y, type:'customer', label});
  EDGES.push({id:'e' + nextId++, from:parent.id, to:id, kind:'secondary', label:'Service ' + label, status:'normal'});
  reindex(); render();
  return null;
}

// transformers tap the 35 kV primary at the nearest step-down substation, junction or transformer
function addTransformer(p){
  const parent = nearestAttachPoint(p, 'primary');
  const pos = clampToBoard(p);
  const num = Math.max(0, ...NODES.filter(n => n.type === 'transformer').map(n => Number(n.label.slice(1)) || 0)) + 1;
  const id = 'x' + nextId++;
  NODES.push({id, x:pos.x, y:pos.y, type:'transformer', label:'T' + num});
  if (parent) EDGES.push({id:'e' + nextId++, from:parent.id, to:id, kind:'primary', label:'Tap T' + num, status:'normal'});
  reindex(); render();
}

// plants and substations are placed unconnected; wire them up with the Line tool
const PLACE_PREFIX = {plant:'Plant', stepup:'Step-up', stepdown:'Step-down'};
function addFacility(type, p){
  const pos = clampToBoard(p, MARGIN[type]);
  const label = PLACE_PREFIX[type] + ' ' + nextNum(PLACE_PREFIX[type], NODES.map(n => n.label));
  const node = {id:type[0] + nextId++, x:pos.x, y:pos.y, type, label};
  if (type === 'plant') node.running = true;
  NODES.push(node);
  reindex(); render();
}

function togglePlant(id){
  nodeById[id].running = !nodeById[id].running;
  reindex(); render();
}

function connected(a, b){
  const same = l => (l.from === a && l.to === b) || (l.from === b && l.to === a);
  return EDGES.some(same) || TIES.some(same);
}

// both return an error message, or null on success
function addLine(a, b){
  if (a === b) return 'Pick two different points.';
  if (connected(a, b)) return 'Those two points are already connected.';
  const {kind, error} = lineKind(a, b);
  if (error) return error;
  const prefix = {transmission:'Transmission', primary:'Primary', secondary:'Service'}[kind];
  const label = kind === 'lead' ? 'Gen lead' : prefix + ' ' + nextNum(prefix, allLabels());
  EDGES.push({id:'e' + nextId++, from:a, to:b, kind, label, status:'normal'});
  render();
  return null;
}

function addTie(a, b){
  if (a === b) return 'Pick two different points.';
  if (connected(a, b)) return 'Those two points are already connected.';
  const {kind, error} = lineKind(a, b);
  if (error) return error;
  if (kind === 'lead') return 'Tie switches go between substations or on the distribution network.';
  TIES.push({id:'t' + nextId++, from:a, to:b, kind, label:'Tie ' + nextNum('Tie', TIES.map(t => t.label)), status:'open'});
  render();
  return null;
}

function deleteTie(id){
  TIES.splice(TIES.findIndex(t => t.id === id), 1);
  render();
}

function deleteEdge(id){
  EDGES.splice(EDGES.findIndex(e => e.id === id), 1);
  render();
}

// Remove a customer, transformer, plant or substation.
// Customer: anything fed through it is re-attached to its parent so the service stays connected,
//   and ties on it move to the parent.
// Anything else: its lines and ties go with it; whatever it fed may be left without power
//   (e.g. a transformer's customers can't be re-attached to the 35 kV line above it).
function deleteNode(id){
  const node = nodeById[id];
  const parent = node.type === 'customer' ? parentMap()[id] : null;
  const incident = EDGES.filter(e => e.from === id || e.to === id);
  const removeEdge = e => EDGES.splice(EDGES.indexOf(e), 1);
  if (parent == null){
    incident.forEach(removeEdge);
  } else {
    const upEdge = incident.find(e => e.from === parent || e.to === parent);
    incident.filter(e => e !== upEdge).forEach(e => {
      const child = e.from === id ? e.to : e.from;
      if (connected(parent, child)){ removeEdge(e); return; }
      e.from = parent; e.to = child;
      if (upEdge.status === 'faulted') e.status = 'faulted';
    });
    removeEdge(upEdge);
  }
  NODES.splice(NODES.findIndex(n => n.id === id), 1);

  for (let i = TIES.length - 1; i >= 0; i--){
    const t = TIES[i];
    if (t.from !== id && t.to !== id) continue;
    if (parent != null){
      if (t.from === id) t.from = parent; else t.to = parent;
    }
    // drop ties with no endpoint left, or that would now loop back or duplicate a line
    const other = TIES.filter(o => o !== t);
    const dup = o => (o.from === t.from && o.to === t.to) || (o.from === t.to && o.to === t.from);
    if (parent == null || t.from === t.to || EDGES.some(dup) || other.some(dup)) TIES.splice(i, 1);
  }
  reindex(); render();
}

function buildAdjacency(includeTies){
  const adj = {};
  NODES.forEach(n => adj[n.id] = []);
  EDGES.forEach(e => {
    if (e.status === 'faulted') return;
    adj[e.from].push(e.to);
    adj[e.to].push(e.from);
  });
  if (includeTies) TIES.forEach(t => {
    if (t.status !== 'closed') return;
    adj[t.from].push(t.to);
    adj[t.to].push(t.from);
  });
  return adj;
}

function reachableFrom(roots, adj){
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length){
    const cur = queue.shift();
    for (const next of adj[cur]){
      if (!seen.has(next)){ seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

function computeCustomerStatus(){
  const normalReach = reachableFrom(sourceIds, buildAdjacency(false));
  const withTieReach = reachableFrom(sourceIds, buildAdjacency(true));
  const result = {};
  customerIds.forEach(id => {
    if (normalReach.has(id)) result[id] = 'powered';
    else if (withTieReach.has(id)) result[id] = 'restored';
    else result[id] = 'out';
  });
  return result;
}

// ---- load model ----
// every customer follows the same daily curve: 1 kW overnight, rising from 1am to a 4 kW peak at 6pm,
// then falling back to 1 kW by midnight (half-cosine ramps so it's smooth)
function customerLoadKw(hour){
  const h = ((hour % 24) + 24) % 24;
  if (h < 1) return 1;
  if (h <= 18) return 1 + 1.5 * (1 - Math.cos(Math.PI * (h - 1) / 17));
  return 1 + 1.5 * (1 + Math.cos(Math.PI * (h - 18) / 6));
}

// load of every customer at `hour` (0 if out of service), and how much each running plant must generate:
// each served customer's load is shared equally by the plants that can currently reach it
function servedLoads(hour, statusMap){
  const loads = {}, plantKw = {};
  let total = 0;
  const adj = buildAdjacency(true);
  const reach = sourceIds.map(p => ({p, set: reachableFrom([p], adj)}));
  sourceIds.forEach(p => plantKw[p] = 0);
  customerIds.forEach(id => {
    const kw = statusMap[id] === 'out' ? 0 : customerLoadKw(hour);
    loads[id] = kw;
    total += kw;
    const feeders = reach.filter(r => r.set.has(id));
    feeders.forEach(r => plantKw[r.p] += kw / feeders.length);
  });
  return {loads, plantKw, total};
}

// what the simulation (sim.js) wants drawn on the grid
const simView = {active:false, hour:0, selected:null};

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

  const count = type => NODES.filter(n => n.type === type).length;
  setText('statPlants', `${count('plant')} (${sourceIds.length} running)`);
  setText('statStepUp', count('stepup'));
  setText('statStepDown', count('stepdown'));
  setText('statXfmr', count('transformer'));
  setText('statTies', `${TIES.length} (${TIES.filter(t => t.status === 'closed').length} closed)`);

  // a line is energized if it isn't faulted and at least one end is fed from a running plant
  const fed = reachableFrom(sourceIds, buildAdjacency(true));
  const len = {lead:0, transmission:0, primary:0, secondary:0};
  let tie = 0, live = 0, fault = 0;
  EDGES.forEach(e => {
    const l = edgeLength(e);
    len[e.kind] += l;
    if (e.status === 'faulted') fault += l;
    else if (fed.has(e.from) || fed.has(e.to)) live += l;
  });
  TIES.forEach(t => {
    const l = edgeLength(t);
    tie += l;
    if (t.status === 'closed' && (fed.has(t.from) || fed.has(t.to))) live += l;
  });
  setText('statWireTotal', formatFt(len.lead + len.transmission + len.primary + len.secondary + tie));
  setText('statWireLead', formatFt(len.lead));
  setText('statWireTrans', formatFt(len.transmission));
  setText('statWirePrimary', formatFt(len.primary));
  setText('statWireSecondary', formatFt(len.secondary));
  setText('statWireTie', formatFt(tie));
  setText('statWireLive', formatFt(live));
  setText('statWireFault', formatFt(fault));
}

function midpoint(a, b){ return {x:(a.x+b.x)/2, y:(a.y+b.y)/2}; }

// stroke per voltage level: heavier lines for higher voltages
const LINE_STYLE = {
  transmission: {stroke:'var(--hv)', width:6},
  lead:         {stroke:'var(--hv)', width:4},
  primary:      {stroke:'var(--line)', width:4},
  secondary:    {stroke:'var(--lv)', width:2},
};

function render(){
  svg.innerHTML = '';

  // buildable area: faint dot grid with a dashed border
  const defs = el('defs', {});
  const dots = el('pattern', {id:'dots', width:40, height:40, patternUnits:'userSpaceOnUse'});
  dots.appendChild(el('circle', {cx:20, cy:20, r:1.2, fill:'#22304A'}));
  defs.appendChild(dots); svg.appendChild(defs);
  svg.appendChild(el('rect', {x:BASE.x, y:BASE.y, width:BASE.w, height:BASE.h, fill:'url(#dots)',
                              stroke:'#22304A', 'stroke-width':2, 'stroke-dasharray':'6,6'}));
  const statusMap = computeCustomerStatus();

  // lines
  EDGES.forEach(e => {
    const a = nodeById[e.from], b = nodeById[e.to];
    const style = LINE_STYLE[e.kind];
    const stroke = e.status === 'faulted' ? 'var(--fault)' : style.stroke;
    const hit = el('line', {x1:a.x,y1:a.y,x2:b.x,y2:b.y, class:'edge-hit line-hit', 'data-edge':e.id});
    hit.addEventListener('click', () => {
      e.status = e.status === 'faulted' ? 'normal' : 'faulted';
      render();
    });
    const line = el('line', {x1:a.x,y1:a.y,x2:b.x,y2:b.y, stroke, 'stroke-width':style.width, class:'edge'});
    const mid = midpoint(a,b);
    // name and voltage: stacked to the right of vertical lines, above/below other lines
    const vertical = a.x === b.x;
    const label = vertical
      ? el('text', {x:mid.x+10, y:mid.y-2, class:'edge-label'})
      : el('text', {x:mid.x, y:mid.y-10, 'text-anchor':'middle', class:'edge-label'});
    label.textContent = e.label;
    const volt = vertical
      ? el('text', {x:mid.x+10, y:mid.y+11, class:'volt-label'})
      : el('text', {x:mid.x, y:mid.y+17, 'text-anchor':'middle', class:'volt-label'});
    volt.textContent = VOLTAGE[e.kind];
    svg.appendChild(hit); svg.appendChild(line); svg.appendChild(label); svg.appendChild(volt);
  });

  // tie switches (dashed)
  TIES.forEach(t => {
    const a = nodeById[t.from], b = nodeById[t.to];
    const stroke = t.status === 'closed' ? 'var(--tie-closed)' : 'var(--tie-open)';
    const hit = el('line', {x1:a.x,y1:a.y,x2:b.x,y2:b.y, class:'edge-hit tie-hit', 'data-tie':t.id});
    hit.addEventListener('click', () => {
      t.status = t.status === 'closed' ? 'open' : 'closed';
      render();
    });
    const line = el('line', {x1:a.x,y1:a.y,x2:b.x,y2:b.y, stroke, 'stroke-width':3, 'stroke-dasharray':'7,6', class:'edge'});
    const mid = midpoint(a,b);
    // label extends toward the centre of the board so it never runs off either edge
    const right = mid.x > BASE.x + BASE.w/2;
    const label = el('text', {x: right ? mid.x-10 : mid.x+10, y:mid.y+4, 'text-anchor': right ? 'end' : 'start', class:'edge-label'});
    label.textContent = `${t.label} (${t.status}) · ${VOLTAGE[t.kind]}`;
    svg.appendChild(hit); svg.appendChild(line); svg.appendChild(label);
  });

  // live loads while a simulation is running or paused
  const live = simView.active ? servedLoads(simView.hour, statusMap) : null;
  if (simView.selected && !nodeById[simView.selected]) simView.selected = null;

  // nodes
  NODES.forEach(n => {
    if (n.type === 'plant'){
      // circle with a sine wave, the usual generator symbol; purple while running
      const color = n.running ? 'var(--gen)' : 'var(--out)';
      svg.appendChild(el('circle', {cx:n.x, cy:n.y, r:18, fill:'#1B2740', stroke:color, 'stroke-width':3,
                                    class:'plant', 'data-node':n.id}));
      svg.appendChild(el('path', {d:`M${n.x-10},${n.y} q5,-10 10,0 t10,0`, fill:'none', stroke:color, 'stroke-width':2.5, class:'glyph'}));
      const t = el('text', {x:n.x, y:n.y+36, 'text-anchor':'middle', class:'node-label strong'});
      t.textContent = !n.running ? `${n.label} (stopped)`
                    : live ? `${n.label} · ${live.plantKw[n.id].toFixed(1)} kW`
                    : `${n.label} (running)`;
      svg.appendChild(t);
    } else if (isSubstation(n)){
      svg.appendChild(el('rect', {x:n.x-22,y:n.y-16,width:44,height:32, rx:4, fill:'#1B2740', stroke:'var(--hv)', 'stroke-width':2,
                                  class:'substation', 'data-node':n.id}));
      // arrow shows which way the voltage is transformed
      const d = n.type === 'stepup'
        ? `M${n.x-7},${n.y+5} L${n.x},${n.y-6} L${n.x+7},${n.y+5} Z`
        : `M${n.x-7},${n.y-5} L${n.x},${n.y+6} L${n.x+7},${n.y-5} Z`;
      svg.appendChild(el('path', {d, fill:'var(--muted)', class:'glyph'}));
      const t = el('text', {x:n.x, y:n.y-24, 'text-anchor':'middle', class:'node-label strong'});
      t.textContent = n.label; svg.appendChild(t);
    } else if (n.type === 'transformer'){
      // two overlapping coils, the usual transformer symbol, with a larger invisible hit area on top
      svg.appendChild(el('circle', {cx:n.x-5, cy:n.y, r:8, fill:'#1B2740', stroke:'var(--hv)', 'stroke-width':2, class:'glyph'}));
      svg.appendChild(el('circle', {cx:n.x+5, cy:n.y, r:8, fill:'none', stroke:'var(--hv)', 'stroke-width':2, class:'glyph'}));
      svg.appendChild(el('circle', {cx:n.x, cy:n.y, r:15, fill:'transparent', class:'transformer', 'data-node':n.id}));
      const t = el('text', {x:n.x, y:n.y-18, 'text-anchor':'middle', class:'node-label'});
      t.textContent = n.label; svg.appendChild(t);
    } else if (n.type === 'junction'){
      svg.appendChild(el('circle', {cx:n.x, cy:n.y, r:6, fill:'#1B2740', stroke:'var(--line)', 'stroke-width':2,
                                    class:'junction', 'data-node':n.id}));
    } else {
      const status = statusMap[n.id];
      if (simView.selected === n.id)
        svg.appendChild(el('circle', {cx:n.x, cy:n.y, r:17, fill:'none', stroke:'var(--tie-closed)', 'stroke-width':2, class:'glyph'}));
      svg.appendChild(el('circle', {cx:n.x, cy:n.y, r:11, fill:colorFor(status), stroke:'#0B1220', 'stroke-width':2,
                                    class:'customer', 'data-node':n.id}));
      const t = el('text', {x:n.x, y:n.y+26, 'text-anchor':'middle', class:'node-label'});
      t.textContent = live ? `${n.label} · ${live.loads[n.id].toFixed(1)} kW` : n.label;
      svg.appendChild(t);
    }
  });

  // mode previews
  if (ghost && (mode === 'add' || mode === 'transformer')){
    const a = nearestAttachPoint(ghost, mode === 'add' ? 'secondary' : 'primary'), g = clampToBoard(ghost);
    if (a) svg.appendChild(el('line', {x1:a.x, y1:a.y, x2:g.x, y2:g.y, class:'ghost', stroke:'var(--muted)', 'stroke-width':2, 'stroke-dasharray':'4,4'}));
    if (mode === 'add') svg.appendChild(el('circle', {cx:g.x, cy:g.y, r:11, class:'ghost', fill:'var(--powered)', opacity:.35}));
    else [-5, 5].forEach(dx => svg.appendChild(el('circle', {cx:g.x+dx, cy:g.y, r:8, class:'ghost', fill:'none', stroke:'var(--hv)', 'stroke-width':2, opacity:.6})));
  }
  if (ghost && mode === 'plant'){
    const g = clampToBoard(ghost, MARGIN.plant);
    svg.appendChild(el('circle', {cx:g.x, cy:g.y, r:18, class:'ghost', fill:'#1B2740', stroke:'var(--gen)', 'stroke-width':3, opacity:.5}));
  }
  if (ghost && (mode === 'stepup' || mode === 'stepdown')){
    const g = clampToBoard(ghost, MARGIN[mode]);
    svg.appendChild(el('rect', {x:g.x-22, y:g.y-16, width:44, height:32, rx:4, class:'ghost', fill:'#1B2740', stroke:'var(--hv)', 'stroke-width':2, opacity:.6}));
  }
  if (pickStart){
    const s = nodeById[pickStart];
    svg.appendChild(el('circle', {cx:s.x, cy:s.y, r:24, class:'ghost', fill:'none', stroke:'var(--tie-closed)', 'stroke-width':2}));
    if (ghost){
      const attrs = mode === 'tie' ? {stroke:'var(--tie-open)', 'stroke-width':3, 'stroke-dasharray':'7,6'}
                                   : {stroke:'var(--muted)', 'stroke-width':3};
      svg.appendChild(el('line', {x1:s.x, y1:s.y, x2:ghost.x, y2:ghost.y, class:'ghost', ...attrs}));
    }
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

  if (typeof onGridRender === 'function') onGridRender();   // let sim.js refresh its readouts
}

// ---- zoom & pan (manipulates the SVG viewBox) ----
// starting view shows the whole initial grid; the buildable area is much larger
const HOME_VIEW = {x:-310, y:-75, w:1140, h:598.5};   // same 800:420 aspect as the SVG
const BASE = {x:-800, y:-420, w:2400, h:1260};
const MIN_ZOOM = 0.3, MAX_ZOOM = 5;   // relative to HOME_VIEW
let view = {...HOME_VIEW};

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
  const zoom = HOME_VIEW.w / view.w;
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
let dragNode = null;          // {node, dx, dy} while a node is being dragged
let pressed = {};             // {node, edge, tie} ids under the last press
const DRAG_THRESHOLD = 4;     // px of movement before a press becomes a pan

svg.addEventListener('pointerdown', ev => {
  ev.preventDefault();   // no text selection / native drag while moving things around
  pointers.set(ev.pointerId, {x:ev.clientX, y:ev.clientY, startX:ev.clientX, startY:ev.clientY});
  if (pointers.size === 1){
    dragged = false;
    const node = nodeById[ev.target.getAttribute('data-node')];
    pressed = {node: node ? node.id : null, edge: ev.target.getAttribute('data-edge'), tie: ev.target.getAttribute('data-tie')};
    const canDrag = node && node.type !== 'junction' && !['delete', 'line', 'tie'].includes(mode);
    if (canDrag){
      // grab offset so the node doesn't jump to centre on the cursor
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
  if (pointers.size === 0 && (PLACE_MODES.includes(mode) || pickStart)){
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
    // move the node (kept inside the diagram); render() redraws its wires and updates the stats
    dragged = true;
    const pt = toSvgPoint(ev.clientX, ev.clientY);
    const pos = clampToBoard({x: pt.x + dragNode.dx, y: pt.y + dragNode.dy}, MARGIN[dragNode.node.type]);
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

// a drag shouldn't also toggle whatever line it started on; in edit modes, clicks don't toggle lines
svg.addEventListener('click', ev => {
  if (dragged){ ev.stopPropagation(); dragged = false; return; }
  if (!mode){
    // plain click on a plant starts/stops it; on a customer, shows its load chart
    const node = pressed.node && nodeById[pressed.node];
    if (node && node.type === 'plant') togglePlant(node.id);
    else if (node && node.type === 'customer'){ simView.selected = node.id; render(); }
    return;
  }
  ev.stopPropagation();
  const pt = toSvgPoint(ev.clientX, ev.clientY);
  if (mode === 'add'){
    if (!pressed.node) showHint(addCustomer(pt));
  } else if (mode === 'transformer'){
    if (!pressed.node) addTransformer(pt);
  } else if (PLACE_MODES.includes(mode)){
    if (!pressed.node) addFacility(mode, pt);
  } else if (mode === 'line' || mode === 'tie'){
    if (!pressed.node){ pickStart = null; showHint(); render(); }
    else if (!pickStart){ pickStart = pressed.node; showHint(); render(); }
    else {
      const err = mode === 'line' ? addLine(pickStart, pressed.node) : addTie(pickStart, pressed.node);
      pickStart = null; showHint(err); render();
    }
  } else if (mode === 'delete'){
    if (pressed.node && nodeById[pressed.node].type !== 'junction') deleteNode(pressed.node);
    else if (pressed.tie) deleteTie(pressed.tie);
    else if (pressed.edge) deleteEdge(pressed.edge);
  }
}, true);

// ---- edit modes ----
let mode = null;        // null or a key of MODE_BUTTONS
let ghost = null;       // hover point for mode previews
let pickStart = null;   // first endpoint picked while adding a line or tie
const PLACE_MODES = ['add', 'transformer', 'plant', 'stepup', 'stepdown'];
const MODE_BUTTONS = {plant:'plantBtn', stepup:'stepUpBtn', stepdown:'stepDownBtn', transformer:'xfmrBtn', add:'addBtn',
                      line:'lineBtn', tie:'tieBtn', delete:'deleteBtn'};
const MODE_HINTS = {
  plant: 'Click to place a power plant, then use + Line to connect it to a step-up substation (13 kV). Press Esc to finish.',
  stepup: 'Click to place a step-up substation. Connect a plant to it, then run 500 kV transmission lines to step-down substations. Press Esc to finish.',
  stepdown: 'Click to place a step-down substation. Feed it with a 500 kV transmission line; it puts out 35 kV primary distribution. Press Esc to finish.',
  transformer: 'Click to place a distribution transformer. It taps the nearest 35 kV point and feeds customers at 120 V. Press Esc to finish.',
  add: 'Click to place a customer. It gets 120 V service from the nearest transformer or customer. Press Esc to finish.',
  line: 'Click the first end of the new line. Its voltage comes from what it connects: 13 kV gen lead, 500 kV transmission, 35 kV primary or 120 V secondary. Press Esc to finish.',
  line2: 'Now click the other end. Click empty space or press Esc to cancel.',
  tie: 'Click the first end of the new tie switch. Press Esc to finish.',
  tie2: 'Now click the other end. Click empty space or press Esc to cancel.',
  delete: 'Click a plant, substation, transformer, customer, line or tie switch to delete it. Customers fed through a deleted customer are re-attached upstream. Press Esc to finish.',
};

function showHint(extra){
  const hint = document.getElementById('modeHint');
  const key = pickStart ? mode + '2' : mode;
  hint.hidden = !mode;
  hint.textContent = mode ? (extra ? extra + ' ' : '') + MODE_HINTS[key] : '';
}

function setMode(next){
  mode = mode === next ? null : next;
  ghost = null; pickStart = null;
  for (const m in MODE_BUTTONS){
    document.getElementById(MODE_BUTTONS[m]).classList.toggle('active', mode === m);
    svg.classList.toggle('mode-' + m, mode === m);
  }
  svg.classList.toggle('mode-place', PLACE_MODES.includes(mode));
  svg.classList.toggle('mode-pick', mode === 'line' || mode === 'tie');
  showHint();
  render();
}

for (const m in MODE_BUTTONS) document.getElementById(MODE_BUTTONS[m]).addEventListener('click', () => setMode(m));
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape' || !mode) return;
  if (pickStart){ pickStart = null; ghost = null; showHint(); render(); }
  else setMode(mode);
});

document.getElementById('zoomIn').addEventListener('click', () => zoomAt(1.25, viewCenter()));
document.getElementById('zoomOut').addEventListener('click', () => zoomAt(0.8, viewCenter()));
document.getElementById('zoomFit').addEventListener('click', () => { view = {...BASE}; applyView(); });
document.getElementById('zoomReset').addEventListener('click', () => { view = {...HOME_VIEW}; applyView(); });

document.getElementById('resetBtn').addEventListener('click', () => {
  const init = JSON.parse(INITIAL);
  NODES.splice(0, NODES.length, ...init.NODES);
  EDGES.splice(0, EDGES.length, ...init.EDGES);
  TIES.splice(0, TIES.length, ...init.TIES);
  pickStart = null;
  reindex(); render();
});

applyView();
render();
