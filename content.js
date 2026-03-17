// ===== 正在学刷课助手 · content.js =====
// 支持：learnin.com.cn 视频课程自动播放、倍速、自动切换下一节、一键多开

(function () {
  'use strict';

  // ---- 防重复注入 ----
  if (window.__learninHelperLoaded) return;
  window.__learninHelperLoaded = true;

  // ---- 配置 ----
  const CFG = {
    speed: 3.0,
    autoNext: false,
    autoPlay: true,
    skipWait: true,
    running: false,
  };

  // ---- 日志 ----
  const logs = [];
  function log(msg, type = '') {
    const t = new Date().toLocaleTimeString('zh', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    logs.unshift({ t, msg, type });
    if (logs.length > 20) logs.pop();
    renderLog();
  }

  // ---- 工具 ----
  function $(sel, root = document) { return root.querySelector(sel); }
  function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ---- 视频查找（兼容 iframe 内嵌） ----
  function findVideo() {
    // 直接页面
    let v = $('video');
    if (v) return v;
    // iframe 内
    for (const f of $$('iframe')) {
      try {
        const fv = f.contentDocument && f.contentDocument.querySelector('video');
        if (fv) return fv;
      } catch (e) {}
    }
    return null;
  }

  // ---- 获取 video.js 实例 ----
  function getVjsPlayer(video) {
    if (!video) return null;
    try {
      // video.js 会把实例挂在 video 元素上
      if (video.player) return video.player;
      // 或者通过全局 videojs
      if (window.videojs && video.id) return window.videojs.getPlayer(video.id);
      // 通过父容器找
      const vjsEl = video.closest('.video-js');
      if (vjsEl && vjsEl.id && window.videojs) return window.videojs.getPlayer(vjsEl.id);
    } catch (e) {}
    return null;
  }

  // ---- 设置倍速 ----
  function setSpeed(video, speed) {
    if (!video) return;
    try {
      // 优先用 video.js API
      const player = getVjsPlayer(video);
      if (player && typeof player.playbackRate === 'function') {
        player.playbackRate(speed);
      }
      // 同时直接设置（双保险）
      video.playbackRate = speed;
    } catch (e) {
      try { video.playbackRate = speed; } catch (_) {}
    }
  }

  // ---- 自动播放 ----
  function tryPlay(video) {
    if (!video || !video.paused) return;
    try {
      // 方式1：video.js API
      const player = getVjsPlayer(video);
      if (player && typeof player.play === 'function') {
        const p = player.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
        return;
      }
    } catch (e) {}
    // 方式2：先静音再播放（绕过浏览器自动播放限制）
    try {
      video.muted = true;
      video.play().then(() => {
        // 播放成功后恢复音量
        setTimeout(() => { video.muted = false; }, 300);
      }).catch(() => {
        // 静音也失败，说明还没有用户交互，等下次循环重试
        video.muted = false;
      });
    } catch (e) {}
  }

  // ---- 跳过等待弹窗（如"请认真观看"提示） ----
  function skipDialogs() {
    // 常见确认按钮
    const selectors = [
      'button.el-button--primary',
      '.el-dialog__wrapper .el-button--primary',
      '.confirm-btn',
      '[class*="confirm"]',
      '.el-message-box__btns .el-button--primary',
    ];
    for (const sel of selectors) {
      const btn = $(sel);
      if (btn && btn.offsetParent !== null) {
        const txt = btn.textContent.trim();
        if (['确定', '确认', '知道了', '继续', '我知道了'].includes(txt)) {
          btn.click();
          log(`关闭弹窗: ${txt}`, 'ok');
        }
      }
    }
  }

  // ---- 查找"下一节"按钮 ----
  function findNextBtn() {
    // 尝试多种选择器
    const candidates = [
      // 文字匹配
      ...$$('button, .btn, [class*="next"], [class*="Next"]').filter(el => {
        const t = el.textContent.trim();
        return t.includes('下一') || t.includes('下一节') || t.includes('下一课') || t === '下一个';
      }),
      // 图标按钮（右箭头）
      ...$$(
        '[class*="next-btn"], [class*="nextBtn"], [class*="next_btn"], ' +
        '[class*="arrow-right"], [class*="arrowRight"]'
      ),
    ];
    return candidates.find(el => el.offsetParent !== null) || null;
  }

  // ---- 查找课程列表中下一个未完成的视频 ----
  function findNextLesson() {
    // 课程列表项（正在学平台常见结构）
    const items = $$(
      '.video-item, .lesson-item, .chapter-item, ' +
      '[class*="video-item"], [class*="lesson-item"], ' +
      '[class*="courseItem"], [class*="course-item"]'
    );

    let foundCurrent = false;
    for (const item of items) {
      const isCompleted =
        item.classList.contains('completed') ||
        item.classList.contains('finish') ||
        item.querySelector('[class*="complete"], [class*="finish"], .icon-check') !== null;

      const isActive =
        item.classList.contains('active') ||
        item.classList.contains('current') ||
        item.classList.contains('playing');

      if (isActive) {
        foundCurrent = true;
        continue;
      }

      if (foundCurrent && !isCompleted) {
        return item;
      }
    }
    return null;
  }

  // ---- 多开：收集课程列表所有视频链接并批量新标签打开 ----
  function collectVideoLinks() {
    // 容器：.video-items，每项：a.student-course-video-item
    const links = $$('a.student-course-video-item');
    if (links.length === 0) return [];
    return links.map(a => {
      const href = a.getAttribute('href') || '';
      // href 是 #/user/... 相对路径，拼成完整 URL
      const fullUrl = href.startsWith('http')
        ? href
        : `${location.origin}/user/${href.startsWith('#') ? '' : '#'}${href.replace(/^#?\//, '#/')}`;
      const title = a.textContent.trim().slice(0, 30) || href;
      return { url: fullUrl, title };
    });
  }

  // 批量打开所有视频（每隔 600ms 开一个，避免浏览器拦截）
  async function openAllTabs() {
    const links = collectVideoLinks();
    if (links.length === 0) {
      log('未找到课程列表，请在课程列表页使用', 'warn');
      return;
    }
    log(`发现 ${links.length} 个视频，开始多开...`, 'ok');
    updateMultiBtn(true, links.length);

    for (let i = 0; i < links.length; i++) {
      window.open(links[i].url, '_blank');
      log(`已打开 [${i + 1}/${links.length}] ${links[i].title}`, 'ok');
      await sleep(600);
    }
    log(`全部 ${links.length} 个标签已打开 🎉`, 'ok');
    updateMultiBtn(false, links.length);
  }

  function updateMultiBtn(loading, count) {
    const btn = $('#btn-multi');
    if (!btn) return;
    if (loading) {
      btn.textContent = `⏳ 打开中...`;
      btn.disabled = true;
    } else {
      btn.textContent = `🗂 一键多开 (${count})`;
      btn.disabled = false;
    }
  }

  // 检测当前是否在课程列表页（有 .video-items）
  function isListPage() {
    return $$('a.student-course-video-item').length > 0;
  }

  // 动态更新多开按钮状态
  function refreshMultiBtn() {
    const btn = $('#btn-multi');
    const wrap = $('#multi-wrap');
    if (!btn || !wrap) return;
    const links = collectVideoLinks();
    if (links.length > 0) {
      wrap.style.display = 'block';
      btn.textContent = `🗂 一键多开 (${links.length})`;
      btn.disabled = false;
    } else {
      wrap.style.display = 'none';
    }
  }


  let loopTimer = null;
  let videoWatcher = null;
  let lastVideoSrc = '';

  async function mainLoop() {
    if (!CFG.running) return;

    const video = findVideo();

    if (!video) {
      updateStatus('等待视频加载...', '');
      loopTimer = setTimeout(mainLoop, 1500);
      return;
    }

    // 绑定倍速（防平台重置）
    if (video._learninWatched !== true) {
      video._learninWatched = true;
      video.addEventListener('ratechange', () => {
        if (CFG.running && video.playbackRate !== CFG.speed) {
          video.playbackRate = CFG.speed;
        }
      });
      video.addEventListener('play', () => {
        setSpeed(video, CFG.speed);
      });
      // video.js 加载完成事件
      const player = getVjsPlayer(video);
      if (player) {
        player.on('ready', () => setSpeed(video, CFG.speed));
        player.on('play', () => setSpeed(video, CFG.speed));
        player.on('ratechange', () => {
          if (CFG.running && video.playbackRate !== CFG.speed) {
            setSpeed(video, CFG.speed);
          }
        });
      }
      log('检测到视频，已绑定监听', 'ok');
    }

    // 设置倍速
    setSpeed(video, CFG.speed);

    // 自动播放
    if (CFG.autoPlay) tryPlay(video);

    // 跳过弹窗
    if (CFG.skipWait) skipDialogs();

    // 更新进度显示
    const pct = video.duration ? Math.round((video.currentTime / video.duration) * 100) : 0;
    const cur = fmtTime(video.currentTime);
    const dur = fmtTime(video.duration);
    updateStatus(`${cur} / ${dur}`, pct);

    // 视频结束 → 自动下一节
    if (CFG.autoNext && video.ended) {
      log('视频播放完毕，尝试切换下一节...', 'warn');
      await sleep(1200);

      // 方式1：点击"下一节"按钮
      const nextBtn = findNextBtn();
      if (nextBtn) {
        nextBtn.click();
        log('已点击下一节按钮', 'ok');
        await sleep(2000);
        loopTimer = setTimeout(mainLoop, 1000);
        return;
      }

      // 方式2：点击列表中下一个未完成课程
      const nextLesson = findNextLesson();
      if (nextLesson) {
        nextLesson.click();
        log('已切换到下一课时', 'ok');
        await sleep(2000);
        loopTimer = setTimeout(mainLoop, 1000);
        return;
      }

      log('未找到下一节，可能已全部完成', 'ok');
      CFG.running = false;
      updateRunBtn();
      updateStatus('全部完成 🎉', 100);
      return;
    }

    loopTimer = setTimeout(mainLoop, 1000);
  }

  function fmtTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  // ---- 构建面板 UI ----
  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'learnin-panel';
    panel.innerHTML = `
      <div id="panel-header">
        <span id="panel-icon">⚡</span>
        <div id="panel-title">
          <span class="dot idle" id="status-dot"></span>
          <span>刷课助手</span>
        </div>
        <button id="panel-toggle" title="收起">−</button>
      </div>
      <div id="panel-body">
        <div id="panel-status">
          <div class="status-line">
            <span>状态</span>
            <span class="status-val" id="st-state">待机</span>
          </div>
          <div class="status-line">
            <span>进度</span>
            <span class="status-val" id="st-progress">—</span>
          </div>
        </div>

        <div id="video-progress-wrap">
          <div id="video-progress-bar"></div>
        </div>

        <div class="ctrl-row">
          <span class="ctrl-label">播放速度</span>
          <div class="speed-btns" id="speed-btns">
            <button class="speed-btn" data-speed="1">1×</button>
            <button class="speed-btn" data-speed="1.5">1.5×</button>
            <button class="speed-btn" data-speed="2">2×</button>
            <button class="speed-btn active" data-speed="3">3×</button>
          </div>
        </div>

        <div class="divider"></div>

        <div class="toggle-row">
          <span class="toggle-label">自动播放</span>
          <label class="toggle-switch">
            <input type="checkbox" id="tog-autoplay" checked>
            <span class="toggle-track"></span>
          </label>
        </div>

        <div class="toggle-row">
          <span class="toggle-label">自动切换下一节</span>
          <label class="toggle-switch">
            <input type="checkbox" id="tog-autonext">
            <span class="toggle-track"></span>
          </label>
        </div>

        <div class="toggle-row">
          <span class="toggle-label">自动关闭弹窗</span>
          <label class="toggle-switch">
            <input type="checkbox" id="tog-skipwait" checked>
            <span class="toggle-track"></span>
          </label>
        </div>

        <div class="divider"></div>

        <button id="btn-start">▶ 开始刷课</button>

        <div id="multi-wrap" style="display:none">
          <div class="divider" style="margin-top:8px"></div>
          <button id="btn-multi">🗂 一键多开</button>
          <div class="multi-tip">在课程列表页点击，将所有视频分别在新标签页打开并自动播放</div>
        </div>

        <div id="panel-log"></div>
      </div>
    `;
    document.body.appendChild(panel);
    bindEvents(panel);
    makeDraggable(panel);
    log('插件已加载，等待开始', '');
    return panel;
  }

  function bindEvents(panel) {
    // 收起/展开
    const toggle = $('#panel-toggle', panel);
    const icon = $('#panel-icon', panel);
    toggle.addEventListener('click', () => {
      panel.classList.add('collapsed');
    });
    panel.addEventListener('click', (e) => {
      if (panel.classList.contains('collapsed')) {
        panel.classList.remove('collapsed');
      }
    });

    // 倍速按钮
    $$('.speed-btn', panel).forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const speed = parseFloat(btn.dataset.speed);
        CFG.speed = speed;
        $$('.speed-btn', panel).forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const v = findVideo();
        if (v) setSpeed(v, speed);
        log(`倍速设为 ${speed}×`, 'ok');
      });
    });

    // 开关
    $('#tog-autoplay', panel).addEventListener('change', e => {
      CFG.autoPlay = e.target.checked;
    });
    $('#tog-autonext', panel).addEventListener('change', e => {
      CFG.autoNext = e.target.checked;
    });
    $('#tog-skipwait', panel).addEventListener('change', e => {
      CFG.skipWait = e.target.checked;
    });

    // 开始/停止
    $('#btn-start', panel).addEventListener('click', (e) => {
      e.stopPropagation();
      CFG.running = !CFG.running;
      updateRunBtn();
      if (CFG.running) {
        log('开始刷课', 'ok');
        mainLoop();
      } else {
        clearTimeout(loopTimer);
        log('已暂停', 'warn');
        updateStatus('已暂停', null);
      }
    });

    // 一键多开
    $('#btn-multi', panel).addEventListener('click', (e) => {
      e.stopPropagation();
      openAllTabs();
    });

    // 初始检测是否在列表页
    setTimeout(refreshMultiBtn, 1000);
  }

  function updateRunBtn() {
    const btn = $('#btn-start');
    const dot = $('#status-dot');
    if (!btn) return;
    if (CFG.running) {
      btn.textContent = '⏹ 停止刷课';
      btn.classList.add('running');
      dot && dot.classList.remove('idle');
    } else {
      btn.textContent = '▶ 开始刷课';
      btn.classList.remove('running');
      dot && dot.classList.add('idle');
    }
  }

  function updateStatus(progressText, pct) {
    const stState = $('#st-state');
    const stProg = $('#st-progress');
    const bar = $('#video-progress-bar');
    if (stState) stState.textContent = CFG.running ? '运行中' : '待机';
    if (stProg) stProg.textContent = progressText || '—';
    if (bar && pct !== null && pct !== undefined) {
      bar.style.width = pct + '%';
    }
  }

  function renderLog() {
    const el = $('#panel-log');
    if (!el) return;
    el.innerHTML = logs.slice(0, 5).map(l =>
      `<div class="log-item">
        <span class="log-time">${l.t}</span>
        <span class="log-msg ${l.type}">${l.msg}</span>
      </div>`
    ).join('');
  }

  // ---- 拖拽 ----
  function makeDraggable(panel) {
    const header = $('#panel-header', panel);
    let dragging = false, ox = 0, oy = 0;

    header.addEventListener('mousedown', (e) => {
      if (panel.classList.contains('collapsed')) return;
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      panel.style.transition = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const x = e.clientX - ox;
      const y = e.clientY - oy;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = Math.max(0, Math.min(x, window.innerWidth - panel.offsetWidth)) + 'px';
      panel.style.top = Math.max(0, Math.min(y, window.innerHeight - panel.offsetHeight)) + 'px';
    });

    document.addEventListener('mouseup', () => {
      dragging = false;
      panel.style.transition = '';
    });
  }

  // ---- 等待页面加载完成后注入 ----
  function init() {
    // 只在课程视频页面注入
    if (!location.href.includes('learnin.com.cn')) return;
    if (document.getElementById('learnin-panel')) return;

    buildPanel();
    log('正在学刷课助手已就绪', 'ok');
  }

  // SPA 路由变化监听（Vue Router hash 模式）
  let lastHash = location.hash;
  setInterval(() => {
    if (location.hash !== lastHash) {
      lastHash = location.hash;
      // 路由切换后重新检查
      setTimeout(() => {
        if (!document.getElementById('learnin-panel')) {
          init();
        } else {
          refreshMultiBtn();
        }
      }, 1500);
    }
  }, 500);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
