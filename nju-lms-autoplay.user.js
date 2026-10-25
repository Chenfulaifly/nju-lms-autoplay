// ==UserScript==
// @name         南大智汇南雍课程自动连播
// @namespace    https://lms.nju.edu.cn/
// @version      2.0.0
// @description  通过平台原生播放器播放并记录时长，到 85% 后自动进入下一节；后台播放仍计入学习时长（屏蔽 blur / visibilitychange / 心跳隐身检测）。
// @author       Codex
// @match        https://lms.nju.edu.cn/*
// @match        https://*.nju.edu.cn/course/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================================
   * 第一部分：后台播放守护（document-start 立即生效，先于页面脚本执行）
   *   1. 让 document.hidden / visibilityState / hasFocus() 永远返回「前台可见」
   *   2. 在 window 捕获阶段吞掉 visibilitychange / blur / freeze，平台收不到
   *   3. 吞掉 document.onvisibilitychange、window.onblur 这类属性赋值
   *   4. IntersectionObserver 恒返回「在视口内」，防止滚出视野被暂停
   *   5. 失焦瞬间忽略页面主动调用的 video.pause()
   *   6. 改写心跳 / 进度上报请求体里的 hidden、isActive、focused 等字段
   *   7. 定时派发 mousemove / pointermove，绕过「无操作视为离开」的判定
   * ========================================================================= */

  const GUARD_STORAGE_KEY = 'nju-lms-guard-v1';

  let guardOn = true;
  try {
    guardOn = localStorage.getItem(GUARD_STORAGE_KEY) !== '0';
  } catch (_) {
    /* localStorage 不可用时保持默认开启 */
  }

  const guardStats = { blocked: 0, patched: 0, resumed: 0 };

  // 真实可见性 / 焦点状态（页面看到的是假的，我们自己要看真的）
  const docProto = Document.prototype;
  const realHiddenDesc = Object.getOwnPropertyDescriptor(docProto, 'hidden');
  const realVisibilityDesc = Object.getOwnPropertyDescriptor(docProto, 'visibilityState');
  const realWebkitHiddenDesc = Object.getOwnPropertyDescriptor(docProto, 'webkitHidden');
  const realWebkitVisibilityDesc = Object.getOwnPropertyDescriptor(docProto, 'webkitVisibilityState');
  const realHasFocus = docProto.hasFocus;

  function realHiddenNow() {
    try {
      if (realHiddenDesc && realHiddenDesc.get) return realHiddenDesc.get.call(document);
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  // 「危险窗口」：页面真的失去焦点/被隐藏后的一段时间内，忽略它想暂停视频的企图
  let threatUntil = 0;
  function markThreat() {
    threatUntil = Date.now() + 5000;
  }

  // 用户手动操作（点击/按键）后给 4 秒宽限期，避免和用户自己按暂停打架
  let lastUserGesture = 0;
  document.addEventListener('pointerdown', () => { lastUserGesture = Date.now(); }, true);
  document.addEventListener('keydown', () => { lastUserGesture = Date.now(); }, true);

  function installVisibilitySpoof() {
    const safeDefine = (target, prop, descriptor) => {
      try {
        Object.defineProperty(target, prop, descriptor);
      } catch (_) {
        /* 某些环境下属性不可重定义，忽略即可 */
      }
    };

    safeDefine(docProto, 'hidden', {
      configurable: true,
      get() {
        if (guardOn) return false;
        return realHiddenDesc && realHiddenDesc.get ? realHiddenDesc.get.call(this) : false;
      },
    });

    safeDefine(docProto, 'visibilityState', {
      configurable: true,
      get() {
        if (guardOn) return 'visible';
        return realVisibilityDesc && realVisibilityDesc.get ? realVisibilityDesc.get.call(this) : 'visible';
      },
    });

    safeDefine(docProto, 'webkitHidden', {
      configurable: true,
      get() {
        if (guardOn) return false;
        return realWebkitHiddenDesc && realWebkitHiddenDesc.get
          ? realWebkitHiddenDesc.get.call(this)
          : false;
      },
    });

    safeDefine(docProto, 'webkitVisibilityState', {
      configurable: true,
      get() {
        if (guardOn) return 'visible';
        return realWebkitVisibilityDesc && realWebkitVisibilityDesc.get
          ? realWebkitVisibilityDesc.get.call(this)
          : 'visible';
      },
    });

    // hasFocus() 恒为 true：很多平台的心跳会直接上报这个值
    safeDefine(document, 'hasFocus', {
      configurable: true,
      writable: true,
      value: function () {
        if (guardOn) return true;
        return realHasFocus ? realHasFocus.call(document) : true;
      },
    });

    // 吞掉平台的隐藏回调属性赋值
    ['onvisibilitychange', 'onwebkitvisibilitychange', 'onfreeze'].forEach((prop) => {
      safeDefine(docProto, prop, {
        configurable: true,
        get() { return null; },
        set() { /* 平台想挂的隐藏回调，直接丢弃 */ },
      });
    });

    ['onblur', 'onvisibilitychange'].forEach((prop) => {
      safeDefine(window, prop, {
        configurable: true,
        get() { return null; },
        set() { /* 同上 */ },
      });
    });
  }

  function installEventBlockers() {
    const suppress = (event) => {
      if (!guardOn) return;
      markThreat();
      guardStats.blocked += 1;
      event.stopImmediatePropagation();
      event.stopPropagation();
      refreshGuardStats();
    };

    ['visibilitychange', 'webkitvisibilitychange', 'blur', 'freeze'].forEach((type) => {
      // window 捕获阶段最先生效，页面注册在 document / window 上的监听器都收不到
      window.addEventListener(type, suppress, true);
      document.addEventListener(type, suppress, true);
    });
  }

  function installIntersectionPatch() {
    const NativeIO = window.IntersectionObserver;
    if (typeof NativeIO !== 'function') return;

    const PatchedIO = function (callback, options) {
      const wrapped = function (entries, observer) {
        if (!guardOn || typeof callback !== 'function') {
          return callback.call(this, entries, observer);
        }
        const faked = entries.map((entry) =>
          new Proxy(entry, {
            get(target, prop) {
              if (prop === 'isIntersecting') return true;
              if (prop === 'intersectionRatio') return 1;
              const value = Reflect.get(target, prop, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          })
        );
        return callback.call(this, faked, observer);
      };
      return new NativeIO(wrapped, options);
    };

    PatchedIO.prototype = NativeIO.prototype;
    try {
      window.IntersectionObserver = PatchedIO;
    } catch (_) {
      /* ignore */
    }
  }

  function installPauseGuard() {
    const nativePause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function () {
      if (
        guardOn &&
        this.tagName === 'VIDEO' &&
        !this.ended &&
        Date.now() < threatUntil
      ) {
        // 页面因为「失焦 / 隐藏」想暂停：直接忽略这次调用
        return undefined;
      }
      return nativePause.apply(this, arguments);
    };
  }

  // ---- 心跳 / 进度上报请求体改写 ----
  const PROGRESS_URL_RE =
    /(heartbeat|progress|duration|watch|study|learn|playlog|multimedia|\/log|track|record|activity|video)/i;

  const VISIBILITY_FIELDS = {
    hidden: false,
    ishidden: false,
    visibility: 'visible',
    visibilitystate: 'visible',
    visible: true,
    isvisible: true,
    isactive: true,
    active: true,
    isfocus: true,
    focused: true,
    isfocused: true,
    hasfocus: true,
    onfocus: true,
    tabactive: true,
    pagevisible: true,
    foreground: true,
    inforeground: true,
    isforeground: true,
    windowactive: true,
    iswindowactive: true,
  };

  function pickVisibilityValue(key) {
    const normalized = String(key).toLowerCase();
    return Object.prototype.hasOwnProperty.call(VISIBILITY_FIELDS, normalized)
      ? VISIBILITY_FIELDS[normalized]
      : undefined;
  }

  function patchObject(node, depth) {
    if (!node || typeof node !== 'object' || depth > 8) return false;
    let changed = false;
    Object.keys(node).forEach((key) => {
      const value = node[key];
      if (value && typeof value === 'object') {
        changed = patchObject(value, depth + 1) || changed;
        return;
      }
      const target = pickVisibilityValue(key);
      if (target !== undefined && node[key] !== target) {
        node[key] = target;
        changed = true;
      }
    });
    return changed;
  }

  function patchBody(body) {
    if (typeof body !== 'string' || !body) return body;
    const trimmed = body.trim();

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const data = JSON.parse(trimmed);
        if (patchObject(data, 0)) {
          guardStats.patched += 1;
          refreshGuardStats();
          return JSON.stringify(data);
        }
      } catch (_) {
        /* 不是合法 JSON，原样返回 */
      }
      return body;
    }

    if (trimmed.includes('=') && /(hidden|visib|active|focus|foreground)/i.test(trimmed)) {
      try {
        const params = new URLSearchParams(trimmed);
        let changed = false;
        [...params.keys()].forEach((key) => {
          const target = pickVisibilityValue(key);
          if (target !== undefined) {
            params.set(key, String(target));
            changed = true;
          }
        });
        if (changed) {
          guardStats.patched += 1;
          refreshGuardStats();
          return params.toString();
        }
      } catch (_) {
        /* ignore */
      }
    }

    return body;
  }

  function installNetworkPatch() {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function') {
      window.fetch = function (input, init) {
        try {
          const url = typeof input === 'string' ? input : input && input.url ? input.url : '';
          if (guardOn && init && typeof init.body === 'string' && PROGRESS_URL_RE.test(url)) {
            init = { ...init, body: patchBody(init.body) };
          }
        } catch (_) {
          /* ignore */
        }
        return nativeFetch.call(this, input, init);
      };
    }

    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__njuUrl = String(url || '');
      } catch (_) {
        /* ignore */
      }
      return nativeOpen.apply(this, arguments);
    };

    const nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (guardOn && typeof body === 'string' && PROGRESS_URL_RE.test(this.__njuUrl || '')) {
          body = patchBody(body);
        }
      } catch (_) {
        /* ignore */
      }
      return nativeSend.call(this, body);
    };

    if (typeof navigator.sendBeacon === 'function') {
      const nativeBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (url, data) {
        try {
          if (guardOn && typeof data === 'string' && PROGRESS_URL_RE.test(String(url || ''))) {
            data = patchBody(data);
          }
        } catch (_) {
          /* ignore */
        }
        return nativeBeacon(url, data);
      };
    }
  }

  // ---- 模拟「有人在操作」 ----
  function installActivityPing() {
    const fire = () => {
      if (!guardOn) return;
      const x = 120 + Math.floor(Math.random() * 400);
      const y = 120 + Math.floor(Math.random() * 300);
      try {
        document.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, cancelable: true, clientX: x, clientY: y, view: window,
        }));
        document.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, clientX: x, clientY: y, view: window,
        }));
      } catch (_) {
        /* ignore */
      }
    };
    window.setInterval(fire, 30000);
  }

  // 每 500ms 检查一次真实状态，刷新「危险窗口」
  window.setInterval(() => {
    if (!guardOn) return;
    let focused = true;
    try {
      focused = realHasFocus ? realHasFocus.call(document) : true;
    } catch (_) {
      focused = true;
    }
    if (realHiddenNow() || !focused) markThreat();
  }, 500);

  installVisibilitySpoof();
  installEventBlockers();
  installIntersectionPatch();
  installPauseGuard();
  installNetworkPatch();
  installActivityPing();

  /* =========================================================================
   * 第二部分：自动连播（只在课程页生效）
   * ========================================================================= */

  const COURSE_ID = location.pathname.match(/^\/course\/(\d+)/)?.[1];
  if (!COURSE_ID) return;

  const STORAGE_KEY = `nju-lms-autoplay-v1:${COURSE_ID}`;
  const PANEL_ID = 'nju-lms-autoplay-panel';
  const DIRECTORY_PATH = `/course/${COURSE_ID}/content#/`;
  const AUTO_ADVANCE_RATIO = 0.85;
  const PROGRESS_SYNC_DELAY_MS = 3000;

  let statusText = '尚未启动';
  let statusDetail = '打开一节视频后点“开始连播”';
  let playerTimer = null;
  let directoryTimer = null;
  let lastRenderedSecond = -1;
  let resumeAttempts = 0;

  function readState() {
    try {
      return {
        enabled: false,
        currentId: null,
        advancePending: false,
        ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'),
      };
    } catch (_) {
      return { enabled: false, currentId: null, advancePending: false };
    }
  }

  function writeState(patch) {
    const next = { ...readState(), ...patch };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (_) {
      /* ignore */
    }
    renderPanel();
    return next;
  }

  function currentActivityId() {
    if (!location.pathname.includes('/learning-activity')) return null;
    return location.hash.match(/#\/(\d+)/)?.[1] || null;
  }

  function isDirectoryPage() {
    return location.pathname === `/course/${COURSE_ID}/content`;
  }

  function setStatus(title, detail = '') {
    statusText = title;
    statusDetail = detail;
    renderPanel();
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '--:--';
    const total = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function refreshGuardStats() {
    const node = document.querySelector(`#${PANEL_ID} .nju-auto-stats`);
    if (!node) return;
    node.textContent =
      `后台保护 ${guardOn ? '已开' : '已关'} · 拦截 ${guardStats.blocked} · ` +
      `改写 ${guardStats.patched} · 续播 ${guardStats.resumed}`;
  }

  function renderPanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      if (!document.body) return;
      panel = document.createElement('section');
      panel.id = PANEL_ID;
      panel.innerHTML = `
        <div class="nju-auto-title">课程连播</div>
        <div class="nju-auto-status"></div>
        <div class="nju-auto-detail"></div>
        <div class="nju-auto-actions">
          <button type="button" data-action="toggle"></button>
          <button type="button" data-action="next">直接进入下一节</button>
        </div>
        <div class="nju-auto-actions nju-auto-actions-guard">
          <button type="button" data-action="guard"></button>
        </div>
        <div class="nju-auto-stats"></div>
      `;

      const style = document.createElement('style');
      style.textContent = `
        #${PANEL_ID} {
          position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
          width: 260px; box-sizing: border-box; padding: 14px;
          color: #fff; background: rgba(35, 29, 38, .94);
          border: 1px solid rgba(255,255,255,.16); border-radius: 12px;
          box-shadow: 0 10px 32px rgba(0,0,0,.28);
          font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        #${PANEL_ID} .nju-auto-title { font-size: 15px; font-weight: 700; margin-bottom: 6px; }
        #${PANEL_ID} .nju-auto-status { color: #87e8de; font-weight: 600; }
        #${PANEL_ID} .nju-auto-detail { color: rgba(255,255,255,.72); min-height: 38px; margin: 4px 0 10px; }
        #${PANEL_ID} .nju-auto-actions { display: flex; gap: 8px; }
        #${PANEL_ID} .nju-auto-actions-guard { margin-top: 8px; }
        #${PANEL_ID} .nju-auto-stats {
          margin-top: 8px; color: rgba(255,255,255,.5); font-size: 11px; line-height: 1.35;
        }
        #${PANEL_ID} button {
          flex: 1; border: 0; border-radius: 7px; padding: 7px 8px; cursor: pointer;
          color: #fff; background: #63065f; font: inherit;
        }
        #${PANEL_ID} button:hover { filter: brightness(1.16); }
        #${PANEL_ID} button[data-action="next"] { background: #555; }
        #${PANEL_ID} button[data-action="guard"] { background: #2f6f5e; }
        #${PANEL_ID} button[data-action="guard"][data-off="1"] { background: #7a4a2a; }
      `;
      document.documentElement.append(style, panel);

      panel.querySelector('[data-action="toggle"]').addEventListener('click', () => {
        const state = readState();
        if (state.enabled) {
          stopAutoplay('已停止', '播放进度会由学习平台正常保存');
          return;
        }

        const activityId = currentActivityId();
        writeState({ enabled: true, currentId: activityId || state.currentId, advancePending: false });
        setStatus('连播已开启', activityId ? '正在启动当前视频…' : '正在寻找第一个未完成课程…');
        if (activityId) attachToPlayer(true);
        else if (isDirectoryPage()) advanceFromDirectory(false);
        else location.href = DIRECTORY_PATH;
      });

      panel.querySelector('[data-action="next"]').addEventListener('click', () => {
        const activityId = currentActivityId();
        writeState({ enabled: true, currentId: activityId || readState().currentId, advancePending: true });
        setStatus('即将进入下一节', '手动跳过不会修改当前课程的完成记录');
        location.href = DIRECTORY_PATH;
      });

      panel.querySelector('[data-action="guard"]').addEventListener('click', () => {
        guardOn = !guardOn;
        try {
          localStorage.setItem(GUARD_STORAGE_KEY, guardOn ? '1' : '0');
        } catch (_) {
          /* ignore */
        }
        if (guardOn) markThreat();
        setStatus(
          guardOn ? '后台保护已开启' : '后台保护已关闭',
          guardOn ? '切到别的标签页也会继续计时' : '切走标签页后平台可能暂停计时'
        );
      });
    }

    const state = readState();
    panel.querySelector('.nju-auto-status').textContent = statusText;
    panel.querySelector('.nju-auto-detail').textContent = statusDetail;
    panel.querySelector('[data-action="toggle"]').textContent = state.enabled ? '停止连播' : '开始连播';

    const guardButton = panel.querySelector('[data-action="guard"]');
    guardButton.textContent = guardOn ? '后台保护：开' : '后台保护：关';
    guardButton.dataset.off = guardOn ? '0' : '1';

    refreshGuardStats();
  }

  function stopAutoplay(title = '全部播放完成', detail = '没有更多未完成课程') {
    clearInterval(playerTimer);
    clearInterval(directoryTimer);
    writeState({ enabled: false, advancePending: false });
    setStatus(title, detail);
  }

  function nativePlayButton() {
    return document.querySelector(
      'button.mvp-toggle-play[aria-label="播放"], .mvp-toggle-play[aria-label="播放"]'
    );
  }

  function waitForNativePlay(video, timeoutMs = 1500) {
    return new Promise((resolve) => {
      if (!video.paused) {
        resolve(true);
        return;
      }

      let timer;
      const onPlay = () => {
        window.clearTimeout(timer);
        resolve(true);
      };
      video.addEventListener('play', onPlay, { once: true });
      timer = window.setTimeout(() => {
        video.removeEventListener('play', onPlay);
        resolve(!video.paused);
      }, timeoutMs);
    });
  }

  async function tryPlay(video, fromUserClick = false) {
    if (
      !readState().enabled ||
      video.ended ||
      video.dataset.njuAutoAdvanceQueued === '1' ||
      video.dataset.njuNativePlayPending === '1'
    ) return;

    if (!video.paused) {
      video.dataset.njuPlatformStarted = '1';
      setStatus('正在播放', `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`);
      return;
    }

    const playButton = nativePlayButton();
    if (!playButton) {
      setStatus('正在等待播放器', '原生播放按钮准备好后会自动启动');
      return;
    }

    video.dataset.njuNativePlayPending = '1';
    setStatus('正在启动平台播放器', '通过原生播放流程启动计时…');
    playButton.click();
    const started = await waitForNativePlay(video);
    delete video.dataset.njuNativePlayPending;

    if (started) {
      video.dataset.njuPlatformStarted = '1';
      setStatus('正在播放', `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`);
    } else {
      setStatus(
        '等待你点击播放',
        fromUserClick
          ? '播放器还没有准备好，请点一下视频下方的播放按钮'
          : '浏览器拦截了自动播放，请点一下视频下方的播放按钮'
      );
    }
  }

  // 页面因为失焦/隐藏把视频暂停后，自动续播
  function scheduleResume(video) {
    if (!guardOn || !readState().enabled) return;
    if (video.ended || video.dataset.njuAutoAdvanceQueued === '1') return;
    if (Date.now() - lastUserGesture < 4000) return; // 用户自己按的暂停，尊重一下
    if (Date.now() > threatUntil) return;            // 不是失焦导致的暂停，不管
    if (resumeAttempts >= 5) return;

    resumeAttempts += 1;
    window.setTimeout(() => {
      if (!video.paused || video.ended || !guardOn) return;
      guardStats.resumed += 1;
      refreshGuardStats();
      const playButton = nativePlayButton();
      if (playButton) {
        playButton.click();
        setStatus('后台续播', '检测到播放被中断，已重新启动');
      } else {
        video.play().catch(() => {});
      }
    }, 1200);
  }

  function queueNextActivity(video, activityId, reason) {
    if (!readState().enabled || video.dataset.njuAutoAdvanceQueued === '1') return;
    video.dataset.njuAutoAdvanceQueued = '1';
    writeState({ currentId: activityId || currentActivityId(), advancePending: true });

    const reachedThreshold = reason === 'threshold';
    const delay = reachedThreshold ? PROGRESS_SYNC_DELAY_MS : 1500;
    setStatus(
      reachedThreshold ? '已播放到 85%' : '本节已播完',
      `${delay / 1000} 秒后进入下一个未完成课程…`
    );

    // 继续播放几秒，给平台留出上传最后一段进度的时间。
    window.setTimeout(() => {
      if (!readState().enabled) {
        delete video.dataset.njuAutoAdvanceQueued;
        return;
      }
      location.href = DIRECTORY_PATH;
    }, delay);
  }

  function bindVideo(video, fromUserClick) {
    if (video.dataset.njuAutoPlaylistBound === '1') {
      if (fromUserClick || (video.paused && video.dataset.njuPlatformStarted !== '1')) {
        tryPlay(video, fromUserClick);
      }
      return;
    }
    video.dataset.njuAutoPlaylistBound = '1';

    const activityId = currentActivityId();
    if (activityId) writeState({ currentId: activityId, advancePending: false });

    video.addEventListener('play', () => {
      video.dataset.njuPlatformStarted = '1';
      resumeAttempts = 0;
      setStatus('正在播放', `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`);
    });
    video.addEventListener('pause', () => {
      if (video.ended) return;
      if (readState().enabled) {
        setStatus('视频已暂停', `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`);
      }
      scheduleResume(video);
    });
    video.addEventListener('timeupdate', () => {
      if (video.dataset.njuAutoAdvanceQueued === '1') return;
      const second = Math.floor(video.currentTime);
      if (second !== lastRenderedSecond) {
        lastRenderedSecond = second;
        setStatus('正在播放', `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`);
      }

      if (
        Number.isFinite(video.duration) &&
        video.duration > 0 &&
        video.currentTime / video.duration >= AUTO_ADVANCE_RATIO
      ) {
        queueNextActivity(video, activityId, 'threshold');
      }
    });
    video.addEventListener('ended', () => {
      queueNextActivity(video, activityId, 'ended');
    });

    tryPlay(video, fromUserClick);
  }

  function attachToPlayer(fromUserClick = false) {
    clearInterval(playerTimer);
    const findAndBind = () => {
      if (!readState().enabled) return;
      const video = document.querySelector('video');
      if (video) {
        bindVideo(video, fromUserClick);
        fromUserClick = false;
      } else {
        setStatus('正在等待视频', '页面加载完后会自动开始');
      }
    };
    findAndBind();
    playerTimer = window.setInterval(findAndBind, 1000);
  }

  function activityRows() {
    return [...document.querySelectorAll('.learning-activity[id^="learning-activity-"]')]
      .map((element) => {
        const completion = element.querySelector('.completeness');
        return {
          element,
          id: element.id.replace('learning-activity-', ''),
          text: element.textContent.replace(/\s+/g, ' ').trim(),
          completion: [
            completion?.textContent || '',
            completion?.getAttribute('title') || '',
            completion?.className || '',
          ].join(' '),
          clickable: Boolean(element.querySelector('.clickable-area')),
        };
      })
      .filter((item) => item.id && item.clickable);
  }

  function isCompleted(row) {
    const status = `${row.text} ${row.completion}`;
    return status.includes('已完成') && !status.includes('未完成') && !status.includes('部分完成');
  }

  function openActivity(row) {
    writeState({ currentId: row.id, advancePending: false });
    setStatus('正在打开下一节', row.text.slice(0, 70));
    // 直接使用平台的稳定路由，避免依赖页面中易变的 Angular 作用域。
    location.href = `/course/${COURSE_ID}/learning-activity#/${row.id}`;
  }

  function advanceFromDirectory(afterCurrent) {
    clearInterval(directoryTimer);
    let attempts = 0;
    const findNext = () => {
      if (!readState().enabled) return;
      attempts += 1;
      const rows = activityRows();
      if (!rows.length) {
        setStatus('正在读取课程目录', '请稍候…');
        if (attempts >= 30) stopAutoplay('未找到课程', '请刷新页面后重试');
        return;
      }

      clearInterval(directoryTimer);
      const state = readState();
      const currentIndex = rows.findIndex((row) => row.id === state.currentId);
      const startIndex = afterCurrent && currentIndex >= 0 ? currentIndex + 1 : 0;
      const next = rows.slice(startIndex).find((row) => !isCompleted(row));

      if (next) openActivity(next);
      else stopAutoplay();
    };

    findNext();
    directoryTimer = window.setInterval(findNext, 500);
  }

  function init() {
    renderPanel();
    const state = readState();
    if (!state.enabled) return;

    if (currentActivityId()) {
      setStatus('连播运行中', '正在连接视频播放器…');
      attachToPlayer(false);
    } else if (isDirectoryPage()) {
      setStatus('连播运行中', '正在选择下一个未完成课程…');
      advanceFromDirectory(Boolean(state.advancePending));
    } else {
      location.href = DIRECTORY_PATH;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
