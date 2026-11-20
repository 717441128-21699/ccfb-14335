import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compile } from '../src/core/compiler.ts';
import { Engine, type EngineEvent } from '../src/core/engine.ts';

const SCRIPT = `#entry s1
=== s1 ===
旁白第一句。
林夏：你好。
@set flag_a = true
@choice
  + 去结局A -> s2
  + 隐藏路线 -> s3 if secret == true
=== s2 ===
普通路线。
@ending end_a A
=== s3 ===
隐藏路线。
@ending end_b B
`;

function makeEngine() {
  const r = compile(SCRIPT);
  expect(r.ok).toBe(true);
  return new Engine(r.script!, { storage: null, autoDelayMs: 50, skipDelayMs: 10 });
}

describe('运行时引擎', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('逐句推进并记录历史', () => {
    const eng = makeEngine();
    const events: EngineEvent[] = [];
    eng.on((e) => events.push(e));
    eng.start();
    const texts = events.filter((e) => e.type === 'text');
    expect(texts).toHaveLength(1);
    eng.next();
    expect(eng.getHistory()).toHaveLength(2);
    expect(eng.getHistory()[1]!.speaker).toBe('林夏');
  });

  it('条件不满足的选项被隐藏', () => {
    const eng = makeEngine();
    let choiceEvent: EngineEvent | undefined;
    eng.on((e) => {
      if (e.type === 'choice') choiceEvent = e;
    });
    eng.start();
    eng.next(); // 第二句
    eng.next(); // set 后到 choice
    expect(choiceEvent!.type).toBe('choice');
    if (choiceEvent!.type === 'choice') {
      expect(choiceEvent.options).toHaveLength(2);
      expect(choiceEvent.options[1]!.visible).toBe(false);
      expect(() => eng.choose(1)).toThrow();
      eng.choose(0);
    }
    expect(eng.getScene()).toBe('s2');
  });

  it('走到结局', () => {
    const eng = makeEngine();
    let ending: EngineEvent | undefined;
    eng.on((e) => e.type === 'ending' && (ending = e));
    eng.start();
    eng.next();
    eng.next();
    eng.choose(0);
    eng.next();
    expect(ending).toMatchObject({ type: 'ending', id: 'end_a' });
    expect(eng.isEnded()).toBe(true);
  });

  it('存档/读档恢复状态与历史', () => {
    const storage = new Map<string, string>();
    const mockStorage: Storage = {
      get length() {
        return storage.size;
      },
      clear: () => storage.clear(),
      getItem: (k) => storage.get(k) ?? null,
      key: (i) => [...storage.keys()][i] ?? null,
      removeItem: (k) => void storage.delete(k),
      setItem: (k, v) => void storage.set(k, v),
    };
    const r = compile(SCRIPT);
    const eng = new Engine(r.script!, { storage: mockStorage });
    eng.start();
    eng.next();
    const slot = eng.save('slot1', '测试存档');
    expect(slot.scene).toBe('s1');
    expect(slot.history.length).toBeGreaterThan(0);

    const eng2 = new Engine(r.script!, { storage: mockStorage });
    const loaded = eng2.load('slot1');
    expect(loaded).not.toBeNull();
    expect(eng2.getHistory()).toHaveLength(slot.history.length);
    expect(eng2.getFlags().flag_a).toBe(true);
  });

  it('自动播放遇到选项自动停止', () => {
    const eng = makeEngine();
    eng.start();
    eng.startAuto();
    expect(eng.isAutoOn()).toBe(true);
    vi.advanceTimersByTime(500);
    // 推进到 choice 后自动停
    expect(eng.isWaitingChoice()).toBe(true);
    expect(eng.isAutoOn()).toBe(false);
  });

  it('跳过已读：选项处会停下，全已读后快速通过文本', () => {
    const eng = makeEngine();
    eng.start();
    eng.next();
    eng.next();
    // 此时停在 choice：skip 启动后第一个 tick 即自动停止
    eng.startSkip();
    vi.advanceTimersByTime(50);
    expect(eng.isSkipOn()).toBe(false);
    expect(eng.isWaitingChoice()).toBe(true);

    const eng2 = makeEngine();
    eng2.markAllRead();
    eng2.start();
    eng2.startSkip();
    vi.advanceTimersByTime(1000);
    // 一路跳过文本直到选项
    expect(eng2.isWaitingChoice()).toBe(true);
    expect(eng2.isSkipOn()).toBe(false);
  });

  it('可从任意场景开始试玩并预置旗标', () => {
    const eng = makeEngine();
    eng.startAt('s3', { secret: true });
    expect(eng.getScene()).toBe('s3');
  });
});

describe('运行时互斥守卫', () => {
  const SRC = `#entry s
#mutex 社团: club_a, club_b
=== s ===
@choice
  + 加入A -> a set club_a = true
  + 加入B -> b set club_b = true
=== a ===
@choice
  + 再拿B资格 -> ab set club_b = true
  + 安分 -> gate
=== b ===
@goto gate
=== ab ===
@goto gate
=== gate ===
@if club_a == true and club_b == true -> end_bad
@goto end_ok
=== end_bad ===
@ending e_bad 坏
=== end_ok ===
@ending e_ok 好
`;

  it('同周目互斥旗标第二个 true 赋值被拒绝并发出事件', () => {
    const r = compile(SRC);
    expect(r.ok).toBe(true);
    const eng = new Engine(r.script!, { storage: null });
    const violations: string[] = [];
    eng.on((e) => {
      if (e.type === 'mutex-violation') violations.push(e.flag);
    });
    let ending: EngineEvent | undefined;
    eng.on((e) => e.type === 'ending' && (ending = e));
    eng.start();
    eng.choose(0); // 加入A
    eng.choose(0); // 试图再拿B —— 应被互斥守卫拦截
    expect(violations).toEqual(['club_b']);
    expect(eng.getFlags().club_b).toBeUndefined();
    // 因此坏结局不可达，落到好结局
    eng.next();
    expect(ending).toMatchObject({ type: 'ending', id: 'e_ok' });
  });
});
