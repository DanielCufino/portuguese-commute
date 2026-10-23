(() => {
  'use strict';

  const KEY = 'portuguese-commute-v1';
  const $ = id => document.getElementById(id);
  const audio = $('lesson-audio');
  const defaults = () => ({ version: 1, lessonId: '', minutes: 20, speed: 1, pageZoom: 1, activity: 'listen', notes: {}, answers: {}, reviewed: {}, excerpts: {}, pageByLesson: {}, trackByLesson: {} });
  let state = defaults();
  let course, lesson, track, activeClip, activeKey, loop = false, frame, stopTimer, playRequest = 0, downloading = false;
  let offlineReady = false;

  try { state = { ...state, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (_) { /* Keep studying if a previous local save is unavailable. */ }
  for (const key of ['notes', 'answers', 'reviewed', 'excerpts', 'pageByLesson', 'trackByLesson']) {
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) state[key] = {};
  }
  if (![10, 20, 30].includes(state.minutes)) state.minutes = 20;
  if (![0.75, 0.9, 1, 1.15].includes(Number(state.speed))) state.speed = 1;
  if (![1, 1.25, 1.5, 2].includes(Number(state.pageZoom))) state.pageZoom = 1;
  if (!['listen', 'write'].includes(state.activity)) state.activity = 'listen';

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
    catch (_) { $('notes-status').textContent = 'Device storage unavailable — export a backup.'; return false; }
  }
  function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }
  function time(value) {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function editTime(value) {
    const seconds = Math.max(0, Number(value) || 0);
    const part = (seconds % 60).toFixed(1).replace(/\.0$/, '');
    return `${Math.floor(seconds / 60)}:${part.padStart(part.includes('.') ? 4 : 2, '0')}`;
  }
  function parseTime(value) {
    const text = String(value).trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
    if (/^\d+:\d{1,2}(?:\.\d+)?$/.test(text)) {
      const [minutes, seconds] = text.split(':').map(Number);
      return seconds < 60 ? minutes * 60 + seconds : NaN;
    }
    return NaN;
  }
  function clipKey(clip) { return `${lesson.id}/${track.id}/${clip.id}`; }
  function customKey() { return `${lesson.id}/${track.id}`; }
  function customClips() { const clips = state.excerpts[customKey()]; return Array.isArray(clips) ? clips : []; }
  function allClips() { return [...(track?.clips || []), ...customClips()]; }
  function validClip(clip) { return clip && Number.isFinite(Number(clip.start)) && Number.isFinite(Number(clip.end)) && Number(clip.end) > Number(clip.start); }
  function clipTitle(clip) { return clip.text || clip.label || `Listen: ${time(clip.start)}–${time(clip.end)}`; }

  function setMinutes(minutes) {
    state.minutes = minutes;
    document.querySelectorAll('[data-minutes]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.minutes) === minutes)));
    $('session-plan').textContent = `${Math.round(minutes * .6)} min listen · ${Math.round(minutes * .2)} min read · ${Math.round(minutes * .2)} min write`;
    persist();
  }

  function setActivity(activity) {
    state.activity = activity;
    ['listen', 'write'].forEach(name => {
      const selected = name === activity;
      $(`${name}-tab`).setAttribute('aria-selected', String(selected));
      $(`${name}-tab`).tabIndex = selected ? 0 : -1;
      $(`${name}-view`).hidden = !selected;
    });
    persist();
  }

  function setPageZoom(zoom) {
    state.pageZoom = zoom;
    $('page-zoom').value = String(zoom);
    $('page-open').style.width = `${zoom * 100}%`;
    persist();
  }

  function updateConnection() {
    $('connection-status').classList.toggle('offline', !navigator.onLine);
    $('connection-status').innerHTML = `<span class="status-dot" aria-hidden="true"></span>${navigator.onLine ? 'Online · prepare your ride' : 'Offline · use saved lessons'}`;
  }

  function pauseAudio() {
    playRequest += 1;
    audio.pause();
    cancelAnimationFrame(frame);
    clearTimeout(stopTimer);
    updatePlaybackUI();
  }

  function resetPlayer() {
    pauseAudio();
    activeClip = null;
    activeKey = null;
    $('player-title').textContent = 'Tap a line to listen';
    $('player-progress').value = 0;
    $('player-time').textContent = '0:00 / 0:00';
    ['player-toggle', 'replay', 'loop-toggle', 'set-start', 'set-end', 'save-excerpt'].forEach(id => $(id).disabled = true);
    $('excerpt-start').value = '';
    $('excerpt-end').value = '';
    $('excerpt-status').textContent = '';
    $('audio-status').textContent = '';
  }

  function renderLesson(id) {
    resetPlayer();
    lesson = course.lessons.find(item => item.id === id) || course.lessons[0];
    state.lessonId = lesson.id;
    $('lesson-select').value = lesson.id;
    const lessonIndex = course.lessons.indexOf(lesson) + 1;
    $('lesson-number').textContent = `Lesson ${String(lessonIndex).padStart(2, '0')} · listen in small pieces`;
    $('lesson-title').textContent = lesson.title;
    $('lesson-description').textContent = lesson.subtitle || lesson.description || '';
    $('track-select').innerHTML = (lesson.tracks || []).map(item => `<option value="${escape(item.id)}">${escape(item.title)}${item.clips?.length ? ` · ${item.clips.length} clips` : ''}</option>`).join('');
    $('track-select').disabled = !lesson.tracks?.length;
    $('lesson-notes').value = typeof state.notes[lesson.id] === 'string' ? state.notes[lesson.id] : '';
    $('notes-status').textContent = 'Saved on this device';
    const prompts = lesson.prompts?.length ? lesson.prompts : ['Write down three words you recognize from Spanish.', 'Keep one Portuguese phrase and write what you think it means.', 'Write one question to ask your friend later.'];
    $('prompts').innerHTML = prompts.map(prompt => `<li>${escape(prompt)}</li>`).join('');
    $('writing-exercises').innerHTML = (lesson.writingExercises || []).map((exercise, index) => {
      const id = `${lesson.id}/${exercise.id || index}`;
      return `<div class="writing-exercise"><label for="answer-${index}"><span class="eyebrow">Try it ${index + 1}</span>${escape(exercise.prompt)}</label><textarea id="answer-${index}" data-answer="${escape(id)}" rows="2" lang="pt-BR" placeholder="Your answer…">${escape(typeof state.answers[id] === 'string' ? state.answers[id] : '')}</textarea><details><summary>Show model answer</summary><p lang="pt-BR">${escape(exercise.answer)}</p></details></div>`;
    }).join('');
    $('page-select').innerHTML = (lesson.pages || []).map((page, i) => `<option value="${i}">${escape(page.label || `Page ${i + 1}`)}</option>`).join('');
    const firstDialoguePage = (lesson.pages || []).findIndex(page => Number(page.index) === Number(lesson.tracks?.[0]?.clips?.[0]?.pageIndex));
    renderPage(state.pageByLesson[lesson.id] !== undefined ? Number(state.pageByLesson[lesson.id]) || 0 : Math.max(0, firstDialoguePage));
    const savedTrack = lesson.tracks?.find(item => item.id === state.trackByLesson[lesson.id]);
    renderTrack(savedTrack?.id || lesson.tracks?.[0]?.id);
    persist();
    updateOfflineStatus();
  }

  function renderTrack(id) {
    resetPlayer();
    track = lesson.tracks?.find(item => item.id === id) || lesson.tracks?.[0];
    if (!track) { $('clip-list').innerHTML = '<p class="empty-clips">No audio is included with this lesson yet.</p>'; return; }
    $('track-select').value = track.id;
    $('alignment-note').textContent = track.clips?.some(clip => clip.text)
      ? 'Read a line, then tap to hear its original audio. Use replay or slow playback to catch the sounds.'
      : 'These short audio excerpts follow pauses in the original recording. The book pages are alongside for reference; these excerpts do not have aligned transcripts.';
    $('transcript-toggle').hidden = !track.clips?.some(clip => clip.text);
    $('transcript-toggle').setAttribute('aria-pressed', 'false');
    $('transcript-toggle').textContent = 'Hide Portuguese · listen first';
    $('clip-list').classList.remove('hide-transcript');
    state.trackByLesson[lesson.id] = track.id;
    renderClips();
    persist();
  }

  function renderClips() {
    const original = (track.clips || []).filter(validClip);
    const custom = customClips().filter(validClip);
    const render = (clip, index, saved = false) => {
      const key = clipKey(clip);
      const reviewed = Boolean(state.reviewed[key]);
      const active = activeKey === key;
      const hasPage = clip.pageIndex !== undefined && lesson.pages?.some(page => Number(page.index) === Number(clip.pageIndex));
      return `<article class="clip-card${active ? ' active' : ''}${reviewed ? ' reviewed' : ''}" data-clip-card="${escape(clip.id)}">
        <button type="button" class="clip-play" data-play="${escape(clip.id)}" aria-label="${escape(active && !audio.paused ? 'Pause' : 'Play')} ${escape(clipTitle(clip))}">${active && !audio.paused ? 'Ⅱ' : '▶'}</button>
        <div><p class="clip-label">${saved ? 'Your excerpt' : clip.text && clip.label ? escape(clip.label) : `Excerpt ${String(index + 1).padStart(2, '0')}`} · ${Math.round(Number(clip.end) - Number(clip.start))} sec</p><p class="clip-text"${clip.text ? ' lang="pt-BR"' : ''}>${escape(clipTitle(clip))}</p>${clip.translation ? `<p class="clip-translation">${escape(clip.translation)}</p>` : ''}<div class="clip-meta"><span>${time(clip.start)}–${time(clip.end)}</span>${hasPage ? `<button type="button" class="clip-page" data-page="${escape(clip.pageIndex)}">Show book page</button>` : ''}${saved ? `<button type="button" class="delete-clip" data-delete="${escape(clip.id)}" aria-label="Delete saved excerpt ${escape(clipTitle(clip))}">Delete excerpt</button>` : ''}</div></div>
        <button type="button" class="review-button" data-review="${escape(clip.id)}" aria-label="${reviewed ? 'Unmark' : 'Mark'} excerpt as reviewed" aria-pressed="${reviewed}" title="${reviewed ? 'Reviewed — tap to unmark' : 'Mark as reviewed'}"><span aria-hidden="true">${reviewed ? '✓' : ''}</span></button>
      </article>`;
    };
    $('clip-list').innerHTML = original.map((clip, index) => render(clip, index)).join('') + (custom.length ? '<p class="saved-heading">Your saved excerpts</p>' + custom.map((clip, index) => render(clip, index, true)).join('') : '') || '<p class="empty-clips">No excerpts are available for this track.</p>';
    updateReviewCount();
  }

  function updateReviewCount() {
    const clips = allClips().filter(validClip);
    const reviewed = clips.filter(clip => state.reviewed[clipKey(clip)]).length;
    $('review-count').textContent = `${reviewed} / ${clips.length} checked`;
    $('review-count').title = 'Only excerpts you explicitly mark as reviewed count here.';
  }

  function renderPage(index) {
    const pages = lesson.pages || [];
    index = Math.max(0, Math.min(index, pages.length - 1));
    const page = pages[index];
    $('page-select').value = String(index);
    $('page-prev').disabled = index === 0 || !page;
    $('page-next').disabled = index >= pages.length - 1 || !page;
    $('page-open').hidden = !page;
    if (page) {
      const changed = $('book-page').getAttribute('src') !== page.src;
      $('book-page').src = page.src;
      $('book-page').alt = `${lesson.title} — ${page.label || `page ${index + 1}`} from the original FSI course`;
      $('page-caption').textContent = `${page.label || `Page ${index + 1}`} · Zoom above; scroll this page here.`;
      if (changed) { $('page-scroll').scrollTop = 0; $('page-scroll').scrollLeft = 0; }
    } else $('page-caption').textContent = 'No book page is included with this lesson yet.';
    state.pageByLesson[lesson.id] = index;
    persist();
  }

  function showClipPage(clip) {
    if (clip.pageIndex === undefined) return;
    const index = (lesson.pages || []).findIndex(page => Number(page.index) === Number(clip.pageIndex));
    if (index >= 0) renderPage(index);
  }

  function updatePlaybackUI() {
    const playing = activeClip && !audio.paused;
    $('player-toggle').textContent = playing ? 'Ⅱ' : '▶';
    $('player-toggle').setAttribute('aria-label', playing ? 'Pause selected excerpt' : 'Play selected excerpt');
    document.querySelectorAll('[data-clip-card]').forEach(card => {
      const isActive = activeClip?.id === card.dataset.clipCard;
      card.classList.toggle('active', isActive);
      const button = card.querySelector('[data-play]');
      button.textContent = isActive && playing ? 'Ⅱ' : '▶';
      const clip = allClips().find(item => item.id === card.dataset.clipCard);
      button.setAttribute('aria-label', `${isActive && playing ? 'Pause' : 'Play'} ${clip ? clipTitle(clip) : 'excerpt'}`);
    });
  }

  function updateTime() {
    if (!activeClip) return;
    const duration = Number(activeClip.end) - Number(activeClip.start);
    const elapsed = Math.max(0, Math.min(duration, audio.currentTime - Number(activeClip.start)));
    $('player-progress').value = duration > 0 ? elapsed / duration : 0;
    $('player-time').textContent = `${time(elapsed)} / ${time(duration)}`;
  }

  function atBoundary() {
    if (!activeClip || audio.paused) return;
    if (audio.currentTime >= Number(activeClip.end) - .025 || audio.ended) {
      if (loop) {
        audio.currentTime = Number(activeClip.start);
        if (audio.paused) audio.play().catch(handleAudioError);
        scheduleBoundary();
      } else {
        audio.pause();
        audio.currentTime = Math.min(Number(activeClip.end), Number.isFinite(audio.duration) ? audio.duration : Number(activeClip.end));
        clearTimeout(stopTimer);
        updatePlaybackUI();
        updateTime();
      }
    }
  }

  function scheduleBoundary() {
    clearTimeout(stopTimer);
    if (!activeClip || audio.paused) return;
    const remaining = (Number(activeClip.end) - audio.currentTime) / audio.playbackRate;
    stopTimer = setTimeout(() => { atBoundary(); if (!audio.paused) scheduleBoundary(); }, Math.max(20, remaining * 1000));
  }

  function animate() {
    updateTime();
    atBoundary();
    if (!audio.paused) frame = requestAnimationFrame(animate);
  }

  function handleAudioError(error) {
    if (error?.name === 'AbortError') return;
    $('audio-status').textContent = navigator.onLine ? 'Could not play this audio. Try the excerpt again, or download the lesson first.' : 'This audio is unavailable offline. Download this lesson while connected before your next ride.';
    updatePlaybackUI();
  }

  async function playClip(clip, restart = true) {
    if (!validClip(clip)) return;
    const request = ++playRequest;
    audio.pause();
    clearTimeout(stopTimer);
    activeClip = clip;
    activeKey = clipKey(clip);
    $('audio-status').textContent = '';
    $('player-title').textContent = clipTitle(clip);
    ['player-toggle', 'replay', 'loop-toggle', 'set-start', 'set-end', 'save-excerpt'].forEach(id => $(id).disabled = false);
    $('excerpt-start').value = editTime(clip.start);
    $('excerpt-end').value = editTime(clip.end);
    $('excerpt-status').textContent = '';
    const src = new URL(track.src, location.href).href;
    const changed = audio.src !== src;
    if (changed) audio.src = src;
    if (changed || restart || audio.currentTime < Number(clip.start) || audio.currentTime >= Number(clip.end) - .05) {
      const target = Number(clip.start);
      const seek = () => { if (request === playRequest) audio.currentTime = target; };
      if (audio.readyState >= 1) seek();
      else audio.addEventListener('loadedmetadata', seek, { once: true });
    }
    audio.playbackRate = Number(state.speed);
    showClipPage(clip);
    updatePlaybackUI();
    updateTime();
    try {
      await audio.play();
      if (request !== playRequest) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(animate);
      scheduleBoundary();
      updatePlaybackUI();
    } catch (error) { if (request === playRequest) handleAudioError(error); }
  }

  async function updateOfflineStatus() {
    if (!lesson || downloading) return;
    const currentLesson = lesson;
    const button = $('download-lesson');
    $('remove-download').hidden = true;
    if (!offlineReady) {
      button.disabled = true;
      $('download-status').textContent = location.protocol === 'file:' ? 'Offline download needs this app opened from its HTTPS address in Safari.' : 'Offline setup unavailable. Open the app over HTTPS or localhost.';
      return;
    }
    try {
      const saved = await window.PortugueseOffline.isLessonSaved(currentLesson);
      if (lesson.id !== currentLesson.id || downloading) return;
      button.disabled = saved || !navigator.onLine;
      button.innerHTML = saved ? '<span aria-hidden="true">✓</span> Saved for offline' : '<span aria-hidden="true">↓</span> Download for the ride';
      $('download-status').textContent = saved ? 'Audio and pages checked on this device.' : navigator.onLine ? 'Save audio and book pages before leaving Wi-Fi.' : 'This lesson has not been fully downloaded.';
      $('remove-download').hidden = !saved;
    } catch (_) {
      button.disabled = false;
      $('download-status').textContent = 'Could not check saved files. Try downloading again.';
    }
  }

  async function downloadLesson() {
    if (downloading || !lesson) return;
    downloading = true;
    const currentLesson = lesson;
    $('download-lesson').disabled = true;
    $('lesson-select').disabled = true;
    $('download-lesson').textContent = 'Saving lesson…';
    $('download-status').textContent = 'Keep this app open until the download finishes.';
    try {
      await window.PortugueseOffline.downloadLesson(currentLesson, progress => {
        $('download-status').textContent = `Saving ${progress.completed} of ${progress.total} files${progress.bytes ? ` · ${(progress.bytes / 1048576).toFixed(1)} MB` : ''}. Keep this app open.`;
      });
      const saved = await window.PortugueseOffline.isLessonSaved(currentLesson);
      if (!saved) throw new Error('The downloaded files could not be verified.');
      downloading = false;
      await updateOfflineStatus();
    } catch (error) {
      downloading = false;
      $('download-lesson').disabled = false;
      $('download-lesson').textContent = 'Retry download';
      $('download-status').textContent = `Download incomplete: ${error.message || 'please reconnect and retry.'}`;
    } finally { $('lesson-select').disabled = false; }
  }

  function saveExcerpt() {
    if (!track) return;
    const start = parseTime($('excerpt-start').value), end = parseTime($('excerpt-end').value);
    const duration = Number(track.duration) || (Number.isFinite(audio.duration) ? audio.duration : Infinity);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + .1) {
      $('excerpt-status').textContent = `Use a start before the end, within this track${Number.isFinite(duration) ? ` (0:00–${time(duration)})` : ''}.`;
      return;
    }
    const excerpt = { id: `saved-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, start, end, label: `My excerpt: ${time(start)}–${time(end)}` };
    if (activeClip?.pageIndex !== undefined) excerpt.pageIndex = activeClip.pageIndex;
    state.excerpts[customKey()] = [...customClips(), excerpt];
    const stored = persist();
    renderClips();
    $('excerpt-status').textContent = stored ? 'Excerpt saved below this track’s original excerpts.' : 'Excerpt added for this session. Export a backup to keep it.';
  }

  function exportBackup() {
    const backup = { app: 'portuguese-commute', exportedAt: new Date().toISOString(), ...state };
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `portuguese-notes-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    $('backup-status').textContent = 'Backup prepared. Save it to Files; downloaded audio is not part of this backup.';
  }

  async function importBackup(file) {
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('This file is too large for a notes backup.');
      const imported = JSON.parse(await file.text());
      if (imported.app !== 'portuguese-commute' || imported.version !== 1) throw new Error('Choose a backup exported by this app.');
      for (const key of ['notes', 'answers', 'reviewed', 'excerpts']) {
        const values = imported[key];
        if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
        for (const [id, value] of Object.entries(values)) {
          if (['__proto__', 'constructor', 'prototype'].includes(id)) continue;
          if ((key === 'notes' || key === 'answers') && typeof value === 'string') state[key][id] = value;
          if (key === 'reviewed' && typeof value === 'boolean') state.reviewed[id] = value;
          if (key === 'excerpts' && Array.isArray(value)) {
            const existing = Array.isArray(state.excerpts[id]) ? state.excerpts[id] : [];
            const merged = new Map(existing.map(clip => [clip.id, clip]));
            value.filter(clip => validClip(clip) && typeof clip.id === 'string').forEach(clip => merged.set(clip.id, { id: clip.id, start: Number(clip.start), end: Number(clip.end), label: typeof clip.label === 'string' ? clip.label : 'Saved excerpt', ...(Number.isFinite(Number(clip.pageIndex)) ? { pageIndex: Number(clip.pageIndex) } : {}) }));
            state.excerpts[id] = [...merged.values()];
          }
        }
      }
      const stored = persist();
      renderLesson(lesson.id);
      $('backup-status').textContent = stored ? 'Notes and progress imported. Matching notes use the backup’s version.' : 'Backup loaded for this session; device storage remains unavailable.';
    } catch (error) { $('backup-status').textContent = `Could not import: ${error.message}`; }
    $('import-notes').value = '';
  }

  document.querySelectorAll('[data-minutes]').forEach(button => button.addEventListener('click', () => setMinutes(Number(button.dataset.minutes))));
  $('lesson-select').addEventListener('change', event => renderLesson(event.target.value));
  $('track-select').addEventListener('change', event => renderTrack(event.target.value));
  $('transcript-toggle').addEventListener('click', () => {
    const hidden = $('clip-list').classList.toggle('hide-transcript');
    $('transcript-toggle').setAttribute('aria-pressed', String(hidden));
    $('transcript-toggle').textContent = hidden ? 'Show Portuguese · check what you heard' : 'Hide Portuguese · listen first';
  });
  $('page-select').addEventListener('change', event => renderPage(Number(event.target.value)));
  $('page-prev').addEventListener('click', () => renderPage(Number($('page-select').value) - 1));
  $('page-next').addEventListener('click', () => renderPage(Number($('page-select').value) + 1));
  $('page-zoom').addEventListener('change', event => setPageZoom(Number(event.target.value)));
  ['listen', 'write'].forEach(name => {
    $(`${name}-tab`).addEventListener('click', () => setActivity(name));
    $(`${name}-tab`).addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'listen' : event.key === 'End' ? 'write' : name === 'listen' ? 'write' : 'listen';
      setActivity(next);
      $(`${next}-tab`).focus();
    });
  });
  $('about-toggle').addEventListener('click', () => $('about-dialog').showModal());
  $('about-close').addEventListener('click', () => $('about-dialog').close());
  $('clip-list').addEventListener('click', event => {
    const play = event.target.closest('[data-play]');
    const review = event.target.closest('[data-review]');
    const page = event.target.closest('[data-page]');
    const remove = event.target.closest('[data-delete]');
    if (play) {
      const clip = allClips().find(item => item.id === play.dataset.play);
      if (!clip) return;
      if (activeKey === clipKey(clip) && !audio.paused) pauseAudio();
      else playClip(clip, activeKey !== clipKey(clip));
    } else if (review) {
      const clip = allClips().find(item => item.id === review.dataset.review);
      if (!clip) return;
      const key = clipKey(clip);
      state.reviewed[key] = !state.reviewed[key];
      persist();
      review.setAttribute('aria-pressed', String(state.reviewed[key]));
      review.setAttribute('aria-label', `${state.reviewed[key] ? 'Unmark' : 'Mark'} excerpt as reviewed`);
      review.querySelector('span').textContent = state.reviewed[key] ? '✓' : '';
      review.closest('.clip-card').classList.toggle('reviewed', state.reviewed[key]);
      updateReviewCount();
    } else if (page) showClipPage({ pageIndex: Number(page.dataset.page) });
    else if (remove) {
      if (activeClip?.id === remove.dataset.delete) resetPlayer();
      state.excerpts[customKey()] = customClips().filter(clip => clip.id !== remove.dataset.delete);
      delete state.reviewed[`${lesson.id}/${track.id}/${remove.dataset.delete}`];
      persist();
      renderClips();
    }
  });
  $('player-toggle').addEventListener('click', () => { if (activeClip) audio.paused ? playClip(activeClip, false) : pauseAudio(); });
  $('replay').addEventListener('click', () => { if (activeClip) playClip(activeClip); });
  $('loop-toggle').addEventListener('click', () => { loop = !loop; $('loop-toggle').setAttribute('aria-pressed', String(loop)); });
  $('playback-speed').value = String(state.speed);
  $('playback-speed').addEventListener('change', event => { state.speed = Number(event.target.value); audio.playbackRate = state.speed; scheduleBoundary(); persist(); });
  $('set-start').addEventListener('click', () => { $('excerpt-start').value = editTime(audio.currentTime); });
  $('set-end').addEventListener('click', () => { $('excerpt-end').value = editTime(audio.currentTime); });
  $('save-excerpt').addEventListener('click', saveExcerpt);
  $('lesson-notes').addEventListener('input', () => { if (lesson) { state.notes[lesson.id] = $('lesson-notes').value; if (persist()) $('notes-status').textContent = 'Saved on this device'; } });
  $('writing-exercises').addEventListener('input', event => { if (event.target.dataset.answer) { state.answers[event.target.dataset.answer] = event.target.value; if (persist()) $('notes-status').textContent = 'Saved on this device'; } });
  $('export-notes').addEventListener('click', exportBackup);
  $('import-notes').addEventListener('change', event => importBackup(event.target.files[0]));
  $('download-lesson').addEventListener('click', downloadLesson);
  $('remove-download').addEventListener('click', async () => {
    if (downloading) return;
    pauseAudio();
    try { await window.PortugueseOffline.removeLesson(lesson); await updateOfflineStatus(); }
    catch (error) { $('download-status').textContent = `Could not remove download: ${error.message}`; }
  });
  audio.addEventListener('timeupdate', () => { updateTime(); atBoundary(); });
  audio.addEventListener('pause', () => { cancelAnimationFrame(frame); clearTimeout(stopTimer); updatePlaybackUI(); });
  audio.addEventListener('play', () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(animate); scheduleBoundary(); updatePlaybackUI(); });
  audio.addEventListener('seeked', () => { scheduleBoundary(); updateTime(); });
  audio.addEventListener('ended', () => { if (loop && activeClip) playClip(activeClip); else updatePlaybackUI(); });
  audio.addEventListener('error', handleAudioError);
  window.addEventListener('online', () => { updateConnection(); updateOfflineStatus(); });
  window.addEventListener('offline', () => { updateConnection(); updateOfflineStatus(); });
  window.addEventListener('pagehide', () => { pauseAudio(); persist(); });

  async function start() {
    updateConnection();
    setMinutes(state.minutes);
    setActivity(state.activity);
    setPageZoom(Number(state.pageZoom));
    try {
      const response = await fetch('course-data.json');
      if (!response.ok) throw new Error(`Course data returned ${response.status}.`);
      course = await response.json();
      if (!Array.isArray(course.lessons) || !course.lessons.length) throw new Error('The course has no lessons.');
      $('lesson-select').innerHTML = course.lessons.map((item, index) => `<option value="${escape(item.id)}">${String(index + 1).padStart(2, '0')} · ${escape(item.title)}</option>`).join('');
      $('lesson-select').disabled = false;
      if (course.sourceUrl) $('source-link').href = course.sourceUrl;
      $('course-attribution').textContent = course.attribution || 'Original teaching materials: Foreign Service Institute. Course made available by Live Lingua.';
      renderLesson(state.lessonId);
    } catch (error) {
      $('load-error').hidden = false;
      $('load-error').textContent = `The lesson library could not load. ${location.protocol === 'file:' ? 'Open this app from its HTTPS address in Safari, then download a lesson.' : 'Connect to Wi-Fi and reload; the app needs an initial download.'} ${error.message}`;
      return;
    }
    try {
      if (window.PortugueseOffline) {
        const result = await window.PortugueseOffline.ready();
        offlineReady = Boolean(result?.supported ?? result?.registration ?? result === true);
      }
    } catch (_) { offlineReady = false; }
    await updateOfflineStatus();
  }
  start();
})();
