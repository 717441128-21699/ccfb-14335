/**
 * 条件表达式：词法分析 + 递归下降解析 + 求值
 *
 * 文法（or 优先级最低，and 次之）：
 *   or   := and ('or' and)*
 *   and  := atom ('and' atom)*
 *   atom := '(' or ')' | flag op value
 */
import type { CondExpr, Condition, FlagValue, Op } from './types';

// ---------------------------------------------------------------------------
// 词法
// ---------------------------------------------------------------------------

type Token =
  | { t: 'lparen' | 'rparen' | 'and' | 'or'; pos: number }
  | { t: 'atom'; cond: Condition; pos: number; end: number };

const OPS: { op: Op; symbol: string }[] = [
  { op: '>=', symbol: '>=' },
  { op: '<=', symbol: '<=' },
  { op: '!=', symbol: '!=' },
  { op: '==', symbol: '==' },
  { op: '>', symbol: '>' },
  { op: '<', symbol: '<' },
];

const IDENT_RE = /[A-Za-z_一-龥][A-Za-z0-9_一-龥]*/y;

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_一-龥]/.test(ch);
}

class LexError extends Error {
  constructor(
    message: string,
    public pos: number,
  ) {
    super(message);
  }
}
export { LexError };

/** 解析右值字面量：true/false、数字、带引号字符串、裸标识符字符串 */
export function parseValueLiteral(src: string, pos: number): { value: FlagValue; next: number } {
  return parseLiteral(src, pos);
}

/** 解析右值字面量：true/false、数字、带引号字符串、裸标识符字符串 */
function parseLiteral(src: string, pos: number): { value: FlagValue; next: number } {
  const ch = src[pos];
  if (ch === '"' || ch === "'") {
    const quote = ch;
    let j = pos + 1;
    let out = '';
    while (j < src.length && src[j] !== quote) {
      if (src[j] === '\\' && j + 1 < src.length) {
        const esc = src[j + 1];
        out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
        j += 2;
      } else {
        out += src[j];
        j++;
      }
    }
    if (src[j] !== quote) throw new LexError('字符串缺少结束引号', pos);
    return { value: out, next: j + 1 };
  }
  // 数字字面量（含负号、小数），必须在裸标识符分支之前判断
  const numMatch = /^-?\d+(\.\d+)?/.exec(src.slice(pos));
  if (numMatch) {
    return { value: Number(numMatch[0]), next: pos + numMatch[0].length };
  }
  let j = pos;
  while (j < src.length && isIdentChar(src[j] as string)) j++;
  const word = src.slice(pos, j);
  if (word === '') throw new LexError('缺少条件右值', pos);
  if (word === 'true') return { value: true, next: j };
  if (word === 'false') return { value: false, next: j };
  // 裸标识符作为字符串值
  return { value: word, next: j };
}

function tokenize(src: string, line: number): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const skipSpaces = () => {
    while (i < src.length && /\s/.test(src[i] as string)) i++;
  };
  while (i < src.length) {
    skipSpaces();
    if (i >= src.length) break;
    const ch = src[i] as string;
    if (ch === '(') {
      tokens.push({ t: 'lparen', pos: i });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ t: 'rparen', pos: i });
      i++;
      continue;
    }
    IDENT_RE.lastIndex = i;
    const m = IDENT_RE.exec(src);
    if (!m) throw new LexError(`无法识别的字符 "${ch}"`, i);
    const word = m[0];
    const wordStart = i;
    i += word.length;
    if (word === 'and' || word === 'or') {
      // 必须作为独立单词（后面不是标识符字符）
      if (i < src.length && isIdentChar(src[i] as string)) {
        throw new LexError(`关键字 ${word} 后缺少空格`, wordStart);
      }
      tokens.push({ t: word, pos: wordStart });
      continue;
    }
    // 原子：flag op value
    skipSpaces();
    let matched: { op: Op; symbol: string } | undefined;
    for (const o of OPS) {
      if (src.startsWith(o.symbol, i)) {
        matched = o;
        break;
      }
    }
    if (!matched) throw new LexError(`旗标 "${word}" 后缺少比较运算符`, i);
    const opPos = i;
    i += matched.symbol.length;
    skipSpaces();
    const lit = parseLiteral(src, i);
    tokens.push({
      t: 'atom',
      pos: wordStart,
      end: lit.next,
      cond: { flag: word, op: matched.op, value: lit.value, line },
    });
    i = lit.next;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// 递归下降解析
// ---------------------------------------------------------------------------

class ParseError extends Error {
  constructor(
    message: string,
    public pos: number,
  ) {
    super(message);
  }
}
export { ParseError };

export function parseCondition(src: string, line: number): CondExpr {
  const tokens = tokenize(src, line);
  if (tokens.length === 0) throw new ParseError('条件不能为空', 0);
  let idx = 0;
  const peek = (): Token | undefined => tokens[idx];
  const next = (): Token => {
    const tk = tokens[idx];
    if (!tk) throw new ParseError('条件表达式不完整', src.length);
    idx++;
    return tk;
  };

  function parseOr(): CondExpr {
    const children = [parseAnd()];
    while (peek()?.t === 'or') {
      next();
      children.push(parseAnd());
    }
    return children.length === 1 ? children[0]! : { kind: 'or', children };
  }

  function parseAnd(): CondExpr {
    const children = [parseAtom()];
    while (peek()?.t === 'and') {
      next();
      children.push(parseAtom());
    }
    return children.length === 1 ? children[0]! : { kind: 'and', children };
  }

  function parseAtom(): CondExpr {
    const tk = next();
    if (tk.t === 'lparen') {
      const inner = parseOr();
      const close = next();
      if (close.t !== 'rparen') throw new ParseError('缺少右括号 ")"', close.pos);
      return inner;
    }
    if (tk.t === 'atom') return { kind: 'atom', cond: tk.cond };
    throw new ParseError('此处应为条件表达式', tk.pos);
  }

  const expr = parseOr();
  if (idx < tokens.length) {
    throw new ParseError('条件表达式存在多余内容', tokens[idx]!.pos);
  }
  return expr;
}

// ---------------------------------------------------------------------------
// 具体求值（引擎运行时用）
// ---------------------------------------------------------------------------

/** 未设置的旗标按右值类型取默认值：bool->false, number->0, string->'' */
function defaultOf(v: FlagValue): FlagValue {
  if (typeof v === 'boolean') return false;
  if (typeof v === 'number') return 0;
  return '';
}

function compare(actual: FlagValue, op: Op, expected: FlagValue): boolean {
  switch (op) {
    case '==':
      return actual === expected;
    case '!=':
      return actual !== expected;
    case '>':
      return actual > expected;
    case '<':
      return actual < expected;
    case '>=':
      return actual >= expected;
    case '<=':
      return actual <= expected;
  }
}

export function evalAtomConcrete(flags: Readonly<Record<string, FlagValue>>, c: Condition): boolean {
  const actual = flags[c.flag] ?? defaultOf(c.value);
  return compare(actual, c.op, c.value);
}

export function evalCondConcrete(
  flags: Readonly<Record<string, FlagValue>>,
  expr: CondExpr,
): boolean {
  switch (expr.kind) {
    case 'atom':
      return evalAtomConcrete(flags, expr.cond);
    case 'and':
      return expr.children.every((ch) => evalCondConcrete(flags, ch));
    case 'or':
      return expr.children.some((ch) => evalCondConcrete(flags, ch));
  }
}

// ---------------------------------------------------------------------------
// 抽象求值（可达性分析用）：三值 true / false / unknown
// ---------------------------------------------------------------------------

/** 抽象域：一组常量值，或 top（任意值） */
export type AbsValue = { top: true } | { top: false; values: FlagValue[] };
export type AbsState = Map<string, AbsValue>;

export const ABS_TRUE: AbsValue = { top: false, values: [true] };
export const ABS_FALSE: AbsValue = { top: false, values: [false] };
export const ABS_TOP: AbsValue = { top: true };

export function absConst(v: FlagValue): AbsValue {
  return { top: false, values: [v] };
}

/** 合并两个抽象值：集合求并，超过 8 个离散值退化为 top */
export function mergeAbsValue(a: AbsValue, b: AbsValue): AbsValue {
  if (a.top || b.top) return ABS_TOP;
  const merged: FlagValue[] = [];
  for (const v of [...a.values, ...b.values]) {
    if (!merged.some((x) => x === v)) merged.push(v);
  }
  if (merged.length > 8) return ABS_TOP;
  return { top: false, values: merged };
}

export function mergeState(a: AbsState, b: AbsState): AbsState {
  const out: AbsState = new Map(a);
  for (const [k, v] of b) {
    const old = out.get(k);
    out.set(k, old ? mergeAbsValue(old, v) : v);
  }
  return out;
}

function stateLessOrEqual(weak: AbsState, strong: AbsState): boolean {
  // strong 的信息不少于 weak：对每个 key，strong 能推出 weak 的全部取值
  for (const [k, wv] of weak) {
    const sv = strong.get(k);
    if (!sv) return false;
    if (sv.top) continue;
    if (wv.top) return false;
    for (const v of wv.values) {
      if (!sv.values.includes(v)) return false;
    }
  }
  return true;
}

/** 不动点判断：newState 相对 oldState 没有变"宽"则已收敛 */
export function stateConverged(oldS: AbsState, newS: AbsState): boolean {
  return stateLessOrEqual(newS, oldS) && stateLessOrEqual(oldS, newS);
}

export type Tri = 'true' | 'false' | 'unknown';

function evalAtomAbstract(state: AbsState, c: Condition): Tri {
  const abs = state.get(c.flag);
  let values: FlagValue[];
  let top: boolean;
  if (!abs) {
    values = [defaultOf(c.value)];
    top = false;
  } else if (abs.top) {
    values = [];
    top = true;
  } else {
    values = abs.values;
    top = false;
  }
  const results = top ? [true, false] : values.map((v) => compare(v, c.op, c.value));
  const anyTrue = results.includes(true);
  const anyFalse = results.includes(false);
  if (anyTrue && !anyFalse) return 'true';
  if (!anyTrue && anyFalse) return 'false';
  return 'unknown';
}

export function evalCondAbstract(state: AbsState, expr: CondExpr): Tri {
  switch (expr.kind) {
    case 'atom':
      return evalAtomAbstract(state, expr.cond);
    case 'and': {
      let hasUnknown = false;
      for (const ch of expr.children) {
        const r = evalCondAbstract(state, ch);
        if (r === 'false') return 'false';
        if (r === 'unknown') hasUnknown = true;
      }
      return hasUnknown ? 'unknown' : 'true';
    }
    case 'or': {
      let hasUnknown = false;
      for (const ch of expr.children) {
        const r = evalCondAbstract(state, ch);
        if (r === 'true') return 'true';
        if (r === 'unknown') hasUnknown = true;
      }
      return hasUnknown ? 'unknown' : 'false';
    }
  }
}

/** 收集表达式里所有求值为 false 的原子条件（用于诊断"缺什么旗标"） */
export function collectFalseAtoms(state: AbsState, expr: CondExpr): Condition[] {
  const out: Condition[] = [];
  const walk = (e: CondExpr) => {
    switch (e.kind) {
      case 'atom':
        if (evalAtomAbstract(state, e.cond) === 'false') out.push(e.cond);
        break;
      case 'and':
      case 'or':
        e.children.forEach(walk);
    }
  };
  walk(expr);
  return out;
}

// ---------------------------------------------------------------------------
// 表达式里出现的全部旗标
// ---------------------------------------------------------------------------

export function flagsInExpr(expr: CondExpr): string[] {
  const out = new Set<string>();
  const walk = (e: CondExpr) => {
    switch (e.kind) {
      case 'atom':
        out.add(e.cond.flag);
        break;
      case 'and':
      case 'or':
        e.children.forEach(walk);
    }
  };
  walk(expr);
  return [...out];
}

// ---------------------------------------------------------------------------
// 人类可读格式化
// ---------------------------------------------------------------------------

export function atomToString(c: Condition): string {
  const v =
    typeof c.value === 'string' ? `"${c.value}"` : String(c.value);
  return `${c.flag} ${c.op} ${v}`;
}

export function condToString(expr: CondExpr): string {
  switch (expr.kind) {
    case 'atom':
      return atomToString(expr.cond);
    case 'and':
      return expr.children.map(condToString).join(' 且 ');
    case 'or':
      return `(${expr.children.map(condToString).join(' 或 ')})`;
  }
}
