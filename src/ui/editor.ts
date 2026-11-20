import type { Store } from './store.ts';
import type { CompileError } from '../core/types.ts';

const SAMPLE_URL = new URL('../../scripts/sample.vns', import.meta.url);

export class EditorView {
  el: HTMLElement;
  private store: Store;
  private textarea!: HTMLTextAreaElement;
  private gutter!: HTMLElement;
  private problemList!: HTMLElement;
  private statusBadge!: HTMLElement;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(store: Store) {
    this.store = store;
    this.el = document.createElement('div');
    this.el.className = 'view';
    this.el.id = 'view-editor';
    this.render();
    this.bind();
    this.refreshProblems();
  }

  private render() {
    this.el.innerHTML = `
      <div class="editor-wrap" style="width:100%">
        <div class="editor-left">
          <div class="editor-toolbar">
            <button class="btn primary" data-act="compile">编译</button>
            <button class="btn" data-act="sample">载入示例剧本</button>
            <button class="btn" data-act="export">导出 JSON</button>
            <button class="btn ghost" data-act="clear">清空</button>
            <span style="flex:1"></span>
            <span class="badge" data-role="status"></span>
          </div>
          <div class="editor-body">
            <div class="line-gutter" data-role="gutter"></div>
            <textarea class="code" spellcheck="false" wrap="off"
              placeholder="在这里写剧本……"></textarea>
          </div>
        </div>
        <div class="editor-right">
          <div class="panel-title">编译问题（点击跳转到对应行）</div>
          <div class="problem-list" data-role="problems"></div>
        </div>
      </div>`;
    this.textarea = this.el.querySelector('textarea')!;
    this.gutter = this.el.querySelector('[data-role=gutter]')!;
    this.problemList = this.el.querySelector('[data-role=problems]')!;
    this.statusBadge = this.el.querySelector('[data-role=status]')!;
    this.textarea.value = this.store.get().source;
    this.syncGutter();
  }

  private bind() {
    this.textarea.addEventListener('input', () => {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        this.store.setSource(this.textarea.value);
        this.refreshProblems();
      }, 350);
      this.syncGutter();
    });
    this.textarea.addEventListener('scroll', () => {
      this.gutter.scrollTop = this.textarea.scrollTop;
    });

    this.el.querySelector('[data-act=compile]')!.addEventListener('click', () => {
      this.store.setSource(this.textarea.value);
      this.refreshProblems();
    });

    this.el.querySelector('[data-act=sample]')!.addEventListener('click', async () => {
      const src = await (await fetch(SAMPLE_URL)).text();
      this.textarea.value = src;
      this.store.setSource(src);
      this.syncGutter();
      this.refreshProblems();
    });

    this.el.querySelector('[data-act=export]')!.addEventListener('click', () => {
      const r = this.store.get().compileResult;
      if (!r.ok || !r.script) {
        alert('剧本有编译错误，无法导出');
        return;
      }
      const blob = new Blob([JSON.stringify(r.script, null, 2)], {
        type: 'application/json',
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'compiled-script.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });

    this.el.querySelector('[data-act=clear]')!.addEventListener('click', () => {
      if (confirm('确定清空当前剧本？')) {
        this.textarea.value = '';
        this.store.setSource('');
        this.syncGutter();
        this.refreshProblems();
      }
    });
  }

  private syncGutter() {
    const lines = this.textarea.value.split('\n').length;
    const errLines = new Set(
      this.store
        .get()
        .compileResult.errors.filter((e) => e.line > 0)
        .map((e) => e.line),
    );
    const html: string[] = [];
    for (let i = 1; i <= lines; i++) {
      html.push(`<div class="ln ${errLines.has(i) ? 'err-line' : ''}">${i}</div>`);
    }
    this.gutter.innerHTML = html.join('');
  }

  refreshProblems() {
    const r = this.store.get().compileResult;
    const all: { kind: 'error' | 'warning'; item: CompileError }[] = [
      ...r.errors.map((item) => ({ kind: 'error' as const, item })),
      ...r.warnings.map((item) => ({ kind: 'warning' as const, item })),
    ];

    if (r.ok) {
      this.statusBadge.className = 'badge ok';
      this.statusBadge.textContent = `编译通过 · ${r.script?.endings.length ?? 0} 结局 · ${
        r.script ? Object.keys(r.script.scenes).length : 0
      } 场景`;
    } else {
      this.statusBadge.className = 'badge err';
      this.statusBadge.textContent = `${r.errors.length} 个错误`;
    }

    if (all.length === 0) {
      this.problemList.innerHTML = '<div class="empty-hint">没有问题，剧本可以运行</div>';
      this.syncGutter();
      return;
    }

    this.problemList.innerHTML = all
      .map(
        ({ kind, item }) => `
        <div class="problem ${kind}" data-line="${item.line}">
          <div class="loc">${kind === 'error' ? '❌ 错误' : '⚠️ 警告'} · 第 ${item.line} 行${
            item.column ? `:${item.column}` : ''
          }</div>
          <div class="msg">${escapeHtml(item.message)}</div>
          ${item.sourceLine ? `<div class="src">${escapeHtml(item.sourceLine)}</div>` : ''}
        </div>`,
      )
      .join('');

    this.problemList.querySelectorAll('.problem').forEach((node) => {
      node.addEventListener('click', () => {
        const line = Number((node as HTMLElement).dataset.line);
        this.jumpToLine(line);
      });
    });
    this.syncGutter();
  }

  private jumpToLine(line: number) {
    if (!line) return;
    const lines = this.textarea.value.split('\n');
    const pos = lines.slice(0, line - 1).reduce((acc, l) => acc + l.length + 1, 0);
    this.textarea.focus();
    this.textarea.setSelectionRange(pos, pos + (lines[line - 1]?.length ?? 0));
    // 滚动到目标行（按行高约 22px 估算）
    const lineHeight = parseFloat(getComputedStyle(this.textarea).lineHeight) || 22;
    this.textarea.scrollTop = Math.max(0, (line - 3) * lineHeight);
  }

  onActivated() {
    this.refreshProblems();
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
