/**
 * tts.js —— 英文发音帮助（基于浏览器 Web Speech API）
 *
 * 使用浏览器内置的 speechSynthesis，无需联网、无需密钥，
 * 在 content script 和扩展页面（review.html）中均可使用。
 */
(function (global) {
  'use strict';

  // 预加载一次语音列表，保证首次调用能选到英文语音。
  function warmUp() {
    try {
      if ('speechSynthesis' in global && global.speechSynthesis.getVoices) {
        global.speechSynthesis.getVoices();
      }
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 朗读英文文本。
   * @param {string} text 要朗读的文本
   * @param {object} opts { rate } 可选语速
   */
  function speak(text, opts) {
    if (!text) return;
    try {
      if (!('speechSynthesis' in global)) return;
      global.speechSynthesis.cancel(); // 先停止上一次朗读，避免叠加
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'en-US';
      utter.rate = (opts && opts.rate) || 0.9;

      // 优先选择一个英文语音，保证发音为英文而非中文语音。
      const voices = global.speechSynthesis.getVoices();
      const enVoice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
      if (enVoice) utter.voice = enVoice;

      global.speechSynthesis.speak(utter);
    } catch (e) { /* 忽略异常，避免影响主流程 */ }
  }

  // 生成一个带喇叭图标的发音按钮，点击后朗读指定文本。
  function speakerButton(text, opts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lv-speaker';
    btn.title = '发音';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">' +
      '<path d="M3 9v6h4l5 5V4L7 9H3z"></path>' +
      '<path d="M16 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>' +
      '<path d="M18.5 6a9 9 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>' +
      '</svg>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      speak(text, opts);
    });
    return btn;
  }

  warmUp();
  if ('speechSynthesis' in global && global.speechSynthesis.onvoiceschanged !== undefined) {
    global.speechSynthesis.onvoiceschanged = warmUp;
  }

  global.LV_TTS = { speak, speakerButton };
})(typeof window !== 'undefined' ? window : self);
