/* JARVIS speech providers. Browser speech is the safe default; Azure remains
   unavailable until a Worker token broker and explicit non-secret config exist. */
(() => {
  'use strict';
  const config = window.JARVIS_SPEECH_CONFIG || {};
  const cache = { token: '', expiresAt: 0, pending: null };
  const voices = { list: [], ready: false, listeners: new Set() };
  const voiceSelect = () => document.getElementById('voice-select');
  const rank = voice => {
    const name = voice.name.toLowerCase();
    return (/natural|neural|enhanced|premium|online/i.test(name) ? 80 : 0) +
      (/daniel|ryan|arthur|oliver|george|male/i.test(name) ? 30 : 0) -
      (/female|woman|serena|kate|samantha|victoria|moira|hazel/i.test(name) ? 20 : 0);
  };
  function refreshVoices() {
    if (!window.speechSynthesis) return;
    voices.list = window.speechSynthesis.getVoices();
    if (!voices.list.length) return;
    voices.ready = true;
    const select = voiceSelect();
    if (select) {
      const previous = select.value;
      const auto = document.createElement('option');
      auto.value = 'auto'; auto.textContent = 'Automatic — best available en-GB voice';
      select.replaceChildren(auto);
      [...voices.list].sort((a,b) => rank(b)-rank(a) || a.name.localeCompare(b.name)).forEach(voice => {
        const option = document.createElement('option');
        option.value = voice.voiceURI;
        option.textContent = `${voice.name} (${voice.lang})`;
        select.appendChild(option);
      });
      const preferred = previous !== 'auto' ? previous : (select.dataset.savedVoice || 'auto');
      select.value = [...select.options].some(option => option.value === preferred) ? preferred : 'auto';
    }
    voices.listeners.forEach(listener => listener());
  }
  function chooseBrowserVoice() {
    const requested = voiceSelect()?.value;
    if (requested && requested !== 'auto') {
      const chosen = voices.list.find(voice => voice.voiceURI === requested);
      if (chosen) return chosen;
    }
    const british = voices.list.filter(voice => /^en[-_]gb/i.test(voice.lang));
    return british.sort((a,b) => rank(b)-rank(a))[0] ||
      voices.list.filter(voice => /^en/i.test(voice.lang)).sort((a,b) => rank(b)-rank(a))[0] || null;
  }
  function chunks(text) {
    const sentences = String(text).replace(/\s+/g,' ').trim().match(/[^.!?]+[.!?]+(?:[”’"')\]]+)?|[^.!?]+$/g) || [];
    const result = []; let pending = '';
    for (const sentence of sentences) {
      const next = `${pending} ${sentence}`.trim();
      if (next.length <= 240) pending = next;
      else { if (pending) result.push(pending); pending = sentence.trim(); }
    }
    if (pending) result.push(pending);
    return result;
  }
  class BrowserSpeechProvider {
    constructor() { this.id = 'browser'; this.label = 'Browser speech'; this.run = 0; this.active = false; }
    get available() { return Boolean(window.speechSynthesis && window.SpeechSynthesisUtterance); }
    getVoice() { return chooseBrowserVoice(); }
    getDescription() {
      const voice = this.getVoice();
      return voice ? `${voice.name} (${voice.lang})` : 'Browser default (no English voice reported)';
    }
    stop() { this.run++; this.active = false; window.speechSynthesis?.cancel(); }
    speak(text, { onState = () => {} } = {}) {
      if (!this.available) return Promise.reject(new Error('Browser speech synthesis is unavailable.'));
      this.stop(); const run = this.run; const queue = chunks(text); let i = 0;
      return new Promise((resolve, reject) => {
        const next = () => {
          if (run !== this.run) { resolve({ cancelled: true }); return; }
          if (i >= queue.length) { this.active = false; onState('idle'); resolve({ cancelled: false }); return; }
          const utterance = new SpeechSynthesisUtterance(queue[i++]);
          const voice = this.getVoice();
          if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
          else utterance.lang = 'en-GB';
          utterance.rate = Number(document.getElementById('speech-speed')?.value || .90);
          utterance.pitch = Number(document.getElementById('speech-pitch')?.value || .90);
          utterance.volume = Number(document.getElementById('speech-volume')?.value ?? 1);
          utterance.onend = () => setTimeout(next, 120);
          utterance.onerror = event => {
            if (run !== this.run || event.error === 'canceled' || event.error === 'interrupted') { resolve({ cancelled: true }); return; }
            this.active = false; onState('error'); reject(new Error(`Browser speech failed: ${event.error || 'unknown error'}`));
          };
          this.active = true; onState('speaking');
          try { window.speechSynthesis.resume(); window.speechSynthesis.speak(utterance); }
          catch (error) { this.active = false; onState('error'); reject(error); }
        };
        next();
      });
    }
  }
  async function getAzureToken(force = false) {
    if (!config.tokenBrokerUrl) throw new Error('Azure speech is not configured: no token-broker URL is configured.');
    if (!config.region) throw new Error('Azure speech is not configured: no Speech resource region is configured.');
    if (!force && cache.token && Date.now() < cache.expiresAt - 60000) return cache.token;
    if (cache.pending) return cache.pending;
    cache.pending = (async () => {
      const response = await fetch(config.tokenBrokerUrl, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (response.status === 401 || response.status === 403) throw new Error('Azure token broker rejected authorization.');
      if (!response.ok) throw new Error(`Azure token broker failed (${response.status}).`);
      const data = await response.json();
      if (!data || typeof data.token !== 'string' || !data.token || !data.expiresAt) throw new Error('Azure token broker returned an invalid token response.');
      const expiry = typeof data.expiresAt === 'number' ? (data.expiresAt < 1e12 ? data.expiresAt * 1000 : data.expiresAt) : Date.parse(data.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('Azure token broker returned an expired token.');
      cache.token = data.token; cache.expiresAt = expiry; return cache.token;
    })().finally(() => { cache.pending = null; });
    return cache.pending;
  }
  class AzureSpeechProvider {
    constructor() { this.id = 'azure'; this.label = 'Azure AI Speech'; this.active = false; this.synth = null; }
    get available() { return Boolean(window.SpeechSDK && config.tokenBrokerUrl && config.region); }
    getDescription() { return `Azure AI Speech · ${config.voice || 'en-GB-RyanNeural'}`; }
    stop() { try { this.synth?.close(); } catch (_) {} this.synth = null; this.active = false; }
    async speak(text, { onState = () => {} } = {}) {
      if (!this.available) throw new Error('Azure Speech is not configured or its Microsoft Speech SDK is not loaded.');
      this.stop(); onState('speaking');
      const sdk = window.SpeechSDK;
      let token;
      try { token = await getAzureToken(); }
      catch (error) { onState('error'); throw error; }
      const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(token, config.region);
      speechConfig.speechSynthesisVoiceName = config.voice || 'en-GB-RyanNeural';
      speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat?.Audio24Khz48KBitRateMonoMp3;
      const audioConfig = sdk.AudioConfig.fromDefaultSpeakerOutput();
      this.synth = new sdk.SpeechSynthesizer(speechConfig, audioConfig); this.active = true;
      const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
      const sentences = chunks(text);
      try {
        for (const sentence of sentences) {
          if (!this.active) return { cancelled: true };
          const ssml = `<speak version="1.0" xml:lang="en-GB"><voice name="${escape(config.voice || 'en-GB-RyanNeural')}">${escape(sentence)}</voice></speak>`;
          await new Promise((resolve, reject) => this.synth.speakSsmlAsync(ssml, result => {
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) resolve();
            else reject(new Error(result.errorDetails || 'Azure speech synthesis failed.'));
          }, error => reject(new Error(String(error))));
        }
        this.active = false; this.synth?.close(); this.synth = null; onState('idle'); return { cancelled: false };
      } catch (error) { this.stop(); onState('error'); throw error; }
    }
  }
  const providers = { browser: new BrowserSpeechProvider(), azure: new AzureSpeechProvider() };
  let selectedProvider = 'browser';
  const api = {
    providers,
    getProvider(id = selectedProvider) { return providers[id] || providers.browser; },
    get activeProvider() { return selectedProvider; },
    setProvider(id) { if (!providers[id] || (id === 'azure' && !providers.azure.available)) throw new Error('Requested voice provider is not configured.'); selectedProvider = id; },
    async speak(text, options = {}) {
      const preferred = providers[selectedProvider];
      try { return await preferred.speak(text, options); }
      catch (error) {
        if (preferred.id === 'azure' && providers.browser.available && options.allowFallback !== false) {
          options.onFallback?.(error);
          selectedProvider = 'browser';
          return providers.browser.speak(text, options);
        }
        throw error;
      }
    },
    stop() { Object.values(providers).forEach(provider => provider.stop()); },
    refreshVoices,
    chooseBrowserVoice,
    onVoicesChanged(callback) { voices.listeners.add(callback); return () => voices.listeners.delete(callback); },
    get diagnostics() { return { provider: selectedProvider, availableVoices: voices.list.map(v => ({name:v.name,lang:v.lang})), voicesLoaded: voices.ready, selectedVoice: chooseBrowserVoice()?.name || 'Browser default', selectedLanguage: chooseBrowserVoice()?.lang || 'unknown', british: /^en[-_]gb/i.test(chooseBrowserVoice()?.lang || ''), speechAvailable: Boolean(window.speechSynthesis), speechActive: Object.values(providers).some(p => p.active), azureConfigured: providers.azure.available, lastError: '' }; }
  };
  window.JarvisVoice = api;
  if (window.speechSynthesis) {
    window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
    window.addEventListener('pageshow', refreshVoices);
    refreshVoices(); setTimeout(refreshVoices, 500); setTimeout(refreshVoices, 1800);
  }
})();
