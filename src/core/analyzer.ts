/**
 * 可达性分析器
 *
 * 建模：把每个场景按控制指令（@if/@goto/@choice/@ending）切成"段(segment)"，
 * 段内只有顺序文本与 @set。段级 CFG 精确表达条件跳转链。
 *
 * 两层算法：
 * 1. 抽象不动点（worklist + 三值域）：线性时间算出各段的抽象状态过近似，
 *    找出恒为 false 的死条件/死选项，以及不可达场景。
 * 2. 具体状态 DFS + 互斥剪枝：枚举真实可行的旗标组合，互斥组内第二个被置
 *    true 的旗标会让该路径直接失效，保证不会把凑不齐的组合误报成可达。
 *    每段做状态包含去重 + 数量上限，控制菱形分支规模。
 *
 * 诊断：走不到的结局给出缺失的旗标条件和/或互斥冲突原因。
 */
import {
  atomToString,
  collectFalseAtoms,
  condToString,
  evalCondAbstract,
  mergeState,
  stateConverged,
  type AbsState,
  type Tri,
} from './conditions';
import type {
  ChoiceOption,
  CompiledScript,
  Condition,
  CondExpr,
  DeadBranch,
  FlagValue,
  Instruction,
  MutexGroup,
  ReachabilityReport,
  UnreachableEnding,
} from './types';

// ---------------------------------------------------------------------------
// 段级控制流图
// ---------------------------------------------------------------------------

export interface Segment {
  id: string;
  scene: string;
  indexInScene: number;
  /** 在全局指令数组中的区间 [start, end) */
  start: number;
  end: number;
  /** 段内顺序赋值 */
  sets: { flag: string; value: FlagValue; line: number }[];
  /** 段的终结指令 */
  terminator: Instruction;
}

export interface CfgEdge {
  from: string; // segment id
  to: string; // segment id
  cond: CondExpr | undefined;
  sets: { flag: string; value: FlagValue }[];
  kind: 'goto' | 'choice';
  line: number;
  optionText?: string;
}

export interface SegmentGraph {
  segments: Map<string, Segment>;
  /** 场景 -> 段 id 有序列表 */
  sceneSegments: Map<string, string[]>;
  segOfSceneEntry: Map<string, string>;
  edgesOut: Map<string, CfgEdge[]>;
  edgesIn: Map<string, CfgEdge[]>;
}

function segId(scene: string, idx: number): string {
  return `${scene}#${idx}`;
}

export function buildSegmentGraph(script: CompiledScript): SegmentGraph {
  const segments = new Map<string, Segment>();
  const sceneSegments = new Map<string, string[]>();
  const segOfSceneEntry = new Map<string, string>();
  const edgesOut = new Map<string, CfgEdge[]>();
  const edgesIn = new Map<string, CfgEdge[]>();

  // 1. 切块：在每个"终结型控制指令"（无条件 goto / choice / ending）之后断开。
  //    条件 goto（@if）不切块——它可能落空，下一条指令仍在同一顺序块里。
  //    一个块 = 顺序执行的 set/text + 若干 @if，最后由终结指令收尾。
  for (const [sceneName, sc] of Object.entries(script.scenes)) {
    const ids: string[] = [];
    let blockSets: Segment['sets'] = [];
    let blockTerm: Instruction | null = null;
    let blockStart = sc.start;
    let segIdx = 0;

    const commit = (endIdx: number) => {
      if (!blockTerm) return; // 空块（编译器已保证场景有终结）
      const id = segId(sceneName, segIdx);
      segments.set(id, {
        id,
        scene: sceneName,
        indexInScene: segIdx,
        start: blockStart,
        end: endIdx,
        sets: blockSets,
        terminator: blockTerm,
      });
      ids.push(id);
      edgesOut.set(id, []);
      edgesIn.set(id, []);
      if (segIdx === 0) segOfSceneEntry.set(sceneName, id);
      segIdx++;
      blockSets = [];
      blockTerm = null;
      blockStart = endIdx;
    };

    for (let i = sc.start; i < sc.end; i++) {
      const ins = script.instructions[i]!;
      if (ins.kind === 'set') {
        blockSets.push({ flag: ins.flag, value: ins.value, line: ins.line });
      } else if (ins.kind === 'text') {
        // 文本不影响分析
      } else if (ins.kind === 'goto' && ins.cond) {
        // 条件 @if：块内分流点，块继续（可能落空）
        blockTerm = ins;
      } else {
        // 无条件 goto / choice / ending：块在该指令后断开
        blockTerm = ins;
        commit(i + 1);
      }
    }
    // 结尾是条件 @if 链（落空即场景结束）
    commit(sc.end);
    sceneSegments.set(sceneName, ids);
  }

  // 2. 连边：段终结指令 -> 目标场景的入口段
  const targetSeg = (sceneName: string): string => {
    const entry = segOfSceneEntry.get(sceneName);
    if (!entry) throw new Error(`内部错误：场景 "${sceneName}" 没有入口段`);
    return entry;
  };

  const addEdge = (from: string, e: Omit<CfgEdge, 'from'>) => {
    const edge: CfgEdge = { from, ...e };
    edgesOut.get(from)!.push(edge);
    edgesIn.get(edge.to)!.push(edge);
  };

  for (const seg of segments.values()) {
    const term = seg.terminator;

    // 块内所有条件 @if：满足即跳转
    for (let i = seg.start; i < seg.end; i++) {
      const ins = script.instructions[i]!;
      if (ins.kind === 'goto' && ins.cond) {
        addEdge(seg.id, {
          to: targetSeg(ins.target),
          cond: ins.cond,
          sets: [],
          kind: 'goto',
          line: ins.line,
        });
      }
    }

    if (term.kind === 'goto' && term.cond) {
      // 块以条件 @if 链结尾：整体落空 -> 同场景下一个块
      const ids = sceneSegments.get(seg.scene)!;
      const nextIdx = seg.indexInScene + 1;
      if (nextIdx < ids.length) {
        addEdge(seg.id, {
          to: ids[nextIdx]!,
          cond: undefined,
          sets: [],
          kind: 'goto',
          line: term.line,
        });
      }
      // 若已是场景最后一块且全部 @if 落空，编译器要求场景必须有终结，
      // 这种情况意味着剧情中断（编译期已报错），分析期忽略
    } else if (term.kind === 'goto') {
      // 无条件 goto
      addEdge(seg.id, {
        to: targetSeg(term.target),
        cond: undefined,
        sets: [],
        kind: 'goto',
        line: term.line,
      });
    } else if (term.kind === 'choice') {
      for (const opt of term.options) {
        addEdge(seg.id, {
          to: targetSeg(opt.target),
          cond: opt.cond,
          sets: opt.sets.map((s) => ({ ...s })),
          kind: 'choice',
          line: opt.line,
          optionText: opt.text,
        });
      }
    }
    // ending：无出边
  }

  return { segments, sceneSegments, segOfSceneEntry, edgesOut, edgesIn };
}

// ---------------------------------------------------------------------------
// 第一层：抽象不动点
// ---------------------------------------------------------------------------

function applySetToAbs(state: AbsState, flag: string, value: FlagValue): AbsState {
  const next = new Map(state);
  next.set(flag, { top: false, values: [value] });
  return next;
}

function abstractFixpoint(script: CompiledScript, graph: SegmentGraph): Map<string, AbsState> {
  const states = new Map<string, AbsState>();
  const entrySeg = graph.segOfSceneEntry.get(script.entry)!;
  states.set(entrySeg, new Map());
  const worklist: string[] = [entrySeg];
  const queued = new Set<string>([entrySeg]);

  while (worklist.length) {
    const id = worklist.shift()!;
    queued.delete(id);
    const seg = graph.segments.get(id)!;
    const state = states.get(id)!;

    let s = state;
    for (const asg of seg.sets) s = applySetToAbs(s, asg.flag, asg.value);

    for (const edge of graph.edgesOut.get(id) ?? []) {
      let edgeState = s;
      for (const asg of edge.sets) edgeState = applySetToAbs(edgeState, asg.flag, asg.value);
      if (edge.cond && evalCondAbstract(edgeState, edge.cond) === 'false') continue;

      const old = states.get(edge.to);
      if (!old) {
        states.set(edge.to, edgeState);
      } else {
        const merged = mergeState(old, edgeState);
        if (stateConverged(old, merged)) continue;
        states.set(edge.to, merged);
      }
      if (!queued.has(edge.to)) {
        queued.add(edge.to);
        worklist.push(edge.to);
      }
    }
  }
  return states;
}

// ---------------------------------------------------------------------------
// 第二层：具体状态 DFS + 互斥剪枝
// ---------------------------------------------------------------------------

type ConcreteState = Map<string, FlagValue>;

/** existing 是否包含 candidate（candidate 的每个赋值在 existing 中都一致） */
function stateSubsumes(existing: ConcreteState, candidate: ConcreteState): boolean {
  for (const [k, v] of candidate) {
    if (existing.get(k) !== v) return false;
  }
  return true;
}

interface DfsResult {
  reachableEndings: Set<string>;
  witness: Map<string, string[]>;
  /** 具体 DFS 中被互斥规则真实剪掉的边（精确信号，非过近似） */
  mutexConflicts: {
    edge: CfgEdge;
    group: MutexGroup;
    fromScene: string;
    /** 被阻断的目标段所在场景 */
    targetScene: string;
    /** 触发冲突的旗标 */
    flag: string;
  }[];
  visitedSegments: Set<string>;
  visitedScenes: Set<string>;
}

/** 反向收集：从目标段向后走，汇总所有入口边上的条件与互斥组占用线索 */
interface BackwardInfo {
  /** 进入目标的所有条件边（含来源段） */
  condEdges: { edge: CfgEdge; fromSeg: string }[];
  /** 反向可达段集合（用于定位赋值位置） */
  reachableSegs: Set<string>;
}

function backwardCollect(graph: SegmentGraph, targetSegId: string): BackwardInfo {
  const condEdges: BackwardInfo['condEdges'] = [];
  const reachableSegs = new Set<string>();
  const queue = [targetSegId];
  reachableSegs.add(targetSegId);
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of graph.edgesIn.get(id) ?? []) {
      if (e.cond) condEdges.push({ edge: e, fromSeg: e.from });
      if (!reachableSegs.has(e.from)) {
        reachableSegs.add(e.from);
        queue.push(e.from);
      }
    }
  }
  return { condEdges, reachableSegs };
}

function evalConcrete(state: ConcreteState, expr: CondExpr): boolean {
  switch (expr.kind) {
    case 'atom': {
      const c = expr.cond;
      const actual = state.get(c.flag) ?? defaultFor(c.value);
      return cmp(actual, c.op, c.value);
    }
    case 'and':
      return expr.children.every((ch) => evalConcrete(state, ch));
    case 'or':
      return expr.children.some((ch) => evalConcrete(state, ch));
  }
}

function defaultFor(v: FlagValue): FlagValue {
  if (typeof v === 'boolean') return false;
  if (typeof v === 'number') return 0;
  return '';
}

function cmp(a: FlagValue, op: Condition['op'], b: FlagValue): boolean {
  switch (op) {
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    case '>':
      return a > b;
    case '<':
      return a < b;
    case '>=':
      return a >= b;
    case '<=':
      return a <= b;
  }
}

function dfsReachability(
  script: CompiledScript,
  graph: SegmentGraph,
  abstractStates: Map<string, AbsState>,
  perSceneCap: number,
): DfsResult {
  const flagToMutex = new Map<string, MutexGroup>();
  for (const mg of script.mutexGroups) {
    for (const f of mg.flags) flagToMutex.set(f, mg);
  }

  const result: DfsResult = {
    reachableEndings: new Set(),
    witness: new Map(),
    mutexConflicts: [],
    visitedSegments: new Set(),
    visitedScenes: new Set(),
  };
  /** 每段保留的具体状态（用于包含判断） */
  const seen = new Map<string, ConcreteState[]>();
  /** 每段已见过的状态签名，O(1) 精确去重 */
  const seenSigs = new Map<string, Set<string>>();

  /** 稳定签名：按旗标名排序后拼接，相同具体状态必然同签名 */
  const signature = (s: ConcreteState): string => {
    const keys = [...s.keys()].sort();
    let out = '';
    for (const k of keys) out += `${k}=${String(s.get(k))};`;
    return out;
  };

  interface Frame {
    seg: string;
    /** 进入该段并已应用段内赋值后的状态 */
    state: ConcreteState;
    path: string[];
    edgeIdx: number;
  }

  /** 应用段内顺序赋值，带互斥剪枝；冲突时返回冲突组与触发旗标 */
  const applySegmentSets = (
    seg: Segment,
    incoming: ConcreteState,
  ): { state: ConcreteState; conflict?: MutexGroup; conflictFlag?: string } => {
    const state = new Map(incoming);
    for (const asg of seg.sets) {
      const group = flagToMutex.get(asg.flag);
      if (group && asg.value === true) {
        const clash = group.flags.some((f) => f !== asg.flag && state.get(f) === true);
        if (clash) return { state, conflict: group, conflictFlag: asg.flag };
      }
      state.set(asg.flag, asg.value);
    }
    return { state };
  };

  const stack: Frame[] = [];

  const pushFrame = (segId: string, incoming: ConcreteState, path: string[]): boolean => {
    const seg = graph.segments.get(segId)!;
    const { state, conflict, conflictFlag } = applySegmentSets(seg, incoming);
    if (conflict) {
      const e = graph.edgesOut.get(segId)?.[0];
      if (e) {
        result.mutexConflicts.push({
          edge: e,
          group: conflict,
          fromScene: seg.scene,
          targetScene: seg.scene,
          flag: conflictFlag ?? '',
        });
      }
      return false;
    }
    const sig = signature(state);
    const sigSet = seenSigs.get(segId);
    if (sigSet?.has(sig)) return false;

    const seenList = seen.get(segId) ?? [];
    // 签名未命中时再做包含判断（处理"新状态是旧状态子集"的情况）
    if (seenList.some((s) => stateSubsumes(s, state))) {
      if (sigSet) sigSet.add(sig);
      else seenSigs.set(segId, new Set([sig]));
      return false;
    }
    if (seenList.length >= perSceneCap) return false;

    seen.set(segId, [...seenList, state]);
    if (sigSet) sigSet.add(sig);
    else seenSigs.set(segId, new Set([sig]));
    stack.push({ seg: segId, state, path: [...path, seg.scene], edgeIdx: 0 });
    return true;
  };

  const entrySeg = graph.segOfSceneEntry.get(script.entry)!;
  pushFrame(entrySeg, new Map(), []);

  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    const seg = graph.segments.get(frame.seg)!;
    result.visitedSegments.add(frame.seg);
    result.visitedScenes.add(seg.scene);

    const term = seg.terminator;
    if (term.kind === 'ending') {
      if (!result.reachableEndings.has(term.id)) {
        result.reachableEndings.add(term.id);
        result.witness.set(term.id, [...frame.path]);
      }
      stack.pop();
      continue;
    }

    const edges = graph.edgesOut.get(frame.seg) ?? [];
    if (frame.edgeIdx >= edges.length) {
      stack.pop();
      continue;
    }
    const edge = edges[frame.edgeIdx]!;
    frame.edgeIdx++;

    // 抽象层快速排除死边
    const absHere = abstractStates.get(frame.seg);
    if (edge.cond && absHere && evalCondAbstract(absHere, edge.cond) === 'false') continue;
    // 具体条件
    if (edge.cond && !evalConcrete(frame.state, edge.cond)) continue;

    // 应用边上的选项赋值，带互斥剪枝
    const edgeState = new Map(frame.state);
    let conflict: MutexGroup | undefined;
    let conflictFlag = '';
    for (const asg of edge.sets) {
      const group = flagToMutex.get(asg.flag);
      if (group && asg.value === true) {
        const clash = group.flags.some((f) => f !== asg.flag && edgeState.get(f) === true);
        if (clash) {
          conflict = group;
          conflictFlag = asg.flag;
          break;
        }
      }
      edgeState.set(asg.flag, asg.value);
    }
    if (conflict) {
      result.mutexConflicts.push({
        edge,
        group: conflict,
        fromScene: seg.scene,
        targetScene: graph.segments.get(edge.to)!.scene,
        flag: conflictFlag,
      });
      continue;
    }

    pushFrame(edge.to, edgeState, frame.path);
  }

  return result;
}

// ---------------------------------------------------------------------------
// 死分支检测
// ---------------------------------------------------------------------------

function findDeadBranches(
  graph: SegmentGraph,
  abstractStates: Map<string, AbsState>,
): DeadBranch[] {
  const out: DeadBranch[] = [];
  for (const [segId, edges] of graph.edgesOut) {
    const state = abstractStates.get(segId);
    const seg = graph.segments.get(segId)!;
    if (!state) {
      // 不可达段：其上的选项全部报死
      for (const edge of edges) {
        if (edge.kind === 'choice') {
          out.push({
            kind: 'choice',
            scene: seg.scene,
            line: edge.line,
            optionText: edge.optionText,
            target: graph.segments.get(edge.to)!.scene,
            blocking: [],
            reasons: [`所在场景 "${seg.scene}" 不可达，没有任何路径能进入该选项`],
          });
        }
      }
      continue;
    }
    for (const edge of edges) {
      if (!edge.cond) continue;
      const tri: Tri = evalCondAbstract(state, edge.cond);
      if (tri === 'false') {
        const blocking = collectFalseAtoms(state, edge.cond);
        out.push({
          kind: edge.kind,
          scene: seg.scene,
          line: edge.line,
          ...(edge.optionText ? { optionText: edge.optionText } : {}),
          target: graph.segments.get(edge.to)!.scene,
          blocking,
          reasons: blocking.length
            ? blocking.map(atomToString)
            : ['条件在所有可达状态下恒不成立'],
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 不可达结局诊断
// ---------------------------------------------------------------------------

function diagnoseUnreachable(
  script: CompiledScript,
  graph: SegmentGraph,
  abstractStates: Map<string, AbsState>,
  dfs: DfsResult,
): UnreachableEnding[] {
  const out: UnreachableEnding[] = [];

  // 前向拓扑可达：某场景（如被互斥剪枝挡住的分支）能流到哪些结局场景
  const forwardCache = new Map<string, Set<string>>();
  const forwardEndingScenes = (startScene: string): Set<string> => {
    const cached = forwardCache.get(startScene);
    if (cached) return cached;
    const reachable = new Set<string>();
    const startSeg = graph.segOfSceneEntry.get(startScene);
    if (!startSeg) {
      forwardCache.set(startScene, reachable);
      return reachable;
    }
    const queue = [startSeg];
    const visited = new Set<string>([startSeg]);
    while (queue.length) {
      const id = queue.shift()!;
      const seg = graph.segments.get(id)!;
      if (seg.terminator.kind === 'ending') reachable.add(seg.scene);
      for (const e of graph.edgesOut.get(id) ?? []) {
        if (!visited.has(e.to)) {
          visited.add(e.to);
          queue.push(e.to);
        }
      }
    }
    forwardCache.set(startScene, reachable);
    return reachable;
  };

  /** 找出其阻断分支能流到该结局的互斥冲突 */
  const conflictForEnding = (endingScene: string) =>
    dfs.mutexConflicts.find((c) => forwardEndingScenes(c.targetScene).has(endingScene));

  for (const ending of script.endings) {
    if (dfs.reachableEndings.has(ending.id)) continue;

    const reasons: string[] = [];
    let missing: Condition[] = [];
    let mutexConflict: UnreachableEnding['mutexConflict'];

    const entrySeg = graph.segOfSceneEntry.get(ending.scene)!;
    const abstractReachable = abstractStates.has(entrySeg);
    const info = backwardCollect(graph, entrySeg);

    if (!abstractReachable) {
      reasons.push(`结局场景 "${ending.scene}" 在控制流图中不可达`);
      for (const { edge, fromSeg } of info.condEdges) {
        const upstream = abstractStates.get(fromSeg);
        if (upstream) {
          const falseAtoms = collectFalseAtoms(upstream, edge.cond!);
          if (falseAtoms.length) {
            missing.push(...falseAtoms);
            reasons.push(
              `来自 "${graph.segments.get(fromSeg)!.scene}" 的入口条件 ${condToString(
                edge.cond!,
              )} 恒不成立：${falseAtoms.map(atomToString).join('、')}`,
            );
          }
        }
      }
      if (info.condEdges.length === 0) {
        reasons.push('该场景没有任何条件入口，也没有无条件入边，是孤儿场景');
      }
    } else {
      // 抽象可达、具体不可达：只信任 DFS 真实剪枝记录（精确，非过近似）
      const realConflict = conflictForEnding(ending.scene);
      if (realConflict) {
        const group = realConflict.group;
        const flags = [...new Set([...group.flags.filter((f) => f !== realConflict.flag), realConflict.flag])];
        mutexConflict = { groupName: group.name, flags };
        reasons.push(
          `到达该结局的具体路径在给旗标 "${realConflict.flag}" 赋值时触发互斥组「${group.name}」：同周目内 ${group.flags
            .map((f) => `"${f}"`)
            .join('、')} 最多只能有一个为 true，该路径被剪枝`,
        );
      }
      // 汇总所有入口边上恒假的原子条件
      for (const { edge, fromSeg } of info.condEdges) {
        const upstream = abstractStates.get(fromSeg);
        if (upstream) {
          const falseAtoms = collectFalseAtoms(upstream, edge.cond!);
          if (falseAtoms.length) {
            missing.push(...falseAtoms);
            reasons.push(
              `入口条件 ${condToString(edge.cond!)} 中无法满足：${falseAtoms
                .map(atomToString)
                .join('、')}`,
            );
          }
        }
      }
      if (!realConflict && missing.length === 0) {
        reasons.push(
          '各条边的条件单独看都可能成立，但不存在一条能同时满足全部条件的具体路径（条件组合互相冲突，或被互斥组约束排除）',
        );
      }
    }

    const seenKey = new Set<string>();
    missing = missing.filter((c) => {
      const k = atomToString(c);
      if (seenKey.has(k)) return false;
      seenKey.add(k);
      return true;
    });

    out.push({
      endingId: ending.id,
      endingName: ending.name,
      scene: ending.scene,
      missing,
      reasons,
      ...(mutexConflict ? { mutexConflict } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export interface AnalyzeOptions {
  /** 每个段保留的具体状态上限，控制菱形分支规模，默认 40 */
  perSegmentCap?: number;
}

export function analyzeReachability(
  script: CompiledScript,
  opts: AnalyzeOptions = {},
): ReachabilityReport {
  const t0 = performance.now();
  const graph = buildSegmentGraph(script);
  const abstractStates = abstractFixpoint(script, graph);
  const dfs = dfsReachability(
    script,
    graph,
    abstractStates,
    opts.perSegmentCap ?? 16,
  );
  const deadBranches = findDeadBranches(graph, abstractStates);
  const unreachable = diagnoseUnreachable(script, graph, abstractStates, dfs);
  const elapsedMs = performance.now() - t0;

  return {
    totalEndings: script.endings.length,
    reachable: script.endings.filter((e) => dfs.reachableEndings.has(e.id)).length,
    unreachable,
    deadBranches,
    elapsedMs,
    visitedScenes: dfs.visitedScenes.size,
  };
}

/** 供 UI/CLI 使用：每个可达结局的一条见证路径（场景名序列） */
export function getWitnessPaths(script: CompiledScript): Map<string, string[]> {
  const graph = buildSegmentGraph(script);
  const abstractStates = abstractFixpoint(script, graph);
  const dfs = dfsReachability(script, graph, abstractStates, 16);
  return dfs.witness;
}

/** UI 分支图使用的场景级邻接表 */
export function buildSceneAdjacency(
  script: CompiledScript,
): { nodes: string[]; edges: { from: string; to: string; label?: string; line: number; cond?: CondExpr }[] } {
  const graph = buildSegmentGraph(script);
  const nodes = Object.keys(script.scenes);
  const edgeMap = new Map<string, { from: string; to: string; label?: string; line: number; cond?: CondExpr }>();
  for (const seg of graph.segments.values()) {
    for (const e of graph.edgesOut.get(seg.id) ?? []) {
      const to = graph.segments.get(e.to)!.scene;
      const key = `${seg.scene}->${to}#${e.line}`;
      if (!edgeMap.has(key)) {
        edgeMap.set(key, {
          from: seg.scene,
          to,
          ...(e.optionText ? { label: e.optionText } : {}),
          line: e.line,
          ...(e.cond ? { cond: e.cond } : {}),
        });
      }
    }
  }
  return { nodes, edges: [...edgeMap.values()] };
}

// 仅用于类型导入自检
export type { ChoiceOption };
