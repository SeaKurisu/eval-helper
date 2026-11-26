// ==UserScript==
// @name         一键评教助手 (Eval Helper)
// @namespace    https://github.com/SeaKurisu/eval-helper
// @author       SeaKurisu
// @license      MIT
// @homepageURL  https://github.com/SeaKurisu/eval-helper
// @updateURL    https://raw.githubusercontent.com/SeaKurisu/eval-helper/main/eval-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/SeaKurisu/eval-helper/main/eval-helper.user.js
// @version      0.1.0
// @description  学评教一键批量评价：接口直提，跳过前端倒计时；站点适配器可扩展
// @match        http://jwzxm.cqupt.edu.cn/mjwzx2022/xpj2025/*
// @match        https://jwzxm.cqupt.edu.cn/mjwzx2022/xpj2025/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* =====================================================================
   * 1. 站点适配器（Profile）
   *    新学校/新系统只需新增一个 profile，实现 4 个方法：
   *      listTasks()          -> [{ key, title, remaining, raw }]
   *      getForm(task)        -> { items: [{ id, label, group, max }], hasMemo }
   *      submit(task, form, answers, memo) -> { ok, msg }
   *      isTimeError(msg)     -> 服务端是否因“停留时间不足”拒绝
   *    以及可选的 minWaitSec（服务端若校验停留时长时使用）。
   * ===================================================================== */
  const PROFILES = [
    {
      id: 'cqupt-xpj2025',
      name: '重庆邮电大学 学评教 2025',
      match: /\/mjwzx2022\/xpj2025\//,
      requiredTimes: 2,
      minWaitSec: 60,
      base() {
        return location.origin + location.pathname.replace(/html\/.*$/, '');
      },
      async api(method, path, data) {
        const url = new URL(path, this.base());
        const init = { method, credentials: 'include', headers: {} };
        if (method === 'GET' && data) {
          Object.entries(data).forEach(([k, v]) => url.searchParams.set(k, v ?? ''));
        } else if (data) {
          init.headers['Content-Type'] = 'application/json';
          init.body = JSON.stringify(data);
        }
        const res = await fetch(url, init);
        if (res.status === 401) throw new Error('登录已失效，请刷新页面重新登录');
        const json = await res.json();
        return json; // { code, data, info }
      },
      async listTasks() {
        const r = await this.api('GET', 'index.php', { action: 'stuGetRw' });
        if (r.code !== 0) throw new Error(r.info || '获取课程列表失败');
        return (r.data || [])
          .map((c) => ({
            key: `${c.jxb}|${c.teaId}`,
            title: `${c.kcmc} - ${c.teaName}`,
            done: c.pjNum,
            remaining: Math.max(0, this.requiredTimes - (c.pjNum || 0)),
            raw: c,
          }));
      },
      async getForm(task) {
        const c = task.raw;
        const r = await this.api('GET', 'index.php', {
          action: 'stuGetJxbZb', jxb: c.jxb, teaId: c.teaId, pjCs: '',
        });
        if (r.code !== 0) throw new Error(r.info || '获取评价指标失败');
        const items = [];
        Object.entries(r.data || {}).forEach(([group, arr]) => {
          if (group === 'memo' || !Array.isArray(arr)) return;
          arr.forEach((it) => items.push({ id: it.orderNum, label: it.info, group, max: 10 }));
        });
        items.sort((a, b) => a.id - b.id);
        return { items, hasMemo: true, fetchedAt: Date.now() };
      },
      async submit(task, form, answers, memo) {
        const c = task.raw;
        const r = await this.api('POST', 'post.php', {
          action: 'stuPj',
          jxb: c.jxb,
          teaId: c.teaId,
          scoreDetail: form.items.map((it) => ({ orderNum: it.id, score: answers[it.id] })),
          memoDetail: memo || null,
        });
        return { ok: r.code === 0, msg: r.info || (r.code === 0 ? '成功' : `code=${r.code}`) };
      },
      isTimeError(msg) {
        return /秒|时间|太快|频繁|稍后/.test(msg || '');
      },
    },
  ];

  const profile = PROFILES.find((p) => p.match.test(location.href));
  if (!profile) return;

  /* =====================================================================
   * 2. 通用：打分策略
   * ===================================================================== */
  const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

  function makeAnswers(items, opt) {
    const ans = {};
    items.forEach((it) => {
      const max = it.max || 10;
      const v = opt.mode === 'range'
        ? randInt(Math.min(opt.min, opt.max), Math.max(opt.min, opt.max))
        : opt.fixed;
      ans[it.id] = Math.max(1, Math.min(max, v));
    });
    if (opt.notAllSame && items.length > 1) {
      const vals = Object.values(ans);
      if (vals.every((v) => v === vals[0])) {
        const pick = items[randInt(0, items.length - 1)];
        ans[pick.id] = ans[pick.id] > 1 ? ans[pick.id] - 1 : ans[pick.id] + 1;
      }
    }
    return ans;
  }

  function pickMemo(text) {
    const lines = (text || '').split('\n').map((s) => s.trim()).filter(Boolean);
    return lines.length ? lines[randInt(0, lines.length - 1)] : null;
  }

  /* =====================================================================
   * 3. 通用：页面倒计时加速（备用方案，对页面自带的评价弹窗生效）
   *    把 ≥1s 的 setInterval 加速，只在开关打开时生效。
   * ===================================================================== */
  const LS_KEY = 'evalHelper:' + profile.id;
  const loadOpt = () => {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
  };
  const saveOpt = (o) => { try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch {} };

  const opt = Object.assign({
    mode: 'fixed', fixed: 10, min: 9, max: 10, notAllSame: false,
    memo: '', speedUpTimer: true, delayMs: 300,
  }, loadOpt());

  const nativeSetInterval = window.setInterval;
  window.setInterval = function (fn, ms, ...rest) {
    if (opt.speedUpTimer && typeof ms === 'number' && ms >= 1000) ms = Math.max(5, ms / 100);
    return nativeSetInterval.call(this, fn, ms, ...rest);
  };

  /* =====================================================================
   * 4. 通用：执行引擎
   * ===================================================================== */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function buildPlan(log) {
    const tasks = (await profile.listTasks()).filter((t) => t.remaining > 0);
    log(`待评课程 ${tasks.length} 门，共需提交 ${tasks.reduce((s, t) => s + t.remaining, 0)} 次`);
    return tasks;
  }

  async function runTasks(tasks, { limit = Infinity, dryRun = false } = {}, log) {
    let sent = 0, okCount = 0;
    const failed = [];
    for (const task of tasks) {
      for (let n = 0; n < task.remaining && sent < limit; n++) {
        sent++;
        const form = await profile.getForm(task);
        const answers = makeAnswers(form.items, opt);
        const memo = pickMemo(opt.memo);
        const scoreStr = form.items.map((it) => answers[it.id]).join(',');
        if (dryRun) {
          log(`[预览] ${task.title}（第${task.done + n + 1}次）：${scoreStr}${memo ? ' / ' + memo : ''}`);
          continue;
        }
        let r = await profile.submit(task, form, answers, memo);
        if (!r.ok && profile.isTimeError(r.msg) && profile.minWaitSec) {
          const waitMs = form.fetchedAt + profile.minWaitSec * 1000 + 2000 - Date.now();
          log(`服务端要求停留时长（${r.msg}），等待 ${Math.ceil(waitMs / 1000)} 秒后重试…`);
          if (waitMs > 0) await sleep(waitMs);
          r = await profile.submit(task, form, answers, memo);
        }
        if (r.ok) { okCount++; log(`✅ ${task.title}：${scoreStr}`); }
        else { failed.push(task.title); log(`❌ ${task.title}：${r.msg}`); }
        await sleep(opt.delayMs);
      }
      if (sent >= limit) break;
    }
    if (!dryRun) log(`完成：成功 ${okCount}，失败 ${failed.length}`);
    return { okCount, failed };
  }

  /* =====================================================================
   * 5. UI（Shadow DOM，避免与页面样式冲突）
   * ===================================================================== */
  function mountUI() {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:12px;bottom:72px;z-index:2147483647;';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host{font:13px/1.5 -apple-system,"PingFang SC",sans-serif;color:#222}
        .fab{background:#006633;color:#fff;border:none;border-radius:22px;padding:10px 16px;
             box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer;font-size:14px}
        .panel{display:none;width:min(340px,calc(100vw - 24px));max-height:75vh;overflow:auto;background:#fff;
               border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.25);padding:14px;margin-bottom:8px}
        .panel.open{display:block}
        h3{margin:0 0 8px;font-size:15px;color:#006633}
        label{display:flex;align-items:center;gap:6px;margin:6px 0}
        input[type=number]{width:52px;padding:2px 4px}
        textarea{width:100%;box-sizing:border-box;min-height:48px;font:inherit}
        .row{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
        button.b{flex:1;padding:7px 4px;border-radius:6px;border:1px solid #006633;background:#fff;color:#006633;cursor:pointer}
        button.b.primary{background:#006633;color:#fff}
        button.b:disabled{opacity:.5;cursor:not-allowed}
        .log{margin-top:10px;background:#f5f7f5;border-radius:6px;padding:6px;max-height:200px;overflow:auto;
             font-size:12px;white-space:pre-wrap;word-break:break-all}
        .hint{color:#888;font-size:12px}
      </style>
      <div class="panel" id="panel">
        <h3>一键评教 · ${profile.name}</h3>
        <label><input type="radio" name="mode" value="fixed"> 统一分数 <input type="number" id="fixed" min="1" max="10"> 星</label>
        <label><input type="radio" name="mode" value="range"> 随机区间 <input type="number" id="min" min="1" max="10"> ~ <input type="number" id="max" min="1" max="10"> 星</label>
        <label><input type="checkbox" id="notAllSame"> 避免全部同分（随机一项 ±1）</label>
        <label><input type="checkbox" id="speedUp"> 加速页面自带倒计时（手动评价时用，需刷新）</label>
        <div class="hint">评语模板（每行一条，随机选；留空则不填）</div>
        <textarea id="memo" placeholder="例如：讲课认真，条理清晰"></textarea>
        <div class="row">
          <button class="b" id="preview">预览</button>
          <button class="b" id="one">先提交 1 门</button>
          <button class="b primary" id="all">全部提交</button>
        </div>
        <div class="log" id="log">提交后不可更改，建议先“预览”再“先提交 1 门”。</div>
      </div>
      <button class="fab" id="fab">一键评教</button>`;

    const $ = (id) => root.getElementById(id);
    const logEl = $('log');
    const log = (m) => { logEl.textContent += '\n' + m; logEl.scrollTop = logEl.scrollHeight; };

    root.querySelectorAll('input[name=mode]').forEach((r) => { r.checked = r.value === opt.mode; });
    $('fixed').value = opt.fixed; $('min').value = opt.min; $('max').value = opt.max;
    $('notAllSame').checked = opt.notAllSame; $('speedUp').checked = opt.speedUpTimer; $('memo').value = opt.memo;

    const readOpt = () => {
      opt.mode = root.querySelector('input[name=mode]:checked')?.value || 'fixed';
      opt.fixed = +$('fixed').value || 10; opt.min = +$('min').value || 9; opt.max = +$('max').value || 10;
      opt.notAllSame = $('notAllSame').checked; opt.speedUpTimer = $('speedUp').checked; opt.memo = $('memo').value;
      saveOpt(opt);
    };

    $('fab').onclick = () => $('panel').classList.toggle('open');
    const btns = ['preview', 'one', 'all'].map($);
    const guard = (fn) => async () => {
      readOpt();
      btns.forEach((b) => (b.disabled = true));
      logEl.textContent = '';
      try { await fn(); } catch (e) { log('⚠️ ' + (e.message || e)); }
      btns.forEach((b) => (b.disabled = false));
    };

    $('preview').onclick = guard(async () => {
      await runTasks(await buildPlan(log), { dryRun: true }, log);
    });
    $('one').onclick = guard(async () => {
      const tasks = await buildPlan(log);
      if (!tasks.length) return log('没有待评课程');
      if (!confirm(`将提交「${tasks[0].title}」1 次评价，提交后不可更改。确定？`)) return log('已取消');
      await runTasks(tasks, { limit: 1 }, log);
    });
    $('all').onclick = guard(async () => {
      const tasks = await buildPlan(log);
      const total = tasks.reduce((s, t) => s + t.remaining, 0);
      if (!total) return log('没有待评课程');
      if (!confirm(`将为 ${tasks.length} 门课程提交共 ${total} 次评价，提交后不可更改。确定？`)) return log('已取消');
      await runTasks(tasks, {}, log);
      log('3 秒后刷新页面…'); await sleep(3000); location.reload();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountUI);
  else mountUI();

  // 供控制台调试
  window.__evalHelper = { profile, opt, buildPlan, runTasks, makeAnswers };
})();
