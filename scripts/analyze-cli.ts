/**
 * 命令行可达性分析：
 *   npx tsx scripts/analyze-cli.ts scripts/sample.vns
 * 输出编译结果与全结局可达性报告，适合接 CI（有不可达结局或死分支时退出码非 0）。
 */
import { readFileSync } from 'node:fs';
import { compile } from '../src/core/compiler.ts';
import { analyzeReachability } from '../src/core/analyzer.ts';
import { atomToString } from '../src/core/conditions.ts';

const path = process.argv[2];
if (!path) {
  console.error('用法: tsx scripts/analyze-cli.ts <剧本文件.vns>');
  process.exit(64);
}

const source = readFileSync(path, 'utf8');
const compiled = compile(source);

if (!compiled.ok || !compiled.script) {
  console.error(`编译失败，共 ${compiled.errors.length} 个错误：`);
  for (const e of compiled.errors) {
    console.error(`  第 ${e.line} 行:${e.column}  ${e.message}`);
    if (e.sourceLine) console.error(`    > ${e.sourceLine}`);
  }
  process.exit(1);
}

for (const w of compiled.warnings) {
  console.warn(`[警告] 第 ${w.line} 行  ${w.message}`);
}

const report = analyzeReachability(compiled.script);

console.log('');
console.log('================ 可达性分析报告 ================');
console.log(`结局总数   : ${report.totalEndings}`);
console.log(`可达       : ${report.reachable}`);
console.log(`不可达     : ${report.unreachable.length}`);
console.log(`死分支     : ${report.deadBranches.length}`);
console.log(`覆盖场景   : ${report.visitedScenes}`);
console.log(`耗时       : ${report.elapsedMs.toFixed(1)} ms`);
console.log('');

if (report.unreachable.length) {
  console.log('—— 不可达结局 ——');
  for (const u of report.unreachable) {
    console.log(`✗ ${u.endingName} (${u.endingId}) @场景 ${u.scene}`);
    if (u.mutexConflict) {
      console.log(`    互斥冲突组「${u.mutexConflict.groupName}」: ${u.mutexConflict.flags.join(', ')}`);
    }
    if (u.missing.length) {
      console.log(`    缺失条件: ${u.missing.map(atomToString).join(' ; ')}`);
    }
    for (const r of u.reasons) console.log(`    - ${r}`);
  }
  console.log('');
}

if (report.deadBranches.length) {
  console.log('—— 死分支/死选项（前 20 条）——');
  for (const d of report.deadBranches.slice(0, 20)) {
    const what = d.optionText ?? `-> ${d.target}`;
    console.log(
      `✗ [${d.kind}] 场景 ${d.scene} 第 ${d.line} 行 "${what}"  ${d.reasons.join(' / ')}`,
    );
  }
  if (report.deadBranches.length > 20) {
    console.log(`  ... 其余 ${report.deadBranches.length - 20} 条见网页报告`);
  }
  console.log('');
}

const hasProblem = report.unreachable.length > 0 || report.deadBranches.length > 0;
console.log(hasProblem ? '结论：存在不可达内容，需修改剧本' : '结论：全部结局可达，无死分支 ✓');
process.exit(hasProblem ? 2 : 0);
