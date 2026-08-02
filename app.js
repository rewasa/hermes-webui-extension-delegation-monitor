(function(){
  'use strict';

  /* ── Configuration ── */
  var DATA_URL = '/extensions/delegation-monitor/data/delegations.json';
  var LOGS_URL_PREFIX = '/extensions/delegation-monitor/data/logs/';
  var POLL_INTERVAL = 5000;       /* 5 seconds */
  var MOUNT_TIMEOUT = 30000;      /* 30 seconds */
  var STALE_WARN_SECS = 60;       /* warn if data older than 60s */
  var MAX_GOAL_LEN = 80;

  /* ── i18n helper ── */
  function T(key, fallback, arg) {
    try {
      if (typeof window.t === 'function') {
        var v = window.t(key, arg);
        if (v && v !== key) return v;
      }
    } catch (_) {}
    return fallback;
  }

  /* ── State ── */
  var panelOpen = false;
  var pollTimer = null;
  var mounted = false;
  var detailView = false;          /* true when detail view is shown */
  var detailDelegationId = null;   /* current delegation_id in detail */
  var detailPollTimer = null;      /* separate timer for detail polling */
  var detailAutoScroll = true;     /* auto-scroll to bottom unless user scrolled up */
  var detailCurrentTask = 0;       /* currently selected task index */

  /* ── Helpers ── */

  function qs(sel, ctx) {
    return (ctx || document).querySelector(sel);
  }

  function esc(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/\"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDuration(dispatched, completed) {
    var start = dispatched || 0;
    var end = completed || Date.now() / 1000;
    var secs = Math.max(0, end - start);
    if (secs < 60) return Math.round(secs) + 's';
    if (secs < 3600) return Math.round(secs / 60) + 'm';
    var h = Math.floor(secs / 3600);
    var m = Math.round((secs % 3600) / 60);
    return h + 'h ' + m + 'm';
  }

  function fmtTime(ts) {
    if (!ts) return '\u2014';
    var d = new Date(ts * 1000);
    return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  }

  function fmtAge(ts) {
    if (!ts) return '';
    var age = (Date.now() / 1000) - ts;
    if (age < STALE_WARN_SECS) return '';
    var m = Math.round(age / 60);
    return T('dlgmon_age_stale', '{0} min old', m);
  }

  function runningCount(data) {
    if (!data || !data.delegations) return 0;
    var n = 0;
    for (var i = 0; i < data.delegations.length; i++) {
      if (data.delegations[i].state === 'running') n++;
    }
    return n;
  }

  /* ── Validate delegation_id for safe URL usage ── */
  function isValidId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);
  }

  /* ── Task count display ── */
  function taskCountText(n) {
    n = n || 0;
    return n === 1 ? T('dlgmon_task_one', '1 task') : T('dlgmon_tasks', '{0} tasks', n);
  }

  /* ── Render panel content ── */

  function renderPanel(data) {
    var panel = document.getElementById('dlgmon-panel');
    if (!panel) return;

    // If detail view is active, don't re-render the list
    if (detailView) return;

    var html = '';

    // Header
    var ageText = fmtAge(data && data.generated_at);
    html += '<div class="dlgmon-header">';
    html += '<span>' + T('dlgmon_title', 'Delegations') + '</span>';
    if (ageText) {
      html += '<span class="dlgmon-header-stale">' + esc(ageText) + '</span>';
    }
    html += '</div>';

    // Error state
    if (data && data.error) {
      html += '<div class="dlgmon-error">' + T('dlgmon_error', 'Error: {0}', esc(data.error)) + '</div>';
      panel.innerHTML = html;
      return;
    }

    // Empty state
    if (!data || !data.delegations || data.delegations.length === 0) {
      html += '<div class="dlgmon-empty">' + T('dlgmon_empty', 'No delegations yet.') + '</div>';
      panel.innerHTML = html;
      return;
    }

    // Rows — running first, dann completed/failed/stale; innerhalb gleicher
    // Gruppe die neuesten zuerst.
    // Hinweis: `order[state] || 99` waere hier falsch, weil running===0 und
    // 0 || 99 in JS zu 99 wird. Deshalb explizite Pruefung.
    var rows = data.delegations.slice();
    rows.sort(function(a, b) {
      var order = {running:0, completed:1, failed:2, stale:3};
      var oa = (a && order.hasOwnProperty(a.state)) ? order[a.state] : 99;
      var ob = (b && order.hasOwnProperty(b.state)) ? order[b.state] : 99;
      if (oa !== ob) return oa - ob;
      return (b.dispatched_at || 0) - (a.dispatched_at || 0);
    });

    for (var i = 0; i < rows.length; i++) {
      var d = rows[i];
      var goal = '';
      if (d.tasks && d.tasks.length > 0 && d.tasks[0].goal) {
        goal = d.tasks[0].goal;
        if (goal.length > MAX_GOAL_LEN) goal = goal.substring(0, MAX_GOAL_LEN) + '\u2026';
      }
      var statusClass = 'dlgmon-status--' + (d.state || 'unknown');
      var duration = fmtDuration(d.dispatched_at, d.completed_at);
      var timeStr = fmtTime(d.dispatched_at);

      html += '<div class="dlgmon-row dlgmon-row-clickable" tabindex="0" role="button" data-dlgmon-id="' + esc(d.delegation_id) + '">';
      html += '<span class="dlgmon-status ' + statusClass + '"></span>';
      html += '<div class="dlgmon-content">';
      html += '<div class="dlgmon-goal" title="' + esc(goal) + '">' + esc(goal || T('dlgmon_no_goal', '(no goal)')) + '</div>';
      html += '<div class="dlgmon-meta">';
      html += '<span class="dlgmon-meta-item">' + esc(T('dlgmon_state_' + d.state, d.state)) + '</span>';
      html += '<span class="dlgmon-meta-item">' + esc(duration) + '</span>';
      html += '<span class="dlgmon-meta-item">' + taskCountText(d.task_count) + '</span>';
      html += '<span class="dlgmon-meta-item">' + timeStr + '</span>';
      html += '</div></div></div>';
    }

    panel.innerHTML = html;

    // Attach click/keyboard handlers to rows
    attachRowHandlers(panel, data);
  }

  /* ── Attach click/keyboard handlers to delegation rows ── */
  function attachRowHandlers(panel, data) {
    var rows = panel.querySelectorAll('.dlgmon-row-clickable');
    for (var i = 0; i < rows.length; i++) {
      (function(row) {
        var id = row.getAttribute('data-dlgmon-id');
        if (!id) return;

        function openDetail() {
          openDetailView(id, data);
        }

        row.addEventListener('click', function(ev) {
          ev.stopPropagation();
          openDetail();
        });

        row.addEventListener('keydown', function(ev) {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            ev.stopPropagation();
            openDetail();
          }
        });
      })(rows[i]);
    }
  }

  /* ── Detail view ── */

  function openDetailView(delegationId, data) {
    if (!isValidId(delegationId)) return;
    detailView = true;
    detailDelegationId = delegationId;
    detailAutoScroll = true;
    detailCurrentTask = 0;

    // Find delegation data
    var delegation = null;
    if (data && data.delegations) {
      for (var i = 0; i < data.delegations.length; i++) {
        if (data.delegations[i].delegation_id === delegationId) {
          delegation = data.delegations[i];
          break;
        }
      }
    }

    var panel = document.getElementById('dlgmon-panel');
    if (!panel) return;

    var html = renderDetailHeader(delegation, delegationId);
    html += '<div class="dlgmon-detail-body">';
    html += '<div class="dlgmon-detail-loading">' + T('dlgmon_loading_transcript', 'Loading transcript\u2026') + '</div>';
    html += '</div>';
    panel.innerHTML = html;

    // Fetch transcript
    fetchTranscript(delegationId, delegation);

    // Start detail polling if running
    if (delegation && delegation.state === 'running') {
      startDetailPolling(delegationId, delegation);
    }
  }

  function renderDetailHeader(delegation, delegationId) {
    var goal = '';
    var state = 'unknown';
    var duration = '';
    var taskCount = 0;

    if (delegation) {
      state = delegation.state || 'unknown';
      duration = fmtDuration(delegation.dispatched_at, delegation.completed_at);
      taskCount = delegation.task_count || 0;
      if (delegation.tasks && delegation.tasks.length > 0 && delegation.tasks[0].goal) {
        goal = delegation.tasks[0].goal;
      }
    }

    var html = '<div class="dlgmon-detail-header">';
    html += '<button class="dlgmon-back-btn" id="dlgmon-back-btn" title="' + esc(T('dlgmon_back_title', 'Back to list')) + '">' + T('dlgmon_back', '\u2190 Back') + '</button>';
    html += '<div class="dlgmon-detail-title" title="' + esc(goal) + '">' + esc(goal || delegationId) + '</div>';
    html += '<div class="dlgmon-detail-meta">';
    html += '<span class="dlgmon-status dlgmon-status--' + esc(state) + '"></span>';
    html += '<span>' + esc(T('dlgmon_state_' + state, state)) + '</span>';
    html += '<span> \u00b7 ' + esc(duration) + '</span>';
    html += '<span> \u00b7 ' + taskCountText(taskCount) + '</span>';
    html += '</div>';

    // Task tabs if multiple tasks
    if (taskCount > 1) {
      html += '<div class="dlgmon-task-tabs">';
      for (var t = 0; t < taskCount; t++) {
        var activeClass = (t === detailCurrentTask) ? ' dlgmon-task-tab--active' : '';
        html += '<button class="dlgmon-task-tab' + activeClass + '" data-dlgmon-task="' + t + '">' + T('dlgmon_task_tab', 'Task {0}', t + 1) + '</button>';
      }
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  function fetchTranscript(delegationId, delegation) {
    var url = LOGS_URL_PREFIX + encodeURIComponent(delegationId) + '.json';
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.setRequestHeader('Cache-Control', 'no-cache');
      xhr.timeout = 10000;
      xhr.onload = function() {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            var logData = JSON.parse(xhr.responseText);
            renderTranscript(logData, delegation);
          } catch (e) {
            renderTranscriptError(T('dlgmon_transcript_error', 'Transcript could not be read.'));
          }
        } else if (xhr.status === 404) {
          renderTranscriptError(T('dlgmon_no_transcript', 'No transcript available.'));
        } else {
          renderTranscriptError(T('dlgmon_load_error', 'Load failed (HTTP {0}).', xhr.status));
        }
      };
      xhr.onerror = function() {
        renderTranscriptError(T('dlgmon_no_transcript', 'No transcript available.'));
      };
      xhr.ontimeout = function() {
        renderTranscriptError(T('dlgmon_timeout', 'Request timed out.'));
      };
      xhr.send();
    } catch (e) {
      renderTranscriptError(T('dlgmon_no_transcript', 'No transcript available.'));
    }
  }

  function renderTranscript(logData, delegation) {
    var body = document.querySelector('#dlgmon-panel .dlgmon-detail-body');
    if (!body) return;

    // Find the current task
    var taskData = null;
    if (logData && logData.tasks) {
      for (var i = 0; i < logData.tasks.length; i++) {
        if (logData.tasks[i].index === detailCurrentTask) {
          taskData = logData.tasks[i];
          break;
        }
      }
    }

    if (!taskData || !taskData.lines || taskData.lines.length === 0) {
      body.innerHTML = '<div class="dlgmon-detail-empty">' + T('dlgmon_no_transcript', 'No transcript available.') + '</div>';
      return;
    }

    var html = '';
    if (taskData.truncated) {
      html += '<div class="dlgmon-truncated-hint">' + T('dlgmon_truncated', '\u2026 earlier lines truncated ({0} total)', formatBytes(taskData.bytes_total)) + '</div>';
    }

    html += '<div class="dlgmon-transcript" id="dlgmon-transcript">';
    for (var j = 0; j < taskData.lines.length; j++) {
      html += '<div class="dlgmon-line">' + esc(taskData.lines[j]) + '</div>';
    }
    html += '</div>';

    body.innerHTML = html;

    // Auto-scroll to bottom
    var transcript = document.getElementById('dlgmon-transcript');
    if (transcript) {
      transcript.scrollTop = transcript.scrollHeight;
    }

    // Attach scroll listener to detect user scrolling up
    attachTranscriptScrollListener();
  }

  function renderTranscriptError(message) {
    var body = document.querySelector('#dlgmon-panel .dlgmon-detail-body');
    if (!body) return;
    body.innerHTML = '<div class="dlgmon-detail-empty">' + esc(message) + '</div>';
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function attachTranscriptScrollListener() {
    var transcript = document.getElementById('dlgmon-transcript');
    if (!transcript) return;
    transcript.addEventListener('scroll', function() {
      // If user scrolled up more than 40px from bottom, disable auto-scroll
      var distanceFromBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
      detailAutoScroll = distanceFromBottom < 40;
    });
  }

  /* ── Detail polling ── */

  function startDetailPolling(delegationId, delegation) {
    stopDetailPolling();
    detailPollTimer = setInterval(function() {
      if (!panelOpen || !detailView) {
        stopDetailPolling();
        return;
      }
      fetchTranscript(delegationId, delegation);
    }, POLL_INTERVAL);
  }

  function stopDetailPolling() {
    if (detailPollTimer) {
      clearInterval(detailPollTimer);
      detailPollTimer = null;
    }
  }

  /* ── Back to list ── */

  function closeDetailView() {
    detailView = false;
    detailDelegationId = null;
    stopDetailPolling();
    detailAutoScroll = true;
    detailCurrentTask = 0;

    // Re-fetch data and render list
    fetchData(function(err, data) {
      if (!err) {
        renderPanel(data);
      }
    });
  }

  /* ── Event delegation for detail view interactions ── */

  function setupDetailEventDelegation() {
    document.addEventListener('click', function(ev) {
      try {
        // Back button
        if (ev.target && ev.target.id === 'dlgmon-back-btn') {
          ev.stopPropagation();
          closeDetailView();
          return;
        }

        // Task tabs
        if (ev.target && ev.target.classList.contains('dlgmon-task-tab')) {
          ev.stopPropagation();
          var taskIndex = parseInt(ev.target.getAttribute('data-dlgmon-task'), 10);
          if (!isNaN(taskIndex) && taskIndex !== detailCurrentTask) {
            detailCurrentTask = taskIndex;
            detailAutoScroll = true;
            // Re-render header to update active tab
            var panel = document.getElementById('dlgmon-panel');
            if (panel && detailDelegationId) {
              // Re-fetch transcript for new task
              var delegation = findDelegationById(detailDelegationId);
              var headerHtml = renderDetailHeader(delegation, detailDelegationId);
              var oldBody = panel.querySelector('.dlgmon-detail-body');
              var bodyHtml = oldBody ? oldBody.innerHTML : '<div class="dlgmon-detail-loading">' + T('dlgmon_loading_transcript', 'Loading transcript\u2026') + '</div>';
              panel.innerHTML = headerHtml + '<div class="dlgmon-detail-body">' + bodyHtml + '</div>';
              fetchTranscript(detailDelegationId, delegation);
            }
          }
        }
      } catch (e) { /* silent */ }
    }, true);
  }

  function findDelegationById(id) {
    // We don't cache the full data, so we fetch it
    return null; // Will be looked up from the log data
  }

  /* ── Fetch data ── */

  function fetchData(callback) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', DATA_URL, true);
      xhr.setRequestHeader('Cache-Control', 'no-cache');
      xhr.timeout = 10000;
      xhr.onload = function() {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            var data = JSON.parse(xhr.responseText);
            callback(null, data);
          } catch (e) {
            callback(e, null);
          }
        } else {
          callback(new Error('HTTP ' + xhr.status), null);
        }
      };
      xhr.onerror = function() {
        callback(new Error('Network error'), null);
      };
      xhr.ontimeout = function() {
        callback(new Error('Timeout'), null);
      };
      xhr.send();
    } catch (e) {
      callback(e, null);
    }
  }

  function updateButtonCount(data) {
    var btn = document.getElementById('dlgmon-btn');
    if (!btn) return;
    var n = runningCount(data);
    var badge = document.getElementById('dlgmon-badge');
    if (badge) {
      badge.textContent = n;
      badge.style.display = n > 0 ? 'inline-flex' : 'none';
    }
    btn.title = T('dlgmon_btn_title', 'Delegation Monitor ({0} running)', n);
  }

  function updatePanel(data) {
    renderPanel(data);
  }

  function handleData(err, data) {
    if (err) {
      console.warn('[delegation-monitor] fetch error:', err.message);
      return;
    }
    updateButtonCount(data);
    if (panelOpen) {
      updatePanel(data);
    }
  }

  /* ── Polling ── */

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function() {
      if (!panelOpen) {
        stopPolling();
        return;
      }
      fetchData(handleData);
    }, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /* ── Toggle panel ── */

  /* Panel liegt an document.body (ausserhalb des overflow:hidden der Sidebar).
     Position wird daher beim Oeffnen anhand der Button-Koordinaten gesetzt. */
  function positionPanel() {
    try {
      var panel = document.getElementById('dlgmon-panel');
      var btn = document.getElementById('dlgmon-btn');
      if (!panel || !btn) return;
      var b = btn.getBoundingClientRect();
      var margin = 12;
      var width = Math.min(420, window.innerWidth - margin * 2);
      var left = b.left;
      if (left + width > window.innerWidth - margin) {
        left = window.innerWidth - margin - width;
      }
      if (left < margin) left = margin;
      var top = b.bottom + 6;
      var maxH = Math.max(160, window.innerHeight - top - margin);
      panel.style.left = Math.round(left) + 'px';
      panel.style.top = Math.round(top) + 'px';
      panel.style.width = Math.round(width) + 'px';
      panel.style.maxHeight = Math.round(Math.min(480, maxH)) + 'px';
    } catch (e) {
      console.warn('[delegation-monitor] position error:', e.message);
    }
  }

  function togglePanel() {
    var panel = document.getElementById('dlgmon-panel');
    if (!panel) return;
    panelOpen = !panelOpen;
    if (panelOpen) {
      // Reset detail view state when opening
      detailView = false;
      detailDelegationId = null;
      stopDetailPolling();
      detailAutoScroll = true;
      detailCurrentTask = 0;

      panel.classList.add('dlgmon-open');
      positionPanel();
      // Fetch immediately, then start polling
      fetchData(function(err, data) {
        handleData(err, data);
        if (!err) startPolling();
      });
    } else {
      panel.classList.remove('dlgmon-open');
      stopPolling();
      stopDetailPolling();
      detailView = false;
      detailDelegationId = null;
    }
  }

  /* ── Build UI elements ── */

  function buildUI(anchor) {
    if (mounted) return;
    mounted = true;

    // 1. Button
    var btn = document.createElement('button');
    btn.id = 'dlgmon-btn';
    btn.className = 'panel-head-btn has-tooltip has-tooltip--bottom-right';
    btn.title = T('dlgmon_btn_title', 'Delegation Monitor ({0} running)', 0);
    btn.setAttribute('aria-label', 'Delegation Monitor');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:14px;height:14px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><span id="dlgmon-badge" class="dlgmon-badge" style="display:none">0</span>';
    btn.addEventListener('click', togglePanel);

    // 2. Panel (positioned relative to the head-actions container)
    var panel = document.createElement('div');
    panel.id = 'dlgmon-panel';
    panel.className = 'dlgmon-panel';
    panel.innerHTML = '<div class="dlgmon-empty">' + T('dlgmon_loading', 'Loading data\u2026') + '</div>';

    // 3. Wrapper nur fuer den Button. Das Panel kommt an document.body,
    //    weil #panelChat overflow:hidden hat und es sonst abgeschnitten wird.
    var wrapper = document.createElement('div');
    wrapper.id = 'dlgmon-wrapper';
    wrapper.style.cssText = 'position:relative;display:inline-flex;align-items:center;';
    wrapper.appendChild(btn);

    anchor.appendChild(wrapper);
    document.body.appendChild(panel);

    // Position bei Resize/Scroll nachfuehren, solange offen
    window.addEventListener('resize', function() { if (panelOpen) positionPanel(); });
    window.addEventListener('scroll', function() { if (panelOpen) positionPanel(); }, true);

    // Klick ausserhalb schliesst das Panel
    document.addEventListener('click', function(ev) {
      try {
        if (!panelOpen) return;
        if (btn.contains(ev.target) || panel.contains(ev.target)) return;
        panelOpen = false;
        panel.classList.remove('dlgmon-open');
        stopPolling();
        stopDetailPolling();
        detailView = false;
        detailDelegationId = null;
      } catch (e) { /* still */ }
    }, true);

    // 4. Initial fetch for button count
    fetchData(function(err, data) {
      if (!err) updateButtonCount(data);
    });

    // 5. Setup event delegation for detail view interactions
    setupDetailEventDelegation();
  }

  /* ── Mount with MutationObserver + timeout fallback ── */

  function tryMount() {
    try {
      var anchor = qs('#panelChat .panel-head-actions');
      if (anchor && !document.getElementById('dlgmon-wrapper')) {
        buildUI(anchor);
        return true;
      }
    } catch (e) {
      console.warn('[delegation-monitor] mount check error:', e.message);
    }
    return false;
  }

  function mount() {
    if (tryMount()) return;

    var startTime = Date.now();
    var observer = null;
    var timeoutId = null;

    function onMutation() {
      if (Date.now() - startTime > MOUNT_TIMEOUT) {
        cleanup();
        return;
      }
      if (tryMount()) {
        cleanup();
      }
    }

    function cleanup() {
      if (observer) { observer.disconnect(); observer = null; }
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
    }

    // Fallback timeout
    timeoutId = setTimeout(function() {
      if (!mounted) {
        tryMount(); // last attempt
        if (observer) observer.disconnect();
      }
    }, MOUNT_TIMEOUT);

    // MutationObserver on the body
    try {
      observer = new MutationObserver(onMutation);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: false,
      });
    } catch (e) {
      console.warn('[delegation-monitor] observer error:', e.message);
      // Fallback: poll manually
      var pollFallback = setInterval(function() {
        if (mounted || Date.now() - startTime > MOUNT_TIMEOUT) {
          clearInterval(pollFallback);
          return;
        }
        tryMount();
      }, 200);
    }
  }

  /* ── Bootstrap ── */

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
