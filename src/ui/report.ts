import type { Store } from './store.ts';
import { analyzeReachability } from '../core/analyzer.ts';
import { atomToString } from '../core/conditions.ts';
import type { ReachabilityReport } from '../core/types.ts';

export class ReportView {
  el: HTMLElement;
  private store: Store;
  private body!: HTMLElement;
  private lastReport: ReachabilityReport | null = null;

  constructor(store: Store) {
    this.store = store;
    this.el = document.createElement('div');
    this.el.className = 'view';
    this.el.id = 'view-report';
    this.el.innerHTML = '<div class="report-wrap" data-role="body"></div>';
    this.body = this.el.querySelector('[data-role=body]')!;
  }

  onActivated() {
    const script = this.store.getScript();
    if (!script) {
      this.body.innerHTML =
        '<div class="empty-hint">剧本存在编译错误，请先在「剧本编辑」页修复后再分析。</div>';
      return;
    }
    this.lastReport = analyzeReachability(script);
    this.render(this.lastReport);
  }

  private render(rep: ReachabilityReport) {
    const ok = rep.unreachable.length === 0 && rep.deadBranches.length === 0;
    this.body.innerHTML = `
      <div class="stat-grid">
        ${stat(rep.totalEndings, '结局总数')}
        ${stat(rep.reachable, '可达结局', 'ok')}
        ${stat(rep.unreachable.length, '不可达结局', rep.unreachable.length ? 'err' : 'ok')}
        ${stat(rep.deadBranches.length, '死分支/死选项', rep.deadBranches.length ? 'warn' : 'ok')}
        ${stat(rep.visitedScenes, '分析覆盖场景')}
        ${stat(rep.elapsedMs.toFixed(1) + ' ms', '分析耗时')}
      </div>

      <div class="section">
        <h2><span class="badge ${ok ? 'ok' : 'err'}">${
          ok ? '全部结局可达' : '存在问题'
        }</span> 总览</h2>
      </div>

      <div class="section">
        <h2>走不到的结局（${rep.unreachable.length}）</h2>
        ${
          rep.unreachable.length === 0
            ? '<div class="empty-hint">所有结局都能走到 ✓</div>'
            : rep.unreachable
                .map(
                  (u) => `
          <div class="card">
            <div class="head">
              <span class="badge err">不可达</span>
              <strong>${escapeHtml(u.endingName)}</strong>
              <span class="mono">id=${escapeHtml(u.endingId)} · 场景=${escapeHtml(
                    u.scene,
                  )}</span>
              ${
                u.mutexConflict
                  ? `<span class="badge warn">互斥冲突：${escapeHtml(
                      u.mutexConflict.groupName,
                    )}</span>`
                  : ''
              }
            </div>
            ${
              u.missing.length
                ? `<div style="margin-top:8px">缺失的旗标条件：
                     ${u.missing
                       .map((c) => `<span class="cond-chip">${escapeHtml(atomToString(c))}</span>`)
                       .join('')}
                   </div>`
                : ''
            }
            <ul class="reason-list">
              ${u.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}
            </ul>
          </div>`,
                )
                .join('')
        }
      </div>

      <div class="section">
        <h2>永远触发不了的选项 / 条件跳转（${rep.deadBranches.length}）</h2>
        ${
          rep.deadBranches.length === 0
            ? '<div class="empty-hint">没有死分支 ✓</div>'
            : rep.deadBranches
                .slice(0, 200)
                .map(
                  (d) => `
          <div class="card">
            <div class="head">
              <span class="badge warn">${d.kind === 'choice' ? '死选项' : '死跳转'}</span>
              <strong>${
                d.optionText ? escapeHtml(d.optionText) : `@if 跳转到 ${escapeHtml(d.target)}`
              }</strong>
              <span class="mono">场景=${escapeHtml(d.scene)} · 第 ${d.line} 行 → ${escapeHtml(
                    d.target,
                  )}</span>
            </div>
            ${
              d.reasons.length
                ? `<ul class="reason-list">${d.reasons
                    .map((r) => `<li>恒假条件：${escapeHtml(r)}</li>`)
                    .join('')}</ul>`
                : `<ul class="reason-list"><li>${d.reasons[0] ? escapeHtml(d.reasons[0]) : '该入口在所有可达状态下都无法成立'}</li></ul>`
            }
          </div>`,
                )
                .join('')
        }
        ${
          rep.deadBranches.length > 200
            ? `<div class="empty-hint">仅展示前 200 条，共 ${rep.deadBranches.length} 条</div>`
            : ''
        }
      </div>`;
  }
}

function stat(num: number | string, label: string, tone: '' | 'ok' | 'err' | 'warn' = '') {
  return `
    <div class="stat-card">
      <div class="num" ${tone ? `style="color:var(--${tone === 'err' ? 'err' : tone === 'warn' ? 'warn' : 'ok'})"` : ''}>${num}</div>
      <div class="lbl">${label}</div>
    </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
