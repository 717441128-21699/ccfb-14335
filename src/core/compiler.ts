/**
 * 剧本编译器：.vns 文本 -> CompiledScript
 *
 * 语法速览（详见 README）：
 *   #entry 场景名
 *   #mutex 组名: flag1, flag2, flag3
 *   === 场景名 ===
 *   旁白文本
 *   角色：台词
 *   @set flag = 值
 *   @if 条件 -> 目标场景
 *   @goto 目标场景
 *   @choice
 *     + 选项文本 -> 目标 [if 条件] [set a=1, b=true]
 *   @ending ending_id 结局显示名
 */
import {
  LexError,
  ParseError,
  flagsInExpr,
  parseCondition,
  parseValueLiteral,
} from './conditions';
import type {
  ChoiceOption,
  CompileError,
  CompileResult,
  CompiledScene,
  CompiledScript,
  CondExpr,
  FlagValue,
  Instruction,
  MutexGroup,
} from './types';

const IDENT_RE = /^[A-Za-z_一-龥][A-Za-z0-9_一-龥]*$/;

interface RawScene {
  name: string;
  line: number;
  instructions: Instruction[];
}

/** 去掉行尾注释：要求 // 前是行首或空白，避免误伤 http:// 这类 URL */
function stripComment(line: string): string {
  let inQuote: string | null = null;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i]!;
    if (inQuote) {
      if (ch === '\\') i++;
      else if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === '/' && line[i + 1] === '/') {
      const prev = line[i - 1];
      if (prev === undefined || /\s/.test(prev)) return line.slice(0, i);
    }
  }
  return line;
}

function splitArrow(rest: string): number {
  let inQuote: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") inQuote = ch;
    if (ch === '-' && rest[i + 1] === '>') return i;
    if (ch === '→') return i;
  }
  return -1;
}

/** 在行里查找关键字 if / set 的边界（引号外、独立单词） */
function findKeyword(s: string, kw: 'if' | 'set', from = 0): number {
  let inQuote: string | null = null;
  for (let i = from; i < s.length; i++) {
    const ch = s[i]!;
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") inQuote = ch;
    if (ch === kw[0] && s.startsWith(kw, i)) {
      const before = s[i - 1];
      const after = s[i + kw.length];
      const bound = (c: string | undefined) => c === undefined || /\s/.test(c);
      if (bound(before) && bound(after)) return i;
    }
  }
  return -1;
}

function parseFlagAssign(
  body: string,
  line: number,
  errors: CompileError[],
  sourceLine: string,
): { flag: string; value: FlagValue }[] {
  const out: { flag: string; value: FlagValue }[] = [];
  for (const part of splitTopLevel(body, ',')) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      errors.push(mkErr(line, 1, `赋值 "${part.trim()}" 缺少 "="`, sourceLine));
      continue;
    }
    const flag = part.slice(0, eq).trim();
    if (!IDENT_RE.test(flag)) {
      errors.push(mkErr(line, 1, `非法旗标名 "${flag}"`, sourceLine));
      continue;
    }
    const valSrc = part.slice(eq + 1).trim();
    const lit = safeParseValue(valSrc, line, errors, sourceLine);
    if (lit !== undefined) out.push({ flag, value: lit });
  }
  return out;
}

/** 按分隔符切分，忽略引号内的分隔符 */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let inQuote: string | null = null;
  let buf = '';
  for (const ch of s) {
    if (inQuote) {
      buf += ch;
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      buf += ch;
    } else if (ch === sep) {
      out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  out.push(buf);
  return out;
}

function safeParseValue(
  src: string,
  line: number,
  errors: CompileError[],
  sourceLine: string,
): FlagValue | undefined {
  try {
    const r = parseValueLiteral(src, 0);
    if (r.next < src.length) {
      errors.push(mkErr(line, r.next + 1, `数值 "${src}" 后面有多余内容`, sourceLine));
      return undefined;
    }
    return r.value;
  } catch (e) {
    const pos = e instanceof LexError ? e.pos : 0;
    errors.push(mkErr(line, pos + 1, (e as Error).message, sourceLine));
    return undefined;
  }
}

function mkErr(line: number, column: number, message: string, sourceLine: string): CompileError {
  return { line, column, message, sourceLine };
}

function parseDialogue(text: string): { speaker: string; content: string } {
  const m = /^([^：:]{1,20})[：:]([\s\S]+)$/.exec(text);
  if (m && !/\s/.test(m[1]!)) {
    return { speaker: m[1]!, content: m[2]!.trim() };
  }
  return { speaker: '', content: text };
}

export function compile(source: string): CompileResult {
  const errors: CompileError[] = [];
  const warnings: CompileError[] = [];
  const rawLines = source.replace(/^﻿/, '').split(/\r?\n/);

  const config = { entry: '' as string, mutexes: [] as MutexGroup[] };
  const scenes: RawScene[] = [];
  const sceneNames = new Set<string>();

  let current: RawScene | null = null;
  /** 待闭合的 @choice 块 */
  let pendingChoice: { line: number; options: ChoiceOption[]; sourceLine: string } | null =
    null;

  const flushChoice = () => {
    if (!pendingChoice || !current) {
      pendingChoice = null;
      return;
    }
    if (pendingChoice.options.length === 0) {
      errors.push(
        mkErr(pendingChoice.line, 1, '@choice 块至少要有一个 "+" 选项', pendingChoice.sourceLine),
      );
    }
    current.instructions.push({
      kind: 'choice',
      options: pendingChoice.options,
      line: pendingChoice.line,
    });
    pendingChoice = null;
  };

  const requireScene = (line: number, sourceLine: string): RawScene | null => {
    if (!current) {
      errors.push(mkErr(line, 1, '可执行内容必须放在 === 场景 === 块内', sourceLine));
      return null;
    }
    return current;
  };

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const original = rawLines[i]!;
    const noComment = stripComment(original);
    const trimmed = noComment.trim();
    if (trimmed === '') continue;

    // ---- 配置区 ----
    if (trimmed.startsWith('#')) {
      if (scenes.length > 0 || current) {
        errors.push(mkErr(lineNo, 1, '# 配置声明必须位于所有场景之前', original));
        continue;
      }
      const body = trimmed.slice(1).trim();
      if (body.startsWith('entry')) {
        const name = body.slice(5).trim();
        if (!IDENT_RE.test(name)) {
          errors.push(mkErr(lineNo, 8, `非法入口场景名 "${name}"`, original));
        }
        config.entry = name;
      } else if (body.startsWith('mutex')) {
        const rest = body.slice(5).trim();
        const colon = rest.search(/[:：]/);
        const gname = colon >= 0 ? rest.slice(0, colon).trim() : `mutex_${config.mutexes.length + 1}`;
        const flagsSrc = colon >= 0 ? rest.slice(colon + 1) : rest;
        const flags = flagsSrc
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (flags.length < 2) {
          errors.push(mkErr(lineNo, 1, '#mutex 至少要声明两个互斥旗标', original));
        }
        for (const f of flags) {
          if (!IDENT_RE.test(f)) errors.push(mkErr(lineNo, 1, `非法旗标名 "${f}"`, original));
        }
        config.mutexes.push({ name: gname, flags, line: lineNo });
      } else if (body.startsWith('title')) {
        // 标题仅作元信息，忽略
      } else {
        errors.push(mkErr(lineNo, 1, `未知配置指令 "#${body}"`, original));
      }
      continue;
    }

    // ---- 场景头 ----
    if (trimmed.startsWith('===')) {
      flushChoice();
      const name = trimmed.replace(/^=+/, '').replace(/=+$/, '').trim();
      if (!IDENT_RE.test(name)) {
        errors.push(mkErr(lineNo, 1, `非法场景名 "${name}"`, original));
      } else if (sceneNames.has(name)) {
        errors.push(mkErr(lineNo, 1, `场景 "${name}" 重复定义`, original));
      } else {
        sceneNames.add(name);
      }
      current = { name, line: lineNo, instructions: [] };
      scenes.push(current);
      continue;
    }

    // ---- 选项行（属于待闭合 choice 块） ----
    if (trimmed.startsWith('+')) {
      if (!pendingChoice) {
        errors.push(mkErr(lineNo, 1, '"+" 选项必须紧跟在 @choice 块内', original));
        continue;
      }
      const optScene = requireScene(lineNo, original);
      if (!optScene) continue;
      const rest = trimmed.slice(1).trim();
      const arrow = splitArrow(rest);
      if (arrow < 0) {
        errors.push(mkErr(lineNo, 1, '选项缺少 "->" 目标场景', original));
        continue;
      }
      const text = rest.slice(0, arrow).trim();
      if (text === '') {
        errors.push(mkErr(lineNo, 1, '选项文本不能为空', original));
      }
      let tail = rest.slice(arrow + (rest[arrow] === '→' ? 1 : 2)).trim();
      let cond: CondExpr | undefined;
      let sets: { flag: string; value: FlagValue }[] = [];

      const ifPos = findKeyword(tail, 'if');
      const setPos = findKeyword(tail, 'set');
      let targetEnd = tail.length;
      if (ifPos >= 0 && (setPos < 0 || ifPos < setPos)) {
        targetEnd = ifPos;
        const condEnd = setPos >= 0 ? setPos : tail.length;
        const condSrc = tail.slice(ifPos + 2, condEnd).trim();
        cond = tryParseCond(condSrc, lineNo, original, errors);
      } else if (setPos >= 0) {
        targetEnd = setPos;
      }
      if (setPos >= 0) {
        const setBody = tail.slice(setPos + 3).trim();
        sets = parseFlagAssign(setBody, lineNo, errors, original);
      }
      const target = tail.slice(0, targetEnd).trim();
      if (!IDENT_RE.test(target)) {
        errors.push(mkErr(lineNo, 1, `选项目标场景名 "${target}" 非法`, original));
      }
      pendingChoice.options.push({ text, target, cond, sets, line: lineNo });
      continue;
    }

    // 非选项行到达，闭合 choice 块
    flushChoice();
    const scene = requireScene(lineNo, original);
    if (!scene) continue;

    // ---- 指令 ----
    if (trimmed.startsWith('@')) {
      const sp = trimmed.search(/\s/);
      const keyword = sp < 0 ? trimmed.slice(1) : trimmed.slice(1, sp);
      const body = sp < 0 ? '' : trimmed.slice(sp + 1);
      switch (keyword) {
        case 'set': {
          const eq = body.indexOf('=');
          if (eq < 0) {
            errors.push(mkErr(lineNo, 1, '@set 语法：@set flag = 值', original));
            break;
          }
          const flag = body.slice(0, eq).trim();
          if (!IDENT_RE.test(flag)) {
            errors.push(mkErr(lineNo, 1, `非法旗标名 "${flag}"`, original));
            break;
          }
          const valSrc = body.slice(eq + 1).trim();
          const val = safeParseValue(valSrc, lineNo, errors, original);
          if (val !== undefined) scene.instructions.push({ kind: 'set', flag, value: val, line: lineNo });
          break;
        }
        case 'goto': {
          const target = body.trim();
          if (!IDENT_RE.test(target)) {
            errors.push(mkErr(lineNo, 1, `@goto 目标场景名 "${target}" 非法`, original));
            break;
          }
          scene.instructions.push({ kind: 'goto', target, cond: undefined, line: lineNo });
          break;
        }
        case 'if': {
          const arrow = splitArrow(body);
          if (arrow < 0) {
            errors.push(mkErr(lineNo, 1, '@if 语法：@if 条件 -> 场景', original));
            break;
          }
          const condSrc = body.slice(0, arrow).trim();
          const target = body
            .slice(arrow + (body[arrow] === '→' ? 1 : 2))
            .trim();
          if (!IDENT_RE.test(target)) {
            errors.push(mkErr(lineNo, 1, `@if 目标场景名 "${target}" 非法`, original));
            break;
          }
          const cond = tryParseCond(condSrc, lineNo, original, errors);
          if (cond) scene.instructions.push({ kind: 'goto', target, cond, line: lineNo });
          break;
        }
        case 'choice': {
          if (body.trim() !== '') {
            errors.push(mkErr(lineNo, 1, '@choice 不接受参数，选项写在后续 "+" 行', original));
          }
          pendingChoice = { line: lineNo, options: [], sourceLine: original };
          break;
        }
        case 'ending': {
          const parts = body.trim().split(/\s+/);
          const id = parts[0] ?? '';
          if (!IDENT_RE.test(id)) {
            errors.push(mkErr(lineNo, 1, `@ending 语法：@ending ending_id [显示名]`, original));
            break;
          }
          const name = parts.slice(1).join(' ') || id;
          scene.instructions.push({ kind: 'ending', id, name, line: lineNo });
          break;
        }
        default:
          errors.push(mkErr(lineNo, 1, `未知指令 "@${keyword}"`, original));
      }
      continue;
    }

    // ---- 普通台词 / 旁白 ----
    const { speaker, content } = parseDialogue(trimmed);
    scene.instructions.push({ kind: 'text', speaker, content, line: lineNo });
  }
  flushChoice();

  if (scenes.length === 0) {
    errors.push(mkErr(1, 1, '剧本中没有任何 === 场景 ===', source.length ? rawLines[0] ?? '' : ''));
    return { ok: false, script: null, errors, warnings };
  }

  // ---- 语义校验 ----
  const entry = config.entry || scenes[0]!.name;
  if (!sceneNames.has(entry)) {
    errors.push(mkErr(1, 1, `入口场景 "${entry}" 不存在`, ''));
  }

  const endingIds = new Set<string>();
  const setFlags = new Set<string>();
  const usedFlags = new Set<string>();
  const referencedScenes = new Set<string>([entry]);

  for (const sc of scenes) {
    const last = sc.instructions[sc.instructions.length - 1];
    if (!last || (last.kind !== 'goto' && last.kind !== 'choice' && last.kind !== 'ending')) {
      errors.push(
        mkErr(
          sc.line,
          1,
          `场景 "${sc.name}" 没有以 @goto/@choice/@ending 结束，剧情会在这里中断`,
          rawLines[sc.line - 1] ?? '',
        ),
      );
    }
    for (const ins of sc.instructions) {
      if (ins.kind === 'set') setFlags.add(ins.flag);
      if (ins.kind === 'goto') {
        referencedScenes.add(ins.target);
        if (ins.cond) flagsInExpr(ins.cond).forEach((f) => usedFlags.add(f));
        if (!sceneNames.has(ins.target)) {
          errors.push(
            mkErr(ins.line, 1, `场景 "${sc.name}" 跳转到不存在的场景 "${ins.target}"`, rawLines[ins.line - 1] ?? ''),
          );
        }
      }
      if (ins.kind === 'choice') {
        for (const opt of ins.options) {
          referencedScenes.add(opt.target);
          if (!sceneNames.has(opt.target)) {
            errors.push(
              mkErr(opt.line, 1, `选项跳转到不存在的场景 "${opt.target}"`, rawLines[opt.line - 1] ?? ''),
            );
          }
          if (opt.cond) flagsInExpr(opt.cond).forEach((f) => usedFlags.add(f));
          for (const s of opt.sets) setFlags.add(s.flag);
        }
      }
      if (ins.kind === 'ending' && endingIds.has(ins.id)) {
        errors.push(mkErr(ins.line, 1, `结局 id "${ins.id}" 重复`, rawLines[ins.line - 1] ?? ''));
      }
      if (ins.kind === 'ending') endingIds.add(ins.id);
    }
  }

  for (const f of usedFlags) {
    if (!setFlags.has(f)) {
      warnings.push(mkErr(0, 0, `旗标 "${f}" 只在条件中出现、从未赋值，将永远按默认值判定`, ''));
    }
  }
  for (const mg of config.mutexes) {
    for (const f of mg.flags) {
      usedFlags.add(f);
      if (!setFlags.has(f)) {
        warnings.push(mkErr(mg.line, 1, `互斥旗标 "${f}" 从未赋值`, rawLines[mg.line - 1] ?? ''));
      }
    }
    const dup = mg.flags.filter((f, idx) => mg.flags.indexOf(f) !== idx);
    if (dup.length) {
      errors.push(mkErr(mg.line, 1, `互斥组 "${mg.name}" 内旗标重复：${[...new Set(dup)].join(', ')}`, rawLines[mg.line - 1] ?? ''));
    }
  }
  for (const sc of scenes) {
    if (!referencedScenes.has(sc.name)) {
      warnings.push(mkErr(sc.line, 1, `场景 "${sc.name}" 没有任何入口引用，可能是孤儿场景`, rawLines[sc.line - 1] ?? ''));
    }
  }

  if (errors.length > 0) {
    errors.sort((a, b) => a.line - b.line || a.column - b.column);
    return { ok: false, script: null, errors, warnings };
  }

  // ---- 打平为全局指令序列 ----
  const instructions: Instruction[] = [];
  const compiledScenes: Record<string, CompiledScene> = {};
  const endings: CompiledScript['endings'] = [];
  for (const sc of scenes) {
    const start = instructions.length;
    instructions.push(...sc.instructions);
    compiledScenes[sc.name] = { name: sc.name, start, end: instructions.length, line: sc.line };
    for (const ins of sc.instructions) {
      if (ins.kind === 'ending') {
        endings.push({ id: ins.id, name: ins.name, scene: sc.name });
      }
    }
  }

  const flagNames = [...new Set<string>([...setFlags, ...usedFlags])].sort();

  const script: CompiledScript = {
    instructions,
    scenes: compiledScenes,
    entry,
    mutexGroups: config.mutexes,
    flagNames,
    endings,
  };
  return { ok: true, script, errors: [], warnings };
}

function tryParseCond(
  condSrc: string,
  line: number,
  sourceLine: string,
  errors: CompileError[],
): CondExpr | undefined {
  if (condSrc === '') {
    errors.push(mkErr(line, 1, 'if 后缺少条件表达式', sourceLine));
    return undefined;
  }
  try {
    return parseCondition(condSrc, line);
  } catch (e) {
    const pos = e instanceof LexError || e instanceof ParseError ? e.pos : 0;
    // 条件位于行内，给出大致列号
    const col = sourceLine.indexOf(condSrc) + pos + 1;
    errors.push(mkErr(line, col > 0 ? col : 1, (e as Error).message, sourceLine));
    return undefined;
  }
}
