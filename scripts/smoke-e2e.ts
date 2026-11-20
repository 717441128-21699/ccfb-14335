/**
 * 端到端冒烟：编译示例剧本 -> 引擎真实枚举每条选项路径 ->
 * 与可达性分析器的结论交叉校验，并验证存档/读档、自动播放等运行时能力。
 */
import { readFileSync } from 'node:fs';
import { compile } from '../src/core/compiler.ts';
import { Engine, type EngineEvent } from '../src/core/engine.ts';
import { analyzeReachability } from '../src/core/analyzer.ts';

const r = compile(readFileSync('./scripts/sample.vns', 'utf8'));
if (!r.ok || !r.script) {
  console.error(r.errors);
  process.exit(1);
}

const endings = new Set<string>();
let playthroughs = 0;
const MAX_STEPS = 300;

function runOne(choicePath: number[]): number {
  const eng = new Engine(r.script!, { storage: null });
  const events: EngineEvent[] = [];
  eng.on((e) => events.push(e));
  eng.start();

  let choiceCount = 0;
  let steps = 0;
  while (!eng.isEnded() && steps++ < MAX_STEPS) {
    if (eng.isWaitingChoice()) {
      const opts = eng.getAvailableOptions()!.filter((o) => o.visible);
      const pick = choicePath[choiceCount] ?? 0;
      choiceCount++;
      eng.choose(opts[Math.min(pick, opts.length - 1)]!.index);
    } else {
      eng.next();
    }
  }
  playthroughs++;
  const endEvt = events.find((e) => e.type === 'ending');
  if (endEvt?.type === 'ending') endings.add(endEvt.id);
  return choiceCount;
}

const totalChoicePoints = runOne([]);
for (let mask = 0; mask < 3 ** totalChoicePoints; mask++) {
  const path: number[] = [];
  let m = mask;
  for (let i = 0; i < totalChoicePoints; i++) {
    path.push(m % 3);
    m = Math.floor(m / 3);
  }
  runOne(path);
}

const report = analyzeReachability(r.script);
const analyzerReachable = new Set(
  r.script.endings
    .filter((e) => !report.unreachable.some((u) => u.endingId === e.id))
    .map((e) => e.id),
);
const onlyAnalyzer = [...analyzerReachable].filter((x) => !endings.has(x));
const onlyEngine = [...endings].filter((x) => !analyzerReachable.has(x));

console.log('枚举的试玩局数:', playthroughs);
console.log('引擎走到的结局  :', [...endings].sort());
console.log('分析器可达结局  :', [...analyzerReachable].sort());
console.log('仅分析器可达    :', onlyAnalyzer);
console.log('仅引擎走到      :', onlyEngine);

// 存档/读档
const eng = new Engine(r.script!, { storage: null });
eng.start();
eng.next();
eng.next();
const slot = eng.save('s1', '冒烟存档');
const eng2 = new Engine(r.script!, { storage: null });
eng2.restoreSlot(slot);
const historyOk = eng2.getHistory().length === slot.history.length;
console.log('存档/读档历史一致:', historyOk ? '✓' : '✗');

// 自动播放开关
const eng3 = new Engine(r.script!, { storage: null, autoDelayMs: 5 });
eng3.start();
eng3.startAuto();
const autoOk = eng3.isAutoOn();
eng3.stopAuto();
console.log('自动播放开关:', autoOk ? '✓' : '✗');

if (onlyAnalyzer.length || onlyEngine.length || !historyOk || !autoOk) {
  console.error('✗ 端到端冒烟失败：引擎与分析器结论不一致或运行时能力异常');
  process.exit(1);
}
console.log(`✓ 端到端冒烟通过：${endings.size} 个可达结局，引擎与分析器完全一致`);
