import { describe, expect, it } from 'vitest';
import { parseCondition, evalCondConcrete, evalCondAbstract, ABS_TOP } from '../src/core/conditions.ts';

describe('条件表达式解析', () => {
  it('解析原子条件', () => {
    const e = parseCondition('flag == true', 1);
    expect(e).toEqual({ kind: 'atom', cond: { flag: 'flag', op: '==', value: true, line: 1 } });
  });

  it('and 优先级高于 or', () => {
    const e = parseCondition('a == true or b == false and c >= 3', 1);
    expect(e.kind).toBe('or');
    if (e.kind === 'or') {
      expect(e.children[1]!.kind).toBe('and');
    }
  });

  it('括号改变结合性', () => {
    const e = parseCondition('(a == true or b == true) and c == "x"', 1);
    expect(e.kind).toBe('and');
  });

  it('支持字符串、数字、中文旗标', () => {
    const e = parseCondition('好感度 >= 10 and 姓名 == "林夏"', 1);
    expect(evalCondConcrete({ 好感度: 12, 姓名: '林夏' }, e)).toBe(true);
    expect(evalCondConcrete({ 好感度: 2, 姓名: '林夏' }, e)).toBe(false);
  });

  it('解析错误带位置信息', () => {
    expect(() => parseCondition('a == ', 1)).toThrow();
    expect(() => parseCondition('a and', 1)).toThrow();
    expect(() => parseCondition('(a == true', 1)).toThrow();
  });

  it('未设置旗标按默认值判定', () => {
    const e = parseCondition('x == false', 1);
    expect(evalCondConcrete({}, e)).toBe(true);
    const e2 = parseCondition('n >= 1', 1);
    expect(evalCondConcrete({}, e2)).toBe(false);
  });

  it('抽象三值求值', () => {
    const e = parseCondition('a == true and b == true', 1);
    // 未设置的布尔旗标按默认值 false 处理，所以整条 and 恒 false
    const s1 = new Map([['a', { top: false, values: [true] }]]);
    expect(evalCondAbstract(s1, e)).toBe('false');
    const s2 = new Map([
      ['a', { top: false, values: [true] }],
      ['b', { top: false, values: [false] }],
    ]);
    expect(evalCondAbstract(s2, e)).toBe('false');
    // 显式置为 top（可能 true 也可能 false）时为 unknown
    const s3 = new Map([['a', ABS_TOP]]);
    expect(evalCondAbstract(s3, parseCondition('a == true', 1))).toBe('unknown');
    // 多值集合同时包含使条件真/假的取值
    const s4 = new Map([['a', { top: false, values: [true, false] }]]);
    expect(evalCondAbstract(s4, parseCondition('a == true', 1))).toBe('unknown');
  });
});
