import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/core/compiler.ts';
import {
  analyzeReachability,
  getWitnessPaths,
  buildSceneAdjacency,
} from '../src/core/analyzer.ts';

const here = dirname(fileURLToPath(import.meta.url));
const sampleSource = readFileSync(resolve(here, '../scripts/sample.vns'), 'utf8');

describe('可达性分析（示例剧本）', () => {
  const compiled = compile(sampleSource);
  it('示例剧本本身编译通过', () => {
    expect(compiled.ok, JSON.stringify(compiled.errors, null, 2)).toBe(true);
  });

  const report = analyzeReachability(compiled.script!);

  it('7 个结局中 5 个可达、2 个不可达', () => {
    expect(report.totalEndings).toBe(7);
    expect(report.reachable).toBe(5);
    expect(report.unreachable.map((u) => u.endingId).sort()).toEqual([
      'end_bad',
      'end_impossible',
    ]);
  });

  it('不可达坏结局指出缺失的旗标条件 dropped_out == true', () => {
    const bad = report.unreachable.find((u) => u.endingId === 'end_bad')!;
    expect(bad.missing.some((c) => c.flag === 'dropped_out')).toBe(true);
    expect(bad.reasons.join(' ')).toContain('dropped_out');
  });

  it('互斥结局报告互斥组冲突，而不是误报成可达', () => {
    const imp = report.unreachable.find((u) => u.endingId === 'end_impossible')!;
    expect(imp.mutexConflict).toBeDefined();
    expect([...imp.mutexConflict!.flags].sort()).toEqual(['club_music', 'club_sports'].sort());
  });

  it('死选项被识别：天文社入口 affinity_lin>=2 恒不成立', () => {
    const dead = report.deadBranches.find((d) => d.target === 'club_hidden_gate');
    expect(dead).toBeDefined();
    expect(dead!.reasons.some((r) => r.includes('affinity_lin'))).toBe(true);
  });

  it('互斥转会选项的条件边本身不恒假（由具体层剪枝），抽象层不谎报', () => {
    const dead = report.deadBranches.find((d) => d.target === 'transfer_scene');
    expect(dead).toBeUndefined();
  });

  it('见证路径与场景邻接图可生成', () => {
    const witness = getWitnessPaths(compiled.script!);
    expect(witness.get('end_lin')).toContain('ending_lin');
    const adj = buildSceneAdjacency(compiled.script!);
    expect(adj.nodes.length).toBeGreaterThan(10);
    expect(adj.edges.some((e) => e.from === 'day1' && e.to === 'club_music_route')).toBe(true);
  });
});

describe('互斥剪枝（独立小剧本）', () => {
  const src = `#entry s
#mutex 社团: club_a, club_b
=== s ===
@choice
  + 加入A -> a set club_a = true
  + 加入B -> b set club_b = true
=== a ===
@choice
  + 同时拿B的资格 -> ab set club_b = true
  + 安分守己 -> gate
=== b ===
@goto gate
=== ab ===
@goto gate
=== gate ===
@if club_a == true and club_b == true -> end_ab
@if club_a == true -> end_a
@goto end_b
=== end_ab ===
@ending e_ab 双社团
=== end_a ===
@ending e_a 单A
=== end_b ===
@ending e_b 其他
`;

  it('双社团结局不可达且带互斥诊断，单社团结局可达', () => {
    const r = compile(src);
    expect(r.ok).toBe(true);
    const rep = analyzeReachability(r.script!);
    expect(rep.reachable).toBe(2);
    const ab = rep.unreachable.find((u) => u.endingId === 'e_ab');
    expect(ab).toBeDefined();
    expect(ab!.mutexConflict!.groupName).toBe('社团');
  });
});

describe('循环与状态合并的收敛性', () => {
  const src = `#entry s
=== s ===
@set n = 0
@goto loop
=== loop ===
@set n = 1
@if n >= 5 -> end_scene
@goto loop
=== end_scene ===
@ending e 终
`;
  it('自循环不会让分析挂死，恒假条件被识别为死分支', () => {
    const r = compile(src);
    expect(r.ok).toBe(true);
    const rep = analyzeReachability(r.script!, { perSegmentCap: 10 });
    expect(rep.elapsedMs).toBeLessThan(2000);
    expect(rep.deadBranches.some((d) => d.target === 'end_scene')).toBe(true);
    expect(rep.unreachable.map((u) => u.endingId)).toEqual(['e']);
  });
});
