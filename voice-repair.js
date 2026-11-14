(() => {
  'use strict';
  // Runs after the existing inline app script. It only owns voice controls while
  // hands-free/push-to-talk is active; the chat UI and AI Worker remain untouched.
  const WORKER_URL = 'https://jarvis-ai.seblpoulsen.workers.dev/';
  const $ = id => document.getElementById(id);
  const recCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  const el = {
    handsfree: $('handsfree-button'), mic: $('mic-button'), stop: $('stop-listening-button'),
    state: $('listen-state'), stateText: $('listen-state-text'), log: $('chatlog'),
    form: $('composer'), input: $('msg'), voice: $('voice-enabled'), mute: $('mute-button'),
    continuous: $('continuous-enabled'), interrupt: $('barge-in-enabled'),
    silence: $('silence-timeout'), voiceStatus: $('voice-status-label'),
    notice: $('notice'), reactor: $('reactor')
  };
  if (!el.handsfree || !el.form || !el.log) return;

  const s = {
    recognition: null, active: false, phase: 'idle', running: false, starting: false,
    stopping: false, nextPhase: null, restarts: 0, restartTimer: 0, silenceTimer: 0,
    responseTimer: 0, commandText: '', lastSent: '', lastSentAt: 0,
    pendingWake: false, speaking: false, muted: false, manualPush: false,
    sessionBeforePush: false, observer: null, speechRun: 0
  };
  const labels = {
    idle: 'IDLE · MICROPHONE OFF', starting: 'STARTING MICROPHONE',
    wake: 'LISTENING FOR JARVIS', activated: 'JARVIS ACTIVATED',
    command: 'LISTENING TO COMMAND', thinking: 'THINKING',
    speaking: 'SPEAKING', resuming: 'RESUMING LISTENING',
    error: 'MICROPHONE ERROR', unsupported: 'SPEECH RECOGNITION UNAVAILABLE'
  };

  function notify(message) {
    if (!el.notice) { window.alert(message); return; }
    el.notice.textContent = message;
    el.notice.classList.add('show');
    clearTimeout(s.noticeTimer);
    s.noticeTimer = setTimeout(() => el.notice.classList.remove('show'), 4200);
  }
  function status(phase) {
    s.phase = phase;
    el.state.dataset.state = phase;
    el.stateText.textContent = labels[phase] || phase.toUpperCase();
    el.handsfree.classList.toggle('active', s.active);
    el.handsfree.setAttribute('aria-label', s.active ? 'Turn hands-free mode off' : 'Start hands-free mode');
    el.handsfree.title = s.active ? 'Hands-free is on — turn off' : 'Start hands-free mode';
    el.stop.hidden = !s.active && !s.manualPush;
    if (el.voiceStatus) {
      el.voiceStatus.textContent = phase === 'error' ? 'MICROPHONE ERROR' : s.running ? 'MICROPHONE ACTIVE' : s.active ? 'MICROPHONE STARTING' : 'READY';
    }
  }
  function wakeTail(text) {
    const normalized = String(text).toLowerCase()
      .replace(/\b(?:jarv(?:is|us|iss|iz)|jervis|jarvies)\b/g, 'jarvis')
      .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const match = normalized.match(/\b(?:hey\s+)?jarvis\b/);
    return match ? normalized.slice(match.index + match[0].length).trim().replace(/^please\s*/, '') : null;
  }
  function stopPhrase(text) {
    return /\b(?:jarvis\s+)?(?:stop|turn off|disable|cancel)\s+(?:the\s+)?(?:hands[- ]?free|listening|microphone|voice mode)\b/i.test(text) || /^stop listening$/i.test(text.trim());
  }
  function sound() {
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return;
      const context = new Audio(), oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.frequency.value = 740;
      gain.gain.setValueAtTime(.02, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .12);
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.start(); oscillator.stop(context.currentTime + .12);
      oscillator.onended = () => context.close();
    } catch (_) { /* Visual activation remains available if audio is blocked. */ }
  }
  function browserVoice() {
    const voices = window.speechSynthesis?.getVoices?.() || [];
    return voices.filter(v => /^en[-_]gb/i.test(v.lang)).sort((a, b) => {
      const score = v => (/natural|neural|enhanced|premium/i.test(v.name) ? 2 : 0) + (/daniel|ryan|male/i.test(v.name.toLowerCase()) ? 1 : 0);
      return score(b) - score(a);
    })[0] || voices.find(v => /^en/i.test(v.lang)) || null;
  }
  function speak(text, complete) {
    const synth = window.speechSynthesis;
    if (!synth || !window.SpeechSynthesisUtterance || s.muted || (el.voice && !el.voice.checked)) {
      complete?.(); return;
    }
    const run = ++s.speechRun;
    synth.cancel();
    const parts = String(text).match(/[^.!?]+[.!?]*/g) || [String(text)];
    let index = 0;
    const next = () => {
      if (run !== s.speechRun) return;
      if (index >= parts.length) { s.speaking = false; complete?.(); return; }
      const utterance = new SpeechSynthesisUtterance(parts[index++].trim());
      const voice = browserVoice();
      if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
      else utterance.lang = 'en-GB';
      utterance.rate = .92; utterance.pitch = .9; utterance.volume = 1;
      utterance.onend = () => setTimeout(next, 130);
      utterance.onerror = event => {
        if (run !== s.speechRun) return;
        s.speaking = false;
        if (event.error !== 'canceled' && event.error !== 'interrupted') complete?.();
      };
      try { s.speaking = true; synth.speak(utterance); }
      catch (_) { s.speaking = false; complete?.(); }
    };
    next();
  }
  function stopSpeaking() {
    s.speechRun++;
    s.speaking = false;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }
  function setPhaseAndStart(phase) {
    if (!s.active && !s.manualPush) return;
    if (s.running || s.starting) {
      if (s.phase !== phase) { s.nextPhase = phase; stopRecognition(true); }
      return;
    }
    clearTimeout(s.restartTimer);
    s.commandText = '';
    s.nextPhase = null;
    s.stopping = false;
    status('starting');
    try {
      s.starting = true;
      s.recognition.start();
    } catch (error) {
      s.starting = false;
      if (error.name === 'InvalidStateError') {
        s.restartTimer = setTimeout(() => setPhaseAndStart(phase), 350);
        return;
      }
      fail(error.name === 'NotAllowedError'
        ? 'Microphone permission was denied. Allow microphone access for this site in Chrome/Safari settings, then start Hands-Free again.'
        : 'The microphone could not start. Check that it is connected and that this site is using HTTPS.');
    }
  }
  function stopRecognition(transition = false) {
    clearTimeout(s.silenceTimer);
    if (transition) s.stopping = true;
    if (s.recognition && (s.running || s.starting)) {
      try { s.recognition.stop(); } catch (_) { s.running = false; s.starting = false; }
    }
  }
  function fail(message) {
    s.active = false; s.manualPush = false; s.nextPhase = null;
    clearTimeout(s.restartTimer); clearTimeout(s.silenceTimer);
    stopRecognition(); status('error'); notify(message);
  }
  function renderAck() {
    const bubble = document.createElement('div');
    bubble.className = 'bubble assistant wake-acknowledgement';
    const who = document.createElement('div'); who.className = 'who'; who.textContent = 'J.A.R.V.I.S.';
    const content = document.createElement('div'); content.textContent = 'Yes, sir?';
    bubble.append(who, content); el.log.appendChild(bubble); el.log.scrollTop = el.log.scrollHeight;
  }
  function afterAcknowledgement(commandTail) {
    el.reactor?.classList.remove('activated');
    if (commandTail) { s.commandText = commandTail; submitCommand(commandTail); }
    else setPhaseAndStart('command');
  }
  function activateWake(tail) {
    if (s.phase !== 'wake') return;
    s.pendingWake = true;
    s.nextPhase = 'activated';
    s.commandText = tail || '';
    stopRecognition(true);
  }
  function submitCommand(text) {
    const command = String(text || '').trim();
    if (!command) { setPhaseAndStart('command'); return; }
    if (stopPhrase(command)) {
      stopHandsFree(); notify('Hands-free listening is off.'); return;
    }
    const now = Date.now(), normalized = command.toLowerCase();
    if (normalized === s.lastSent && now - s.lastSentAt < 3000) return;
    s.lastSent = normalized; s.lastSentAt = now;
    s.commandText = '';
    s.pendingWake = false;
    status('thinking');
    el.input.value = command;
    el.form.requestSubmit();
  }
  function responseAdded(node) {
    if (!(node instanceof Element) || !node.matches('.bubble.assistant') || node.classList.contains('wake-acknowledgement')) return;
    if (node.querySelector('.typing')) return;
    const text = node.lastElementChild?.textContent?.trim();
    if (!text || node.dataset.voiceRepairHandled) return;
    node.dataset.voiceRepairHandled = 'true';
    clearTimeout(s.responseTimer);
    // The existing application still owns AI requests and message rendering. Its
    // browser TTS only runs for its private hands-free state, so this module speaks
    // the real response when that private mode is not active (i.e. our repaired mode).
    if (!node.classList.contains('error') && el.voice?.checked && !s.muted) {
      status('speaking');
      speak(text, () => resumeAfterResponse());
    } else resumeAfterResponse();
  }
  function resumeAfterResponse() {
    if (!s.active && !s.manualPush) return;
    if (s.manualPush) { s.manualPush = false; status('idle'); return; }
    status('resuming');
    setTimeout(() => {
      if (!s.active || document.hidden) return;
      setPhaseAndStart(el.continuous?.checked ? 'command' : 'wake');
    }, 350);
  }
  function startHandsFree() {
    if (!s.recognition) { notify('Hands-free speech recognition is not supported in this browser. Text chat and push-to-talk alternatives remain available where supported.'); return; }
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') { notify('Microphone access requires a secure HTTPS page.'); return; }
    s.active = true; s.manualPush = false; s.restarts = 0;
    el.handsfree.classList.add('active');
    if (window.speechSynthesis && !s.speechUnlocked) {
      try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u); s.speechUnlocked = true; } catch (_) {}
    }
    setPhaseAndStart('wake');
  }
  function stopHandsFree() {
    s.active = false; s.manualPush = false; s.pendingWake = false; s.nextPhase = null; s.commandText = '';
    clearTimeout(s.restartTimer); clearTimeout(s.silenceTimer); clearTimeout(s.responseTimer);
    el.reactor?.classList.remove('activated');
    stopRecognition(); status('idle');
  }
  function startPushToTalk() {
    if (!s.recognition) { notify('Speech recognition is unavailable. You can still type a message.'); return; }
    s.manualPush = true;
    s.active = false;
    setPhaseAndStart('command');
  }
  function processResults(event) {
    if (!s.active && !s.manualPush) return;
    let heard = '';
    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      if (result?.[0]?.transcript) heard += ` ${result[0].transcript}`;
    }
    heard = heard.trim();
    if (!heard) return;
    if (s.phase === 'wake') {
      const tail = wakeTail(heard);
      if (tail !== null) activateWake(tail);
      return;
    }
    if (s.phase !== 'command') return;
    s.commandText = heard;
    clearTimeout(s.silenceTimer);
    s.silenceTimer = setTimeout(() => {
      if (s.phase !== 'command' || !s.commandText.trim()) return;
      const text = s.commandText.trim();
      stopRecognition(true);
      s.nextPhase = 'submit';
      s.pendingText = text;
    }, Math.max(600, Number(el.silence?.value || 1200)));
  }
  function initializeRecognition() {
    if (!recCtor) {
      el.handsfree.disabled = true; el.mic.disabled = true;
      el.state.dataset.state = 'unsupported'; el.stateText.textContent = labels.unsupported;
      if (el.voiceStatus) el.voiceStatus.textContent = 'NOT SUPPORTED';
      return;
    }
    const recognition = new recCtor();
    s.recognition = recognition;
    recognition.lang = 'en-GB'; recognition.continuous = true; recognition.interimResults = true; recognition.maxAlternatives = 3;
    recognition.onstart = () => {
      s.starting = false; s.running = true; s.restarts = 0;
      if (s.phase === 'starting') s.phase = s.nextPhase || 'wake';
      status(s.phase === 'command' ? 'command' : s.phase === 'activated' ? 'activated' : 'wake');
    };
    recognition.onresult = processResults;
    recognition.onerror = event => {
      s.starting = false;
      if (event.error === 'aborted' || event.error === 'no-speech') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        fail('Microphone permission was denied. Allow microphone access in browser/site settings, then press Hands-Free again.'); return;
      }
      if (event.error === 'audio-capture') { fail('No microphone is available. Connect or enable a microphone, then try again.'); return; }
      if (event.error === 'network') notify('Speech recognition network error. Check your connection; hands-free will retry while the page remains active.');
    };
    recognition.onend = () => {
      s.running = false; s.starting = false;
      if (!s.active && !s.manualPush) { status('idle'); return; }
      if (s.pendingWake) {
        s.pendingWake = false;
        s.phase = 'activated'; status('activated'); sound(); el.reactor?.classList.add('activated');
        renderAck();
        speak('Yes, sir?', () => afterAcknowledgement(s.commandText));
        if (!window.speechSynthesis || !el.voice?.checked || s.muted) afterAcknowledgement(s.commandText);
        return;
      }
      if (s.nextPhase === 'submit') {
        const command = s.pendingText; s.pendingText = ''; s.nextPhase = null;
        if (command) submitCommand(command);
        return;
      }
      if (s.nextPhase) {
        const next = s.nextPhase; s.nextPhase = null;
        if (next === 'activated') { s.pendingWake = true; return; }
        if (next === 'stop') { status('idle'); return; }
        setPhaseAndStart(next); return;
      }
      if (s.manualPush) { s.manualPush = false; status('idle'); return; }
      if (s.active && !document.hidden) {
        status('resuming');
        const delay = Math.min(3000, 400 * (2 ** Math.min(s.restarts++, 3)));
        clearTimeout(s.restartTimer);
        s.restartTimer = setTimeout(() => setPhaseAndStart(s.phase === 'command' ? 'command' : 'wake'), delay);
      }
    };
  }

  // Intercept the existing controls before the original listener; no HUD redesign.
  document.addEventListener('click', event => {
    const target = event.target.closest('#handsfree-button,#stop-listening-button,#mic-button');
    if (!target) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (target === el.handsfree) s.active ? stopHandsFree() : startHandsFree();
    else if (target === el.stop) stopHandsFree();
    else if (s.speaking && el.interrupt?.checked) { stopSpeaking(); s.manualPush = true; s.active = false; setPhaseAndStart('command'); }
    else if (s.active || s.manualPush) stopHandsFree();
    else startPushToTalk();
  }, true);

  // Submit voice commands through the existing form handler/backend, unchanged.
  el.form.addEventListener('submit', event => {
    if (!s.active && !s.manualPush) return;
    s.commandText = '';
    clearTimeout(s.silenceTimer);
    stopRecognition();
    status('thinking');
    clearTimeout(s.responseTimer);
    s.responseTimer = setTimeout(() => {
      if ((s.active || s.manualPush) && s.phase === 'thinking') resumeAfterResponse();
    }, 50000);
  }, true);

  s.observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        responseAdded(node);
        node.querySelectorAll?.('.bubble.assistant').forEach(responseAdded);
      }
    }
  });
  s.observer.observe(el.log, { childList: true, subtree: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && s.active) {
      stopHandsFree(); notify('Hands-free paused because JARVIS is no longer visible. Return to the app and tap Hands-Free to resume. Background wake-word listening is not supported.');
    }
  });
  window.addEventListener('pagehide', stopHandsFree);
  initializeRecognition();
})();
