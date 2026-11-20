/**
 * 运行时引擎：消费 CompiledScript，提供逐句推进、选项、存档读档、
 * 回看历史、自动播放与跳过已读。
 *
 * 引擎与 UI 解耦：通过 listener 回调发出事件，UI 只负责渲染。
 */
import {
  ABS_FALSE,
  ABS_TRUE,
  absConst,
  evalCondConcrete,
  type AbsState,
  type AbsValue,
} from './conditions';
import type {
  ChoiceOption,
  CompiledScript,
  FlagMap,
  FlagValue,
  HistoryEntry,
  Instruction,
  MutexGroup,
  SaveSlot,
} from './types';

export type EngineEvent =
  | { type: 'text'; speaker: string; content: string; line: number; scene: string }
  | { type: 'choice'; options: AvailableOption[]; line: number; scene: string }
  | { type: 'ending'; id: string; name: string; scene: string }
  | { type: 'scene-enter'; scene: string }
  | { type: 'flags-changed'; flags: FlagMap }
  | {
      type: 'mutex-violation';
      groupName: string;
      flags: string[];
      /** 试图置 true 的旗标 */
      flag: string;
      line: number;
    };

export interface AvailableOption {
  index: number;
  text: string;
  target: string;
  visible: boolean;
  /** 条件不满足而被隐藏的原因，调试用 */
  hiddenReason?: string;
  line: number;
}

type Listener = (e: EngineEvent) => void;

const SAVE_PREFIX = 'vn-engine-save:';
const READ_PREFIX = 'vn-engine-read:';
const GLOBAL_READ_KEY = '__global__';

export interface EngineOptions {
  storage?: Storage | null;
  /** 自动播放每句停留毫秒数 */
  autoDelayMs?: number;
  /** 跳过模式下每步间隔毫秒数 */
  skipDelayMs?: number;
}

export class Engine {
  private script: CompiledScript;
  private flags: FlagMap = {};
  private pc = 0;
  private scene = '';
  private history: HistoryEntry[] = [];
  private readKeys: Set<string>;
  private listeners = new Set<Listener>();
  private storage: Storage | null;
  private autoDelayMs: number;
  private skipDelayMs: number;
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private skipTimer: ReturnType<typeof setTimeout> | null = null;
  private waitingChoice: AvailableOption[] | null = null;
  private ended = false;
  /** 旗标 -> 所属互斥组（运行时强制同组最多一个 true） */
  private flagToMutex = new Map<string, MutexGroup>();

  constructor(script: CompiledScript, opts: EngineOptions = {}) {
    this.script = script;
    this.storage = opts.storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    this.autoDelayMs = opts.autoDelayMs ?? 1800;
    this.skipDelayMs = opts.skipDelayMs ?? 60;
    this.readKeys = new Set(this.loadReadKeys());
    for (const mg of script.mutexGroups) {
      for (const f of mg.flags) this.flagToMutex.set(f, mg);
    }
  }

  /**
   * 统一的旗标赋值入口：对互斥组旗标，若同组已有 true，则拒绝赋值并发出事件。
   * 返回是否实际写入。
   */
  private assignFlag(flag: string, value: FlagValue, line: number): boolean {
    if (value === true) {
      const group = this.flagToMutex.get(flag);
      if (group) {
        const clash = group.flags.some((f) => f !== flag && this.flags[f] === true);
        if (clash) {
          this.emit({
            type: 'mutex-violation',
            groupName: group.name,
            flags: [...group.flags],
            flag,
            line,
          });
          return false;
        }
      }
    }
    this.flags[flag] = value;
    return true;
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------
  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: EngineEvent) {
    for (const fn of this.listeners) fn(e);
  }

  // -------------------------------------------------------------------------
  // 状态查询
  // -------------------------------------------------------------------------
  getFlags(): Readonly<FlagMap> {
    return this.flags;
  }

  getScene(): string {
    return this.scene;
  }

  getPc(): number {
    return this.pc;
  }

  isEnded(): boolean {
    return this.ended;
  }

  isWaitingChoice(): boolean {
    return this.waitingChoice !== null;
  }

  getHistory(): readonly HistoryEntry[] {
    return this.history;
  }

  getAvailableOptions(): readonly AvailableOption[] | null {
    return this.waitingChoice;
  }

  // -------------------------------------------------------------------------
  // 启动 / 跳转
  // -------------------------------------------------------------------------
  start(sceneName?: string) {
    this.stopAuto();
    this.stopSkip();
    this.flags = {};
    this.history = [];
    this.ended = false;
    this.waitingChoice = null;
    const target = sceneName ?? this.script.entry;
    const sc = this.script.scenes[target];
    if (!sc) throw new Error(`场景 "${target}" 不存在`);
    this.scene = target;
    this.pc = sc.start;
    this.emit({ type: 'scene-enter', scene: this.scene });
    this.emit({ type: 'flags-changed', flags: { ...this.flags } });
    this.runUntilPause();
  }

  /** 从任意场景开始试玩：旗标可预置 */
  startAt(sceneName: string, initialFlags?: FlagMap) {
    this.start(sceneName);
    if (initialFlags && Object.keys(initialFlags).length) {
      this.flags = { ...initialFlags };
      this.emit({ type: 'flags-changed', flags: { ...this.flags } });
    }
  }

  private enterScene(name: string) {
    const sc = this.script.scenes[name];
    if (!sc) throw new Error(`场景 "${name}" 不存在`);
    this.scene = name;
    this.pc = sc.start;
    this.emit({ type: 'scene-enter', scene: name });
  }

  /** 连续执行直到遇到需要玩家介入的节点（文本/选项/结局） */
  private runUntilPause() {
    while (!this.ended) {
      const ins: Instruction | undefined = this.script.instructions[this.pc];
      if (!ins) {
        // 指令越界（编译器保证不会发生，兜底）
        this.ended = true;
        return;
      }
      switch (ins.kind) {
        case 'text': {
          this.markRead(ins.line);
          const entry: HistoryEntry = {
            speaker: ins.speaker,
            content: ins.content,
            line: ins.line,
            scene: this.scene,
          };
          this.history.push(entry);
          this.emit({
            type: 'text',
            speaker: ins.speaker,
            content: ins.content,
            line: ins.line,
            scene: this.scene,
          });
          this.pc++;
          return; // 等玩家点击
        }
        case 'set':
          this.assignFlag(ins.flag, ins.value, ins.line);
          this.pc++;
          this.emit({ type: 'flags-changed', flags: { ...this.flags } });
          break;
        case 'goto':
          if (ins.cond && !evalCondConcrete(this.flags, ins.cond)) {
            this.pc++; // 条件不满足，继续下一条
            break;
          }
          this.enterScene(ins.target);
          break;
        case 'ending':
          this.ended = true;
          this.stopAuto();
          this.stopSkip();
          this.emit({ type: 'ending', id: ins.id, name: ins.name, scene: this.scene });
          return;
        case 'choice': {
          this.waitingChoice = ins.options.map((opt, index) => {
            const visible = !opt.cond || evalCondConcrete(this.flags, opt.cond);
            return {
              index,
              text: opt.text,
              target: opt.target,
              visible,
              line: opt.line,
            };
          });
          this.stopAuto();
          this.stopSkip();
          this.emit({
            type: 'choice',
            options: this.waitingChoice,
            line: ins.line,
            scene: this.scene,
          });
          return;
        }
      }
    }
  }

  /** 点击继续：推进下一句 */
  next() {
    if (this.ended || this.waitingChoice) return;
    this.runUntilPause();
  }

  /** 选择选项 */
  choose(index: number) {
    const opts = this.waitingChoice;
    if (!opts) throw new Error('当前没有等待中的选项');
    const opt = opts[index];
    if (!opt || !opt.visible) throw new Error('该选项当前不可选');
    const raw: ChoiceOption = (this.script.instructions[this.pc] as Extract<
      Instruction,
      { kind: 'choice' }
    >).options[index]!;
    this.waitingChoice = null;
    for (const s of raw.sets) this.assignFlag(s.flag, s.value, raw.line);
    this.pc++;
    this.emit({ type: 'flags-changed', flags: { ...this.flags } });
    this.enterScene(raw.target);
    this.runUntilPause();
  }

  // -------------------------------------------------------------------------
  // 自动播放
  // -------------------------------------------------------------------------
  isAutoOn(): boolean {
    return this.autoTimer !== null;
  }

  startAuto() {
    if (this.ended || this.waitingChoice || this.autoTimer) return;
    this.stopSkip();
    const tick = () => {
      if (this.ended || this.waitingChoice) {
        this.stopAuto();
        return;
      }
      this.runUntilPause();
      if (!this.ended && !this.waitingChoice) {
        this.autoTimer = setTimeout(tick, this.autoDelayMs);
      } else {
        this.autoTimer = null;
      }
    };
    this.autoTimer = setTimeout(tick, this.autoDelayMs);
  }

  stopAuto() {
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
  }

  toggleAuto(): boolean {
    if (this.isAutoOn()) this.stopAuto();
    else this.startAuto();
    return this.isAutoOn();
  }

  // -------------------------------------------------------------------------
  // 跳过已读
  // -------------------------------------------------------------------------
  isSkipOn(): boolean {
    return this.skipTimer !== null;
  }

  /** 未读句会停下；选项/结局也会停 */
  startSkip() {
    if (this.ended || this.skipTimer) return;
    this.stopAuto();
    const tick = () => {
      if (this.ended) {
        this.stopSkip();
        return;
      }
      if (this.waitingChoice) {
        this.stopSkip();
        return;
      }
      const ins = this.script.instructions[this.pc];
      if (ins && ins.kind === 'text' && !this.readKeys.has(this.readKey(ins.line))) {
        this.stopSkip(); // 遇到未读文本，停下让玩家看
        return;
      }
      this.runUntilPause();
      if (!this.ended && !this.waitingChoice) {
        this.skipTimer = setTimeout(tick, this.skipDelayMs);
      } else {
        this.skipTimer = null;
      }
    };
    this.skipTimer = setTimeout(tick, this.skipDelayMs);
  }

  stopSkip() {
    if (this.skipTimer) clearTimeout(this.skipTimer);
    this.skipTimer = null;
  }

  toggleSkip(): boolean {
    if (this.isSkipOn()) this.stopSkip();
    else this.startSkip();
    return this.isSkipOn();
  }

  // -------------------------------------------------------------------------
  // 已读标记
  // -------------------------------------------------------------------------
  private readKey(line: number): string {
    return `${this.scene}#L${line}`;
  }

  private markRead(line: number) {
    const k = this.readKey(line);
    if (!this.readKeys.has(k)) {
      this.readKeys.add(k);
      this.persistReadKeys();
    }
  }

  /** 把整个剧本标记为已读（测试用，也可做"全部跳过"） */
  markAllRead() {
    this.readKeys.clear();
    for (const name of Object.keys(this.script.scenes)) {
      const sc = this.script.scenes[name]!;
      for (let i = sc.start; i < sc.end; i++) {
        const ins = this.script.instructions[i]!;
        if (ins.kind === 'text') this.readKeys.add(`${name}#L${ins.line}`);
      }
    }
    this.persistReadKeys();
  }

  private loadReadKeys(): string[] {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(READ_PREFIX + this.storageKey());
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  }

  private persistReadKeys() {
    if (!this.storage) return;
    try {
      this.storage.setItem(
        READ_PREFIX + this.storageKey(),
        JSON.stringify([...this.readKeys]),
      );
    } catch {
      /* 存储满等情况忽略 */
    }
  }

  private storageKey(): string {
    return GLOBAL_READ_KEY;
  }

  // -------------------------------------------------------------------------
  // 存档 / 读档
  // -------------------------------------------------------------------------
  save(slotId: string, label?: string): SaveSlot {
    const slot: SaveSlot = {
      slotId,
      label: label ?? `存档 ${slotId}`,
      timestamp: Date.now(),
      scene: this.scene,
      pc: this.pc,
      flags: structuredClone(this.flags),
      history: structuredClone(this.history),
      readKeys: [...this.readKeys],
    };
    if (this.storage) {
      this.storage.setItem(SAVE_PREFIX + slotId, JSON.stringify(slot));
    }
    return slot;
  }

  load(slotId: string): SaveSlot | null {
    if (!this.storage) return null;
    const raw = this.storage.getItem(SAVE_PREFIX + slotId);
    if (!raw) return null;
    const slot = JSON.parse(raw) as SaveSlot;
    this.restoreSlot(slot);
    return slot;
  }

  restoreSlot(slot: SaveSlot) {
    this.stopAuto();
    this.stopSkip();
    this.flags = structuredClone(slot.flags);
    this.history = structuredClone(slot.history);
    this.readKeys = new Set(slot.readKeys);
    this.waitingChoice = null;
    this.ended = false;
    const sc = this.script.scenes[slot.scene];
    if (!sc) throw new Error(`存档中的场景 "${slot.scene}" 已不存在`);
    this.scene = slot.scene;
    this.pc = Math.min(slot.pc, this.script.instructions.length - 1);
    this.emit({ type: 'scene-enter', scene: this.scene });
    this.emit({ type: 'flags-changed', flags: { ...this.flags } });
    // 恢复后停在存档点：重新执行到下一个暂停点
    this.runUntilPause();
  }

  listSaves(): SaveSlot[] {
    if (!this.storage) return [];
    const out: SaveSlot[] = [];
    for (let i = this.storage.length - 1; i >= 0; i--) {
      const key = this.storage.key(i);
      if (key?.startsWith(SAVE_PREFIX)) {
        try {
          out.push(JSON.parse(this.storage.getItem(key)!) as SaveSlot);
        } catch {
          /* 损坏的存档跳过 */
        }
      }
    }
    return out.sort((a, b) => b.timestamp - a.timestamp);
  }

  deleteSave(slotId: string) {
    this.storage?.removeItem(SAVE_PREFIX + slotId);
  }

  // -------------------------------------------------------------------------
  // 调试 / 分析辅助
  // -------------------------------------------------------------------------
  /** 当前抽象状态（互斥分析复用同一套三值域） */
  snapshotAbsState(): AbsState {
    const m: AbsState = new Map();
    for (const [k, v] of Object.entries(this.flags)) m.set(k, absConst(v));
    return m;
  }

  /** 布尔旗标在互斥语义下的抽象常量，便于外部断言 */
  static boolAbs(v: boolean): AbsValue {
    return v ? ABS_TRUE : ABS_FALSE;
  }
}
