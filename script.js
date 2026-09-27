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

const nodeById = Object.fromEntries(NODES.map(n => [n.id, n]));
const customerIds = NODES.filter(n => n.type === 'customer').map(n => n.id);

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
    const label = el('text', {x:mid.x+8, y:mid.y-6, class:'edge-label'});
    label.textContent = e.label;
    svg.appendChild(hit); svg.appendChild(line); svg.appendChild(label);
  });

  // tie switch (dashed)
  {
    const a = nodeById[TIE.from], b = nodeById[TIE.to];
    const stroke = TIE.status === 'closed' ? 'var(--tie-closed)' : 'var(--tie-open)';
    const hit = el('line', {x1:a.x,y1:a.y,x2:b.x,y2:b.y, class:'edge-hit'});
    hit.addEventListener('click', () => {
      TIE.status = TIE.status === 'closed' ? 'open' : 'closed';
      render();
    });
    const line = el('line', {x1:a.x,y1:a.y,x2:b.x,y2:b.y, stroke, 'stroke-width':3, 'stroke-dasharray':'7,6', class:'edge'});
    const mid = midpoint(a,b);
    const label = el('text', {x:mid.x+8, y:mid.y, class:'edge-label'});
    label.textContent = TIE.label + ' (' + TIE.status + ')';
    svg.appendChild(hit); svg.appendChild(line); svg.appendChild(label);
  }

  // nodes
  NODES.forEach(n => {
    if (n.type === 'substation'){
      svg.appendChild(el('rect', {x:n.x-22,y:n.y-16,width:44,height:32, rx:4, fill:'#1B2740', stroke:'var(--line)', 'stroke-width':2}));
      const t = el('text', {x:n.x, y:n.y+45, 'text-anchor':'middle', class:'node-label strong'});
      t.textContent = n.label; svg.appendChild(t);
    } else if (n.type === 'junction'){
      svg.appendChild(el('circle', {cx:n.x, cy:n.y, r:6, fill:'#1B2740', stroke:'var(--line)', 'stroke-width':2}));
    } else {
      const status = statusMap[n.id];
      svg.appendChild(el('circle', {cx:n.x, cy:n.y, r:11, fill:colorFor(status), stroke:'#0B1220', 'stroke-width':2}));
      const t = el('text', {x:n.x, y:n.y+26, 'text-anchor':'middle', class:'node-label'});
      t.textContent = n.label; svg.appendChild(t);
    }
  });

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

document.getElementById('resetBtn').addEventListener('click', () => {
  EDGES.forEach(e => e.status = 'normal');
  TIE.status = 'open';
  render();
});

render();
