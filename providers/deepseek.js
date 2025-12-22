/**
 * JAL - DeepSeek Provider Adapter
 * Works with deepseek.com chat interface
 */

window.JAL = window.JAL || {};
window.JAL.Providers = window.JAL.Providers || {};

window.JAL.Providers.deepseek = {
  name: 'deepseek',

  selectors: {
    messageContainer: [
      '[class*="assistant"]',
      '[class*="message"]',
      '[class*="response"]'
    ],
    composer: [
      'textarea',
      '[contenteditable="true"]'
    ]
  },

  isActive() {
    return window.location.hostname.includes('deepseek.com');
  },

  _findElement(selectorList) {
    for (const selector of selectorList) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  },

  getAssistantMessages() {
    // DeepSeek likely uses class-based identification
    const messages = document.querySelectorAll('[class*="assistant"], [class*="bot"]');
    if (messages.length > 0) return [...messages];

    // Fallback to heuristics
    const allDivs = document.querySelectorAll('div');
    return [...allDivs].filter(el => {
      const text = el.textContent || '';
      return text.length > 100 && el.querySelector('p, pre, code');
    });
  },

  findMessageContainer(node) {
    let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;

    while (current && current !== document.body) {
      const className = current.className || '';
      if (className.includes('assistant') || className.includes('message')) {
        return current;
      }
      if (current.hasAttribute('data-jal-message')) {
        return current;
      }
      current = current.parentElement;
    }

    return null;
  },

  isAssistantMessage(element) {
    const className = element.className || '';
    return className.includes('assistant') || className.includes('bot');
  },

  getMessageText(element) {
    return window.JAL.Utils.getTextContent(element);
  },

  getComposerElement() {
    return this._findElement(this.selectors.composer);
  },

  insertIntoComposer(text) {
    const composer = this.getComposerElement();
    if (!composer) return false;

    composer.focus();

    if (composer.tagName === 'TEXTAREA') {
      composer.value = text;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    if (composer.isContentEditable) {
      composer.textContent = text;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    return false;
  },

  getMessagesContainer() {
    return document.querySelector('main') || document.body;
  },

  getScrollPosition() {
    return window.scrollY;
  },

  scrollToPosition(position) {
    window.scrollTo({ top: position, behavior: 'smooth' });
  }
};

console.log('JAL DeepSeek Provider loaded');
