/**
 * 前端应用共享状态：当前剧本文本、编译结果、标签路由
 */
import { compile } from '../core/compiler.ts';
import type { CompileResult, CompiledScript } from '../core/types.ts';

export interface AppState {
  source: string;
  compileResult: CompileResult;
  activeTab: TabId;
}

export type TabId = 'editor' | 'report' | 'graph' | 'player';
type Listener = (state: AppState) => void;

const STORAGE_KEY = 'vn-editor-source';

function loadInitialSource(fallback: string): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) return saved;
  } catch {
    /* ignore */
  }
  return fallback;
}

export class Store {
  private state: AppState;
  private listeners = new Set<Listener>();

  constructor(fallbackSource: string) {
    const source = loadInitialSource(fallbackSource);
    this.state = {
      source,
      compileResult: compile(source),
      activeTab: 'editor',
    };
  }

  get(): AppState {
    return this.state;
  }

  getScript(): CompiledScript | null {
    return this.state.compileResult.script;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  setSource(source: string, persist = true) {
    this.state = { ...this.state, source, compileResult: compile(source) };
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, source);
      } catch {
        /* ignore */
      }
    }
    this.emit();
  }

  recompile() {
    this.state = {
      ...this.state,
      compileResult: compile(this.state.source),
    };
    this.emit();
  }

  setTab(tab: TabId) {
    if (tab === this.state.activeTab) return;
    this.state = { ...this.state, activeTab: tab };
    this.emit();
  }
}
