/**
 * JAL - Utility functions
 */

window.JAL = window.JAL || {};

window.JAL.Utils = {
  /**
   * Generate a unique ID
   */
  generateId() {
    return `jal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  },

  /**
   * Create a fingerprint hash from text
   * Uses a simple but fast hash for message identification
   */
  fingerprint(text) {
    if (!text) return '';
    // Take first 100 and last 100 chars + length for a stable fingerprint
    const normalized = text.trim().replace(/\s+/g, ' ');
    const prefix = normalized.slice(0, 100);
    const suffix = normalized.slice(-100);
    const sample = `${prefix}|${suffix}|${normalized.length}`;

    // Simple hash
    let hash = 0;
    for (let i = 0; i < sample.length; i++) {
      const char = sample.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  },

  /**
   * Extract page ID from URL (conversation identifier)
   */
  getPageId(url) {
    const u = new URL(url);
    // For ChatGPT: /c/[id] or /g/[id]/c/[id]
    // For Claude: /chat/[id]
    // For Gemini: various formats
    const pathParts = u.pathname.split('/').filter(Boolean);

    // Try to find conversation ID patterns
    const idPatterns = ['c', 'chat', 'conversation'];
    for (let i = 0; i < pathParts.length - 1; i++) {
      if (idPatterns.includes(pathParts[i])) {
        return `${u.hostname}:${pathParts[i + 1]}`;
      }
    }

    // Fallback to full path
    return `${u.hostname}:${u.pathname}`;
  },

  /**
   * Detect which AI provider we're on
   */
  detectProvider() {
    const hostname = window.location.hostname;

    if (hostname.includes('chatgpt.com') || hostname.includes('chat.openai.com')) {
      return 'chatgpt';
    }
    if (hostname.includes('claude.ai')) {
      return 'claude';
    }
    if (hostname.includes('gemini.google.com')) {
      return 'gemini';
    }
    if (hostname.includes('deepseek.com')) {
      return 'deepseek';
    }

    return 'unknown';
  },

  /**
   * Debounce function
   */
  debounce(fn, delay) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn.apply(this, args), delay);
    };
  },

  /**
   * Wait for an element to appear in the DOM
   */
  waitForElement(selector, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) {
        resolve(el);
        return;
      }

      const observer = new MutationObserver((mutations, obs) => {
        const el = document.querySelector(selector);
        if (el) {
          obs.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for ${selector}`));
      }, timeout);
    });
  },

  /**
   * Get text content from an element, preserving some structure
   * Removes duplicate text from KaTeX/MathJax equation rendering
   */
  getTextContent(element) {
    if (!element) return '';

    // Clone to avoid modifying original
    const clone = element.cloneNode(true);

    // Remove script and style tags
    clone.querySelectorAll('script, style').forEach(el => el.remove());

    // Remove KaTeX MathML (duplicate of visible content)
    // KaTeX renders both .katex-mathml (for accessibility) and .katex-html (visible)
    clone.querySelectorAll('.katex-mathml').forEach(el => el.remove());

    // Remove MathJax assistive MML (duplicate)
    clone.querySelectorAll('mjx-assistive-mml').forEach(el => el.remove());

    // Remove aria-hidden elements that are just for screen readers
    clone.querySelectorAll('[aria-hidden="true"]').forEach(el => {
      // But keep aria-hidden katex-html since that's the visible content
      if (!el.classList?.contains('katex-html')) {
        el.remove();
      }
    });

    // Get text with preserved whitespace for code blocks
    return clone.textContent || '';
  },

  /**
   * Find the message container element from a text node or element
   */
  findMessageContainer(node, provider) {
    if (!node) return null;

    const adapter = JAL.Providers?.[provider];
    if (adapter?.findMessageContainer) {
      return adapter.findMessageContainer(node);
    }

    // Fallback: walk up until we find a large enough container
    let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (current && current !== document.body) {
      const text = JAL.Utils.getTextContent(current);
      if (text.length > 50) {
        // Check if this looks like a message container
        const rect = current.getBoundingClientRect();
        if (rect.width > 200 && rect.height > 50) {
          return current;
        }
      }
      current = current.parentElement;
    }

    return null;
  },

  /**
   * Highlight an element temporarily
   */
  flashHighlight(element, duration = 2000) {
    if (!element) return;

    const originalBg = element.style.backgroundColor;
    const originalTransition = element.style.transition;

    element.style.transition = 'background-color 0.3s ease';
    element.style.backgroundColor = 'rgba(255, 220, 100, 0.3)';

    setTimeout(() => {
      element.style.backgroundColor = originalBg;
      setTimeout(() => {
        element.style.transition = originalTransition;
      }, 300);
    }, duration);
  },

  /**
   * Scroll element into view with offset
   */
  scrollToElement(element, offset = 100) {
    if (!element) return;

    const rect = element.getBoundingClientRect();
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const targetY = rect.top + scrollTop - offset;

    window.scrollTo({
      top: targetY,
      behavior: 'smooth'
    });
  }
};

console.log('JAL Utils loaded');
