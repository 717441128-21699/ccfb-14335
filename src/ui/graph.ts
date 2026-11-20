import type { Store } from './store.ts';
import { buildSceneAdjacency } from '../core/analyzer.ts';
import { condToString } from '../core/conditions.ts';
import type { CompiledScript } from '../core/types.ts';

const NODE_W = 168;
const NODE_H = 46;
const GAP_X = 70;
const GAP_Y = 26;

interface LaidNode {
  name: string;
  layer: number;
  x: number;
  y: number;
  kind: 'entry' | 'ending' | 'normal';
  dead: boolean;
}

export class GraphView {
  el: HTMLElement;
  private store: Store;
  private canvas!: HTMLElement;
  private onPlay: (scene: string) => void;

  constructor(store: Store, onPlay: (scene: string) => void) {
    this.store = store;
    this.onPlay = onPlay;
    this.el = document.createElement('div');
    this.el.className = 'view';
    this.el.id = 'view-graph';
    this.el.innerHTML = `
      <div class="graph-wrap">
        <div class="graph-toolbar">
          <button class="btn" data-act="reload">重新布局</button>
          <label class="badge info">节点数 <span data-role="nnodes">0</span></label>
          <label class="badge info">连线数 <span data-role="nedges">0</span></label>
          <span style="flex:1"></span>
          <span class="badge">点击节点可从该场景开始试玩</span>
        </div>
        <div class="graph-canvas" data-role="canvas"></div>
        <div class="legend">
          <span class="lg-entry">入口场景</span>
          <span class="lg-ending">结局场景</span>
          <span class="lg-dead">不可达/死路径</span>
          <span>普通场景</span>
        </div>
      </div>`;
    this.canvas = this.el.querySelector('[data-role=canvas]')!;
    this.el.querySelector('[data-act=reload]')!.addEventListener('click', () => this.onActivated());
  }

  onActivated() {
    const script = this.store.getScript();
    if (!script) {
      this.canvas.innerHTML = '<div class="empty-hint">剧本有编译错误，无法生成分支图</div>';
      return;
    }
    this.render(script);
  }

  private render(script: CompiledScript) {
    const adj = buildSceneAdjacency(script);
    const endingScenes = new Set(script.endings.map((e) => e.scene));

    // 1. BFS 分层
    const layerOf = new Map<string, number>();
    const queue = [script.entry];
    layerOf.set(script.entry, 0);
    while (queue.length) {
      const cur = queue.shift()!;
      const l = layerOf.get(cur)!;
      for (const e of adj.edges) {
        if (e.from === cur && !layerOf.has(e.to)) {
          layerOf.set(e.to, l + 1);
          queue.push(e.to);
        }
      }
    }
    // 不可达节点放最后一层
    let maxLayer = 0;
    for (const l of layerOf.values()) maxLayer = Math.max(maxLayer, l);
    for (const n of adj.nodes) {
      if (!layerOf.has(n)) layerOf.set(n, maxLayer + 1);
    }

    // 2. 每层按名字稳定排序后布局
    const layers = new Map<number, string[]>();
    for (const [name, l] of layerOf) {
      const arr = layers.get(l) ?? [];
      arr.push(name);
      layers.set(l, arr);
    }
    const laid = new Map<string, LaidNode>();
    let width = 0;
    let height = 0;
    for (const [l, names] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
      names.sort();
      const x = 40 + l * (NODE_W + GAP_X);
      names.forEach((name, idx) => {
        const y = 30 + idx * (NODE_H + GAP_Y);
        const kind =
          name === script.entry ? 'entry' : endingScenes.has(name) ? 'ending' : 'normal';
        // BFS 到达不了的节点被放到 maxLayer+1 层，标记为死节点
        const dead = l > maxLayer;
        laid.set(name, { name, layer: l, x, y, kind, dead });
      });
      height = Math.max(height, 30 + names.length * (NODE_H + GAP_Y));
      width = x + NODE_W;
    }
    width += 40;
    height += 40;

    // 3. 边的起止坐标
    const edgeSvg = adj.edges
      .map((e) => {
        const a = laid.get(e.from)!;
        const b = laid.get(e.to)!;
        const x1 = a.x + NODE_W;
        const y1 = a.y + NODE_H / 2;
        const x2 = b.x;
        const y2 = b.y + NODE_H / 2;
        const midX = (x1 + x2) / 2;
        const label = e.label ? truncate(e.label, 10) : e.cond ? '条件' : '';
        return `
          <path class="edge-line" d="M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}" />
          ${label ? `<text class="edge-label" x="${midX}" y="${(y1 + y2) / 2 - 3}" text-anchor="middle">${escapeHtml(label)}</text>` : ''}`;
      })
      .join('');

    const nodeSvg = [...laid.values()]
      .map((n) => {
        const cls = ['node-rect', n.kind, n.dead ? 'dead' : ''].join(' ');
        const sub = endingScenes.has(n.name)
          ? script.endings.find((e) => e.scene === n.name)?.name ?? ''
          : n.kind === 'entry'
            ? 'ENTRY'
            : '';
        return `
          <g data-node="${escapeHtml(n.name)}">
            <rect class="${cls}" x="${n.x}" y="${n.y}" width="${NODE_W}" height="${NODE_H}" rx="9" />
            <text class="node-text" x="${n.x + 10}" y="${n.y + (sub ? 20 : 28)}">${escapeHtml(
              truncate(n.name, 22),
            )}</text>
            ${sub ? `<text class="node-sub" x="${n.x + 10}" y="${n.y + 37}">${escapeHtml(truncate(sub, 22))}</text>` : ''}
          </g>`;
      })
      .join('');

    this.canvas.innerHTML = `
      <svg class="graph-svg" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#46536a" />
          </marker>
        </defs>
        ${edgeSvg}
        ${nodeSvg}
      </svg>`;

    this.el.querySelector('[data-role=nnodes]')!.textContent = String(adj.nodes.length);
    this.el.querySelector('[data-role=nedges]')!.textContent = String(adj.edges.length);

    this.canvas.querySelectorAll('[data-node]').forEach((g) => {
      g.addEventListener('click', () => {
        const name = (g as SVGGElement).dataset.node!;
        this.onPlay(name);
      });
      const node = laid.get((g as SVGGElement).dataset.node!)!;
      const scene = script.scenes[node.name];
      const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      titleEl.textContent = `${node.name}（第 ${scene?.line ?? '?'} 行定义）`;
      (g as SVGGElement).querySelector('rect')!.appendChild(titleEl);
    });
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 避免未使用告警（condToString 供后续条件边 tooltip 扩展）
void condToString;
