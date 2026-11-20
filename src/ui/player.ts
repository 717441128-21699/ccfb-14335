import { Engine, type EngineEvent } from '../core/engine.ts';
import type { CompiledScript, FlagMap, HistoryEntry, SaveSlot } from '../core/types.ts';
import type { Store } from './store.ts';

export class PlayerView {
  el: HTMLElement;
  private store: Store;
  private engine: Engine | null = null;
  private script: CompiledScript | null = null;

  private stage!: HTMLElement;
  private sceneSelect!: HTMLSelectElement;
  private flagInput!: HTMLInputElement;
  private historyBox!: HTMLElement;
  private flagBox!: HTMLElement;
  private saveBox!: HTMLElement;
  private autoBtn!: HTMLButtonElement;
  private skipBtn!: HTMLButtonElement;
  private saveLabel!: HTMLInputElement;

  constructor(store: Store) {
    this.store = store;
    this.el = document.createElement('div');
    this.el.className = 'view';
    this.el.id = 'view-player';
    this.renderSkeleton();
  }

  private renderSkeleton() {
    this.el.innerHTML = `
      <div class="player-wrap">
        <div class="player-main">
          <div class="stage" data-role="stage"></div>
          <div class="player-controls">
            <select data-role="scene" title="选择起始场景"></select>
            <input type="text" data-role="flaginit" placeholder='预置旗标，如 {"a":true}' style="width:200px" />
            <button class="btn primary" data-act="start">从此场景开始</button>
            <span class="spacer"></span>
            <button class="btn toggle" data-role="auto">自动播放</button>
            <button class="btn toggle" data-role="skip">跳过已读</button>
            <button class="btn" data-act="save">存档</button>
            <input type="text" data-role="savelabel" placeholder="存档名" style="width:110px" />
          </div>
        </div>
        <div class="player-side">
          <div class="side-section">
            <div class="side-head">当前旗标</div>
            <div class="side-body" data-role="flags" style="max-height:180px"></div>
          </div>
          <div class="side-section flex">
            <div class="side-head">历史文本（回看）</div>
            <div class="side-body" data-role="history"></div>
          </div>
          <div class="side-section">
            <div class="side-head">存档</div>
            <div class="side-body" data-role="saves" style="max-height:200px"></div>
          </div>
        </div>
      </div>`;
    this.stage = this.el.querySelector('[data-role=stage]')!;
    this.sceneSelect = this.el.querySelector('[data-role=scene]')!;
    this.flagInput = this.el.querySelector('[data-role=flaginit]')!;
    this.historyBox = this.el.querySelector('[data-role=history]')!;
    this.flagBox = this.el.querySelector('[data-role=flags]')!;
    this.saveBox = this.el.querySelector('[data-role=saves]')!;
    this.autoBtn = this.el.querySelector('[data-role=auto]')!;
    this.skipBtn = this.el.querySelector('[data-role=skip]')!;
    this.saveLabel = this.el.querySelector('[data-role=savelabel]')!;

    this.el.querySelector('[data-act=start]')!.addEventListener('click', () => this.startFromSelected());
    this.el.querySelector('[data-act=save]')!.addEventListener('click', () => this.doSave());
    this.autoBtn.addEventListener('click', () => this.engine?.toggleAuto());
    this.skipBtn.addEventListener('click', () => this.engine?.toggleSkip());
  }

  onActivated() {
    const script = this.store.getScript();
    if (!script) {
      this.stage.innerHTML = '<div class="empty-hint">剧本有编译错误，无法试玩</div>';
      return;
    }
    this.script = script;
    this.sceneSelect.innerHTML = Object.keys(script.scenes)
      .map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)
      .join('');
    this.sceneSelect.value = script.entry;
    this.ensureEngine();
    if (!this.engine!.getScene()) {
      this.startFromSelected();
    } else {
      this.refreshSaves();
    }
  }

  private ensureEngine() {
    if (this.engine || !this.script) return;
    this.engine = new Engine(this.script, { autoDelayMs: 1400, skipDelayMs: 50 });
    this.engine.on((e) => this.handleEvent(e));
  }

  private startFromSelected() {
    if (!this.engine) return;
    const scene = this.sceneSelect.value;
    let initial: FlagMap | undefined;
    const raw = this.flagInput.value.trim();
    if (raw) {
      try {
        initial = JSON.parse(raw) as FlagMap;
      } catch {
        alert('预置旗标不是合法 JSON');
        return;
      }
    }
    this.engine.startAt(scene, initial);
    this.sceneSelect.value = scene;
  }

  private handleEvent(e: EngineEvent) {
    switch (e.type) {
      case 'text':
        this.renderText(e.speaker, e.content, e.scene);
        break;
      case 'choice':
        this.renderChoice(e.options.map((o) => ({ ...o })), e.scene);
        break;
      case 'ending':
        this.renderEnding(e.name, e.id);
        break;
      case 'flags-changed':
        this.renderFlags(e.flags);
        break;
      case 'scene-enter':
        this.updateToggleButtons();
        break;
    }
    this.renderHistory(this.engine?.getHistory() ?? []);
  }

  private renderText(speaker: string, content: string, scene: string) {
    this.stage.innerHTML = `
      <div class="dialog-box" data-role="dialog">
        <div class="dialog-speaker">${speaker ? escapeHtml(speaker) : '旁白'}</div>
        <div class="dialog-text">${escapeHtml(content)}</div>
      </div>
      <div style="text-align:right;color:var(--fg-dim);font-size:12px;margin-top:8px">
        场景 ${escapeHtml(scene)} · 点击继续
      </div>`;
    this.stage.querySelector('[data-role=dialog]')!.addEventListener('click', () => this.engine?.next());
    this.updateToggleButtons();
  }

  private renderChoice(
    options: { index: number; text: string; visible: boolean }[],
    scene: string,
  ) {
    const visible = options.filter((o) => o.visible);
    this.stage.innerHTML = `
      <div class="dialog-box">
        <div class="dialog-speaker">做出选择</div>
        <div class="choice-list">
          ${visible
            .map(
              (o) => `
            <button class="choice-btn" data-idx="${o.index}">
              ${escapeHtml(o.text)}
            </button>`,
            )
            .join('')}
        </div>
      </div>
      <div style="text-align:right;color:var(--fg-dim);font-size:12px;margin-top:8px">
        场景 ${escapeHtml(scene)} · 共 ${options.length} 项，${visible.length} 项当前可选
      </div>`;
    this.stage.querySelectorAll<HTMLButtonElement>('[data-idx]').forEach((btn) => {
      btn.addEventListener('click', () => this.engine?.choose(Number(btn.dataset.idx)));
    });
  }

  private renderEnding(name: string, id: string) {
    this.stage.innerHTML = `
      <div class="ending-banner">
        <div class="etitle">${escapeHtml(name)}</div>
        <div class="mono" style="color:var(--fg-dim)">ending id: ${escapeHtml(id)}</div>
        <button class="btn primary" style="margin-top:22px" data-act="restart">回到入口重新开始</button>
      </div>`;
    this.stage.querySelector('[data-act=restart]')!.addEventListener('click', () => {
      this.sceneSelect.value = this.script!.entry;
      this.flagInput.value = '';
      this.startFromSelected();
    });
    this.updateToggleButtons();
  }

  private renderFlags(flags: FlagMap) {
    const entries = Object.entries(flags);
    this.flagBox.innerHTML = entries.length
      ? entries
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(
            ([k, v]) => `
          <div class="flag-row">
            <span>${escapeHtml(k)}</span>
            <span class="v">${escapeHtml(String(v))}</span>
          </div>`,
          )
          .join('')
      : '<div class="empty-hint">暂无旗标</div>';
  }

  private renderHistory(history: readonly HistoryEntry[]) {
    this.historyBox.innerHTML = history.length
      ? history
          .map(
            (h) => `
          <div class="history-item" title="${escapeHtml(h.scene)} 第${h.line}行">
            ${h.speaker ? `<span class="sp">${escapeHtml(h.speaker)}：</span>` : ''}${escapeHtml(
              h.content,
            )}
          </div>`,
          )
          .join('')
      : '<div class="empty-hint">尚无历史</div>';
    this.historyBox.scrollTop = this.historyBox.scrollHeight;
  }

  private updateToggleButtons() {
    if (!this.engine) return;
    this.autoBtn.classList.toggle('on', this.engine.isAutoOn());
    this.skipBtn.classList.toggle('on', this.engine.isSkipOn());
  }

  private doSave() {
    if (!this.engine) return;
    const slotId = `slot_${Date.now()}`;
    const label = this.saveLabel.value.trim() || `${this.engine.getScene()} 存档`;
    this.engine.save(slotId, label);
    this.saveLabel.value = '';
    this.refreshSaves();
    toast(`已保存：${label}`);
  }

  private refreshSaves() {
    if (!this.engine) return;
    const saves = this.engine.listSaves();
    this.saveBox.innerHTML = saves.length
      ? saves
          .map(
            (s: SaveSlot) => `
          <div class="save-row">
            <div class="info">
              <div>${escapeHtml(s.label)}</div>
              <div class="t">${new Date(s.timestamp).toLocaleString()} · ${escapeHtml(
                s.scene,
              )} · ${s.history.length} 句</div>
            </div>
            <button class="btn" data-load="${s.slotId}">读档</button>
            <button class="btn ghost" data-del="${s.slotId}">删</button>
          </div>`,
          )
          .join('')
      : '<div class="empty-hint">还没有存档</div>';

    this.saveBox.querySelectorAll<HTMLButtonElement>('[data-load]').forEach((b) =>
      b.addEventListener('click', () => {
        const slot = this.engine!.load(b.dataset.load!);
        if (slot) {
          this.sceneSelect.value = slot.scene;
          this.renderFlags(this.engine!.getFlags() as FlagMap);
          this.renderHistory(this.engine!.getHistory());
          toast(`已读档：${slot.label}`);
        }
      }),
    );
    this.saveBox.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) =>
      b.addEventListener('click', () => {
        this.engine!.deleteSave(b.dataset.del!);
        this.refreshSaves();
      }),
    );
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(msg: string) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}
