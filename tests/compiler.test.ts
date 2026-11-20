import { describe, expect, it } from 'vitest';
import { compile } from '../src/core/compiler.ts';

const VALID = `
#entry start
#mutex 社团: club_a, club_b
=== start ===
旁白一句。
角色：你好。
@set x = 1
@if x >= 2 -> other
@choice
  + 选项A -> a_scene
  + 隐藏选项 -> b_scene if x >= 10 set y = true
@goto a_scene

=== a_scene ===
@ending end_a A结局

=== b_scene ===
@ending end_b B结局

=== other ===
@goto a_scene
`;

describe('编译器', () => {
  it('成功编译并收集场景/结局/旗标', () => {
    const r = compile(VALID);
    expect(r.ok).toBe(true);
    expect(r.script!.scenes).toHaveProperty('start');
    expect(r.script!.entry).toBe('start');
    expect(r.script!.endings.map((e) => e.id)).toEqual(['end_a', 'end_b']);
    expect(r.script!.flagNames).toContain('x');
    expect(r.script!.mutexGroups[0]!.flags).toEqual(['club_a', 'club_b']);
  });

  it('选项的条件与赋值正确编译', () => {
    const r = compile(VALID);
    const choice = r.script!.instructions.find((i) => i.kind === 'choice')!;
    expect(choice.kind).toBe('choice');
    if (choice.kind === 'choice') {
      expect(choice.options[1]!.cond).toBeDefined();
      expect(choice.options[1]!.sets).toEqual([{ flag: 'y', value: true }]);
    }
  });

  it('错误定位到行号与原始行', () => {
    const bad = `=== start ===
@set = 3
@goto ghost
@ending e x
`;
    const r = compile(bad);
    expect(r.ok).toBe(false);
    const lines = r.errors.map((e) => e.line);
    expect(lines).toContain(2);
    expect(lines).toContain(3);
    expect(r.errors[0]!.sourceLine).toContain('@set');
  });

  it('场景未以控制指令结尾报错', () => {
    const r = compile(`=== s ===
只有台词没有结尾。
`);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('结束'))).toBe(true);
  });

  it('重复场景、未知指令、空 choice 均报错', () => {
    const r = compile(`=== s ===
@choice
@wat
@goto s
=== s ===
@goto s
`);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('未知指令'))).toBe(true);
    expect(r.errors.some((e) => e.message.includes('重复定义'))).toBe(true);
    expect(r.errors.some((e) => e.message.includes('@choice'))).toBe(true);
  });

  it('注释与引号内 // 不冲突', () => {
    const r = compile(`=== s ===
角色：网址是 http://x // 这是注释
@set url = "http://x" // 行尾注释
@goto s
`);
    expect(r.ok).toBe(true);
    const text = r.script!.instructions.find((i) => i.kind === 'text')!;
    if (text.kind === 'text') expect(text.content).toContain('http://x');
  });

  it('从未赋值的旗标产生警告而非错误', () => {
    const r = compile(`=== s ===
@if ghost == true -> s2
@goto s
=== s2 ===
@ending e 终
`);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.message.includes('ghost'))).toBe(true);
  });
});
