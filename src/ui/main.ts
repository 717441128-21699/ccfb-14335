import './styles.css';
import sampleSource from '../../scripts/sample.vns?raw';
import { Store, type TabId } from './store.ts';
import { EditorView } from './editor.ts';
import { ReportView } from './report.ts';
import { GraphView } from './graph.ts';
import { PlayerView } from './player.ts';

const store = new Store(sampleSource);

const editor = new EditorView(store);
const report = new ReportView(store);
const player = new PlayerView(store);
const graph = new GraphView(store, (scene) => {
  // 从分支图节点跳转到试玩页，并选中该场景
  store.setTab('player');
  setTimeout(() => {
    const select = player.el.querySelector<HTMLSelectElement>('[data-role=scene]');
    if (select) {
      select.value = scene;
      player.onActivated();
      (player.el.querySelector('[data-act=start]') as HTMLButtonElement)?.click();
    }
  }, 0);
});

const views: Record<TabId, { el: HTMLElement; onActivated?: () => void }> = {
  editor,
  report,
  graph,
  player,
};

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="topbar">
    <h1>视觉小说剧本引擎</h1>
    <span class="sub">编剧文本 → 编译 → 可达性分析 → 分支图 → 网页试玩</span>
    <nav class="tabs">
      <button class="tab" data-tab="editor">剧本编辑</button>
      <button class="tab" data-tab="report">可达性分析</button>
      <button class="tab" data-tab="graph">分支图</button>
      <button class="tab" data-tab="player">试玩</button>
    </nav>
  </header>
`;

const viewContainer = document.createElement('div');
viewContainer.style.flex = '1 1 auto';
viewContainer.style.display = 'flex';
viewContainer.style.minHeight = '0';
for (const v of Object.values(views)) viewContainer.appendChild(v.el);
app.appendChild(viewContainer);

function activate(tab: TabId) {
  store.setTab(tab);
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  Object.entries(views).forEach(([id, v]) => {
    v.el.classList.toggle('active', id === tab);
  });
  views[tab].onActivated?.();
}

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => {
  b.addEventListener('click', () => activate(b.dataset.tab as TabId));
});

// 编译状态变化时刷新编辑器问题面板
store.subscribe((s) => {
  if (s.activeTab === 'editor') editor.refreshProblems();
});

activate('editor');
