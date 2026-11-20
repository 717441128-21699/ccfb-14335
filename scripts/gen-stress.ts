/**
 * 压力测试剧本生成器
 *
 * 生成一个约 30 万字、2000 旗标的大型剧本：
 * - N 个章节，每章一个多选项菱形分支（汇入下一章）
 * - 每个选项独立旗标 + 随机条件门
 * - M 个互斥组（每组 3 个社团式旗标）
 * - 结尾按累积旗标组合判定 K 个结局，其中故意混入若干不可达结局
 */
interface GenOptions {
  chapters: number;
  optionsPerChapter: number;
  mutexGroups: number;
  endings: number;
  linesPerScene: number;
}

const DEFAULT: GenOptions = {
  chapters: 200,
  optionsPerChapter: 10,
  mutexGroups: 200, // 200 组 × 每组 ~10 旗标 ≈ 2000 互斥旗标
  endings: 40,
  linesPerScene: 12, // 每条分支场景的台词行数
};

function pad(n: number, width = 4): string {
  return String(n).padStart(width, '0');
}

export function generateStressScript(opts: GenOptions = DEFAULT): string {
  const { chapters, optionsPerChapter, mutexGroups, endings, linesPerScene } = opts;
  const out: string[] = [];

  out.push('#title 压测剧本');
  out.push('#entry ch0000_hub');
  // 互斥组：每组 3 个旗标，编号连续
  for (let g = 0; g < mutexGroups; g++) {
    const base = g * 3;
    out.push(
      `#mutex 互斥组${pad(g, 3)}: mx_${pad(base)}, mx_${pad(base + 1)}, mx_${pad(base + 2)}`,
    );
  }
  out.push('');

  let flagCounter = 0;
  const nextFlag = () => `fl_${pad(flagCounter++, 4)}`;

  for (let ch = 0; ch < chapters; ch++) {
    const hub = `ch${pad(ch)}_hub`;
    const nextHub = ch + 1 < chapters ? `ch${pad(ch + 1)}_hub` : 'final_gate';

    // 枢纽场景：章节开场旁白 + 选项
    out.push(`=== ${hub} ===`);
    out.push(`【第 ${ch + 1} 章】夜色沉沉，城市的灯火在雨后泛着光。`);
    for (let l = 0; l < 3; l++) out.push(`旁白：章节 ${ch + 1} 的开场叙述第 ${l + 1} 段，渲染氛围与人物心境。`);
    out.push('@choice');
    for (let o = 0; o < optionsPerChapter; o++) {
      const branch = `ch${pad(ch)}_opt${pad(o, 2)}`;
      const condFlag = `gate_${pad(ch)}_${pad(o, 2)}`;
      // 部分选项带条件门（条件旗标在其他分支里被设置，制造复杂可达性）
      if (o % 3 === 2) {
        out.push(`  + 第${o + 1}个选择 -> ${branch} if ${condFlag} == true set ${nextFlag()} = true`);
      } else {
        out.push(`  + 第${o + 1}个选择 -> ${branch} set ${nextFlag()} = true`);
      }
    }
    out.push('');

    // 每个选项分支：若干台词 + 赋值 + 汇合
    for (let o = 0; o < optionsPerChapter; o++) {
      const branch = `ch${pad(ch)}_opt${pad(o, 2)}`;
      out.push(`=== ${branch} ===`);
      for (let l = 0; l < linesPerScene; l++) {
        out.push(`角色${pad(o, 2)}：这是第 ${ch + 1} 章分支 ${o + 1} 的第 ${l + 1} 句台词，用来撑起剧本字数。`);
      }
      // 互斥旗标：把部分分支挂到互斥组上（每组 3 个旗标，编号连续）
      if (o < 3 && ch % 5 === 0) {
        const g = (ch / 5) % mutexGroups;
        const flagIdx = g * 3 + o;
        out.push(`@set mx_${pad(flagIdx)} = true`);
      }
      // 章节计分
      out.push(`@set score_${pad(ch)} = ${o + 1}`);
      if (o % 4 === 0) out.push(`@set ${nextFlag()} = ${ch * 10 + o}`);
      out.push(`@goto ${nextHub}`);
      out.push('');
    }
  }

  // 最终判定门：一串条件 @if 分流到各结局
  out.push('=== final_gate ===');
  out.push('所有的选择都已成为过往，终幕即将拉开。');
  for (let e = 0; e < endings; e++) {
    // 前 N-3 个结局用可达条件；最后 3 个引用永不赋值的旗标（故意不可达）
    if (e < endings - 3) {
      const refChap = (e * 7) % chapters;
      const refOpt = (e * 3) % optionsPerChapter;
      out.push(`@if score_${pad(refChap)} >= ${refOpt + 1} -> ending_${pad(e)}`);
    } else {
      out.push(`@if ghost_${pad(e)} == true -> ending_${pad(e)}`);
    }
  }
  out.push('@goto ending_default');
  out.push('');

  // 结局场景
  for (let e = 0; e < endings; e++) {
    out.push(`=== ending_${pad(e)} ===`);
    out.push(`结局 ${e + 1}：命运的齿轮停在了这一格。`);
    for (let l = 0; l < 6; l++) out.push(`旁白：结局 ${e + 1} 的收束叙述第 ${l + 1} 段。`);
    out.push(`@ending end_${pad(e)} 结局${e + 1}`);
    out.push('');
  }
  out.push('=== ending_default ===');
  out.push('平凡的终幕，也是一种答案。');
  out.push('@ending end_default 默认结局');

  return out.join('\n');
}

// 直接运行时输出统计
if (process.argv[1] && process.argv[1].endsWith('gen-stress.ts')) {
  const src = generateStressScript();
  const chars = [...src].length;
  const flagSet = new Set(src.match(/fl_\d+|mx_\d+_[abc]|score_\d+|gate_\d+_\d+|ghost_\d+/g) ?? []);
  console.log(`字符数: ${chars}`);
  console.log(`旗标种类(近似): ${flagSet.size}`);
  console.log(`场景数(近似): ${(src.match(/=== /g) ?? []).length}`);
}
