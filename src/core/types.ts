/**
 * 剧本引擎核心类型定义
 *
 * 数据流：编剧写的 .vns 文本 --(compiler)--> CompiledScript(指令序列)
 *         --(Engine 运行)--> 运行时状态；--(analyzer)--> 可达性报告
 */

// ---------------------------------------------------------------------------
// 旗标与条件
// ---------------------------------------------------------------------------

/** 旗标值：布尔 / 数字 / 字符串 */
export type FlagValue = boolean | number | string;
export type FlagMap = Record<string, FlagValue>;

/** 比较运算符 */
export type Op = '==' | '!=' | '>=' | '<=' | '>' | '<';

/** 单个原子条件：flag 名 + 运算符 + 右值 */
export interface Condition {
  flag: string;
  op: Op;
  value: FlagValue;
  /** 源文件行号，报错与分析报告定位用 */
  line: number;
}

/** 条件表达式树（支持 and / or / 括号） */
export type CondExpr =
  | { kind: 'atom'; cond: Condition }
  | { kind: 'and'; children: CondExpr[] }
  | { kind: 'or'; children: CondExpr[] };

// ---------------------------------------------------------------------------
// 互斥声明（编剧在配置区声明，分析器据此排除不可能的组合）
// ---------------------------------------------------------------------------

export interface MutexGroup {
  /** 互斥组名，仅用于报告展示 */
  name: string;
  /** 互斥的旗标名；同一周目内这些旗标最多只能有一个为 true */
  flags: string[];
  line: number;
}

// ---------------------------------------------------------------------------
// 编译后的指令
// ---------------------------------------------------------------------------

export type Instruction =
  | { kind: 'text'; speaker: string; content: string; line: number }
  | { kind: 'set'; flag: string; value: FlagValue; line: number }
  | {
      kind: 'choice';
      options: ChoiceOption[];
      line: number;
    }
  | {
      kind: 'goto';
      target: string;
      /** 条件跳转时携带；无条件跳转为 undefined */
      cond: CondExpr | undefined;
      line: number;
    }
  | { kind: 'ending'; id: string; name: string; line: number };

export interface ChoiceOption {
  text: string;
  target: string;
  cond: CondExpr | undefined;
  /** 选项自身携带的赋值，选中后先赋值再跳转 */
  sets: { flag: string; value: FlagValue }[];
  line: number;
}

/** 一个场景（=== 开头的块）编译后的结果 */
export interface CompiledScene {
  name: string;
  /** 在全局指令数组中的区间 [start, end) */
  start: number;
  end: number;
  line: number;
}

export interface CompiledScript {
  /** 打平的全部指令，场景通过区间索引 */
  instructions: Instruction[];
  scenes: Record<string, CompiledScene>;
  /** 入口场景名 */
  entry: string;
  mutexGroups: MutexGroup[];
  /** 用到过的全部旗标名 */
  flagNames: string[];
  /** 所有结局指令（id -> 首次出现的场景） */
  endings: { id: string; name: string; scene: string }[];
}

// ---------------------------------------------------------------------------
// 编译错误
// ---------------------------------------------------------------------------

export interface CompileError {
  line: number;
  column: number;
  message: string;
  /** 出错的原始行文本，供工具高亮 */
  sourceLine: string;
}

export interface CompileResult {
  ok: boolean;
  script: CompiledScript | null;
  errors: CompileError[];
  /** 非致命警告（未声明旗标等） */
  warnings: CompileError[];
}

// ---------------------------------------------------------------------------
// 可达性分析
// ---------------------------------------------------------------------------

export interface UnreachableEnding {
  endingId: string;
  endingName: string;
  scene: string;
  /**
   * 缺失条件说明：在分析器到达该结局场景的"最宽"抽象状态下，
   * 仍求值为 false 的原子条件（即无论如何走都满足不了的条件）。
   */
  missing: Condition[];
  /** 人类可读的诊断 */
  reasons: string[];
  /** 分析过程中是否触发了互斥冲突 */
  mutexConflict?: {
    groupName: string;
    flags: string[];
  };
}

/** 永远触发不了的选项 / 条件分支 */
export interface DeadBranch {
  kind: 'choice' | 'goto';
  scene: string;
  line: number;
  /** 选项文本（choice 时有值） */
  optionText?: string;
  target: string;
  /** 使之成为死分支的、恒为 false 的原子条件 */
  blocking: Condition[];
  reasons: string[];
}

export interface ReachabilityReport {
  totalEndings: number;
  reachable: number;
  unreachable: UnreachableEnding[];
  /** 永远触发不了的选项/条件跳转 */
  deadBranches: DeadBranch[];
  /** 分析耗时（毫秒） */
  elapsedMs: number;
  /** 分析中访问过的场景数 */
  visitedScenes: number;
}

// ---------------------------------------------------------------------------
// 存档
// ---------------------------------------------------------------------------

export interface SaveSlot {
  slotId: string;
  label: string;
  timestamp: number;
  scene: string;
  pc: number;
  flags: FlagMap;
  /** 回看历史的快照 */
  history: HistoryEntry[];
  /** 已读场景/指令标记，用于"跳过已读" */
  readKeys: string[];
}

export interface HistoryEntry {
  speaker: string;
  content: string;
  line: number;
  scene: string;
}
