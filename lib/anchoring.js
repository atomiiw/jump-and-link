/**
 * JAL - Text anchoring system
 * Uses quote + prefix + suffix approach (like Hypothes.is)
 */

window.JAL = window.JAL || {};

window.JAL.Anchoring = {
  // Sentence-ending punctuation pattern (English and Chinese) + newlines
  // English: . ! ?
  // Chinese: 。(period) ！(exclamation) ？(question) ；(semicolon, sometimes ends sentences)
  // Also: \n (newline) - treats line breaks as sentence boundaries
  SENTENCE_END: /[.!?。！？；\n]/,

  /**
   * Create an anchor from a selection within a message
   */
  createAnchor(selection, messageElement, messageText) {
    if (!selection || selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const quoteExact = selection.toString().trim();

    if (!quoteExact) {
      return null;
    }

    // Find the position in the message text
    const startHint = this.findPositionInText(messageText, quoteExact, range);

    // Extract the complete sentence(s) containing the quote as context
    const contextSentences = this.extractSentenceContext(messageText, quoteExact, startHint);

    return {
      messageFingerprint: window.JAL.Utils.fingerprint(messageText),
      quoteExact,
      contextSentences,
      prefix: '', // kept for backward compatibility
      suffix: '',
      startHint
    };
  },

  /**
   * Find approximate position of selection in message text
   */
  findPositionInText(messageText, quote, range) {
    // Try to find exact match first
    const idx = messageText.indexOf(quote);
    if (idx !== -1) {
      return idx;
    }

    // Fallback: use range offset hints
    // This is approximate since DOM structure may differ from plain text
    const startContainer = range.startContainer;
    if (startContainer.nodeType === Node.TEXT_NODE) {
      const textBefore = this.getTextBeforeNode(startContainer, range.startOffset);
      return textBefore.length;
    }

    return 0;
  },

  /**
   * Get all text before a specific text node and offset
   */
  getTextBeforeNode(textNode, offset) {
    let text = '';
    const walker = document.createTreeWalker(
      textNode.parentElement?.closest('[data-jal-message]') || document.body,
      NodeFilter.SHOW_TEXT
    );

    let current;
    while ((current = walker.nextNode())) {
      if (current === textNode) {
        text += current.textContent.slice(0, offset);
        break;
      }
      text += current.textContent;
    }

    return text;
  },

  /**
   * Normalize text for comparison (remove special chars, collapse whitespace)
   */
  normalizeForSearch(text) {
    return text
      .replace(/\s+/g, ' ')  // collapse whitespace
      .replace(/[^\w\s]/g, '') // remove special chars
      .toLowerCase()
      .trim();
  },

  /**
   * Find position using normalized comparison
   */
  findNormalizedPosition(messageText, quote, startHint) {
    // First try exact match
    let pos = messageText.indexOf(quote, Math.max(0, startHint - 10));
    if (pos !== -1) return pos;

    pos = messageText.indexOf(quote);
    if (pos !== -1) return pos;

    // Try fuzzy match
    pos = this.fuzzyFind(messageText, quote, startHint);
    if (pos !== -1) return pos;

    // Try normalized search - find where normalized quote appears in normalized message
    const normQuote = this.normalizeForSearch(quote);
    const normMessage = this.normalizeForSearch(messageText);

    if (normQuote.length < 5) {
      // Too short for reliable normalized matching, use startHint
      return startHint;
    }

    const normPos = normMessage.indexOf(normQuote);
    if (normPos !== -1) {
      // Map back to original position approximately
      // Count how many chars in original correspond to normPos chars in normalized
      let origPos = 0;
      let normCount = 0;
      for (let i = 0; i < messageText.length && normCount < normPos; i++) {
        const char = messageText[i];
        const normChar = char.replace(/[^\w\s]/g, '').toLowerCase();
        if (normChar || /\s/.test(char)) {
          normCount++;
        }
        origPos = i;
      }
      return origPos;
    }

    // Last resort: use startHint
    return startHint;
  },

  /**
   * Check if a character is Chinese punctuation (no space required after)
   */
  isChinese(char) {
    return /[。！？；]/.test(char);
  },

  /**
   * Extract complete sentence(s) containing the quote as context
   * Uses startHint position directly - no need to match the quote text
   */
  extractSentenceContext(messageText, quote, startHint) {
    if (!messageText || startHint < 0 || startHint >= messageText.length) {
      return '';
    }

    // Use startHint as our position - this is where the selection starts
    const pos = Math.min(startHint, messageText.length - 1);

    // Find sentence start: look backwards for sentence-ending punctuation or newline
    // For English: requires whitespace after (". ")
    // For Chinese: no whitespace needed ("。")
    // For newlines: no whitespace needed
    let sentenceStart = 0;
    for (let i = pos - 1; i >= 0; i--) {
      const char = messageText[i];
      if (this.SENTENCE_END.test(char)) {
        // Newlines are always sentence boundaries
        if (char === '\n') {
          sentenceStart = i + 1;
          break;
        }
        // Chinese punctuation doesn't need whitespace after
        if (this.isChinese(char)) {
          sentenceStart = i + 1;
          break;
        }
        // English punctuation needs whitespace after
        const nextChar = messageText[i + 1];
        if (nextChar && /\s/.test(nextChar)) {
          sentenceStart = i + 1;
          break;
        }
      }
    }

    // Find sentence end: look forwards from the end of quote for sentence-ending punctuation or newline
    const quoteEndPos = Math.min(pos + quote.length, messageText.length);
    let sentenceEnd = messageText.length;
    for (let i = quoteEndPos; i < messageText.length; i++) {
      const char = messageText[i];
      if (this.SENTENCE_END.test(char)) {
        // For newlines, stop before it (don't include the newline in context)
        if (char === '\n') {
          sentenceEnd = i;
          break;
        }
        // For punctuation, include it
        sentenceEnd = i + 1;
        break;
      }
    }

    // Extract the sentence(s) and trim whitespace
    const context = messageText.slice(sentenceStart, sentenceEnd).trim();

    return context;
  },

  /**
   * Extract prefix and suffix context around the quote (legacy, kept for re-anchoring)
   */
  extractContext(messageText, quote, startHint) {
    // Find the best match position
    let pos = messageText.indexOf(quote, Math.max(0, startHint - 10));
    if (pos === -1) {
      pos = messageText.indexOf(quote);
    }
    if (pos === -1) {
      // Try fuzzy match
      pos = this.fuzzyFind(messageText, quote, startHint);
    }

    if (pos === -1) {
      return { prefix: '', suffix: '' };
    }

    const prefix = messageText.slice(
      Math.max(0, pos - 150),
      pos
    ).trim();

    const suffix = messageText.slice(
      pos + quote.length,
      pos + quote.length + 150
    ).trim();

    return { prefix, suffix };
  },

  /**
   * Re-anchor: find the quote in message text, handling slight variations
   */
  reanchor(anchor, messageText) {
    const { quoteExact, prefix, suffix, startHint } = anchor;

    // 1. Try exact match
    const exactMatches = this.findAllMatches(messageText, quoteExact);

    if (exactMatches.length === 1) {
      return {
        success: true,
        position: exactMatches[0],
        confidence: 1.0
      };
    }

    if (exactMatches.length > 1) {
      // Disambiguate using context
      const best = this.disambiguateByContext(messageText, exactMatches, prefix, suffix, quoteExact.length);
      return {
        success: true,
        position: best.position,
        confidence: best.score
      };
    }

    // 2. Try fuzzy match near startHint
    const fuzzyMatch = this.fuzzyFind(messageText, quoteExact, startHint);
    if (fuzzyMatch !== -1) {
      return {
        success: true,
        position: fuzzyMatch,
        confidence: 0.7
      };
    }

    // 3. Try context-based recovery
    const contextMatch = this.findByContext(messageText, prefix, suffix);
    if (contextMatch !== -1) {
      return {
        success: true,
        position: contextMatch,
        confidence: 0.5
      };
    }

    // 4. Try normalized text matching (for equations with unicode)
    const normalizedPos = this.findNormalizedPosition(messageText, quoteExact, startHint);
    if (normalizedPos !== startHint && normalizedPos >= 0) {
      return {
        success: true,
        position: normalizedPos,
        confidence: 0.4
      };
    }

    // 5. Final fallback: use startHint position (for equations, special chars)
    return { success: true, position: startHint, confidence: 0.2 };
  },

  /**
   * Find all positions of a substring
   */
  findAllMatches(text, substr) {
    const positions = [];
    let pos = 0;
    while ((pos = text.indexOf(substr, pos)) !== -1) {
      positions.push(pos);
      pos += 1;
    }
    return positions;
  },

  /**
   * Disambiguate multiple matches using prefix/suffix context
   */
  disambiguateByContext(text, positions, prefix, suffix, quoteLen) {
    let best = { position: positions[0], score: 0 };

    for (const pos of positions) {
      let score = 0;

      // Check prefix match
      if (prefix) {
        const actualPrefix = text.slice(Math.max(0, pos - prefix.length), pos);
        score += this.similarity(actualPrefix, prefix);
      }

      // Check suffix match
      if (suffix) {
        const actualSuffix = text.slice(pos + quoteLen, pos + quoteLen + suffix.length);
        score += this.similarity(actualSuffix, suffix);
      }

      if (score > best.score) {
        best = { position: pos, score };
      }
    }

    return best;
  },

  /**
   * Simple similarity score (0-1)
   */
  similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;

    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;

    if (longer.length === 0) return 1;

    // Levenshtein-based similarity
    const distance = this.levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
  },

  /**
   * Levenshtein distance
   */
  levenshteinDistance(a, b) {
    const matrix = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[b.length][a.length];
  },

  /**
   * Fuzzy find: look for approximate matches near a hint position
   */
  fuzzyFind(text, query, hint, windowSize = 200) {
    const start = Math.max(0, hint - windowSize);
    const end = Math.min(text.length, hint + query.length + windowSize);
    const searchArea = text.slice(start, end);

    // Try progressively shorter prefixes
    for (let len = query.length; len >= Math.min(20, query.length); len--) {
      const prefix = query.slice(0, len);
      const idx = searchArea.indexOf(prefix);
      if (idx !== -1) {
        return start + idx;
      }
    }

    return -1;
  },

  /**
   * Find position using just context (when quote is completely changed)
   */
  findByContext(text, prefix, suffix) {
    if (!prefix && !suffix) return -1;

    if (prefix) {
      const prefixPos = text.indexOf(prefix);
      if (prefixPos !== -1) {
        return prefixPos + prefix.length;
      }
    }

    if (suffix) {
      const suffixPos = text.indexOf(suffix);
      if (suffixPos !== -1) {
        return suffixPos;
      }
    }

    return -1;
  },

  /**
   * Create a DOM range for highlighting an anchor
   */
  createRangeForAnchor(anchor, messageElement) {
    const messageText = window.JAL.Utils.getTextContent(messageElement);
    const result = this.reanchor(anchor, messageText);

    if (!result.success) return null;

    const walker = document.createTreeWalker(messageElement, NodeFilter.SHOW_TEXT);

    let charCount = 0;
    let startNode = null, startOffset = 0, endNode = null, endOffset = 0;
    let lastNode = null, lastNodeEnd = 0;
    const targetStart = result.position;

    // For low-confidence matches, adjust length
    let highlightLength = anchor.quoteExact.length;
    if (result.confidence < 0.5) {
      highlightLength = Math.min(Math.max(highlightLength, 10), 100);
    }
    const targetEnd = Math.min(result.position + highlightLength, messageText.length);

    // Key debug: shows anchor info and confidence
    console.log('JAL Anchor:', { quote: anchor.quoteExact.slice(0, 25), pos: targetStart, conf: result.confidence });

    let node;
    while ((node = walker.nextNode())) {
      const nodeLen = node.textContent.length;
      lastNode = node;
      lastNodeEnd = charCount + nodeLen;

      if (!startNode && charCount + nodeLen > targetStart) {
        startNode = node;
        startOffset = Math.min(targetStart - charCount, nodeLen);
      }

      if (charCount + nodeLen >= targetEnd) {
        endNode = node;
        endOffset = Math.min(targetEnd - charCount, nodeLen);
        break;
      }
      charCount += nodeLen;
    }

    if (startNode && !endNode && lastNode) {
      endNode = lastNode;
      endOffset = Math.min(targetEnd - (lastNodeEnd - lastNode.textContent.length), lastNode.textContent.length);
      if (endOffset < 0) endOffset = lastNode.textContent.length;
    }

    if (!startNode || !endNode) return null;

    startOffset = Math.max(0, Math.min(startOffset, startNode.textContent.length));
    endOffset = Math.max(0, Math.min(endOffset, endNode.textContent.length));

    if (startNode === endNode && startOffset >= endOffset) {
      endOffset = Math.min(startOffset + 20, startNode.textContent.length);
    }

    try {
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      return range;
    } catch (e) {
      console.warn('JAL: Failed to create range', e);
      return null;
    }
  }
};

console.log('JAL Anchoring loaded');
