/**
 * 可达性分析性能基准：生成大剧本 -> 编译 -> 全结局可达性分析
 * 目标：30 万字 / 2000 旗标规模下，10 秒内跑完。
 */
import { compile } from '../src/core/compiler.ts';
import { analyzeReachability } from '../src/core/analyzer.ts';
import { generateStressScript } from './gen-stress.ts';

const t0 = performance.now();
const source = generateStressScript();
const genMs = performance.now() - t0;

const t1 = performance.now();
const result = compile(source);
const compileMs = performance.now() - t1;

if (!result.ok || !result.script) {
  console.error('编译失败：', result.errors.slice(0, 10));
  process.exit(1);
}
const script = result.script;

const t2 = performance.now();
const report = analyzeReachability(script);
const analyzeMs = performance.now() - t2;

const charCount = [...source].length;
console.log('============ 压测结果 ============');
console.log(`剧本字符数      : ${charCount.toLocaleString()}`);
console.log(`旗标种类        : ${script.flagNames.length.toLocaleString()}`);
console.log(`场景数          : ${Object.keys(script.scenes).length.toLocaleString()}`);
console.log(`指令数          : ${script.instructions.length.toLocaleString()}`);
console.log(`结局总数        : ${report.totalEndings}`);
console.log(`可达结局        : ${report.reachable}`);
console.log(`不可达结局      : ${report.unreachable.length}`);
console.log(`死分支数        : ${report.deadBranches.length}`);
console.log('----------------------------------');
console.log(`生成耗时        : ${genMs.toFixed(1)} ms`);
console.log(`编译耗时        : ${compileMs.toFixed(1)} ms`);
console.log(`分析耗时        : ${analyzeMs.toFixed(1)} ms  (要求 < 10000ms)`);
console.log(`分析器自报耗时  : ${report.elapsedMs.toFixed(1)} ms`);
console.log('==================================');

// 不可达结局是否给出了缺失旗标
const withMissing = report.unreachable.filter((u) => u.missing.length > 0).length;
console.log(`不可达结局中带缺失旗标诊断的: ${withMissing}/${report.unreachable.length}`);
if (report.unreachable[0]) {
  console.log('示例诊断:', report.unreachable[0].reasons[0]);
}

const withinBudget = analyzeMs < 10000;
console.log(withinBottom(withinBudget));
if (!withinBudget) process.exit(2);

function withinBottom(ok: boolean): string {
  return ok ? '✓ 满足 10 秒预算' : '✗ 超出 10 秒预算';
}
