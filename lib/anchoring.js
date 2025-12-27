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
   * Check if a node is inside an equation element
   */
  getEquationAncestor(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && el !== document.body) {
      if (el.classList?.contains('katex') ||
          el.classList?.contains('math') ||
          el.classList?.contains('MathJax') ||
          el.tagName === 'MATH' ||
          el.closest('.katex, .math, mjx-container, math')) {
        return el.closest('.katex, .math, mjx-container, math') || el;
      }
      el = el.parentElement;
    }
    return null;
  },

  /**
   * Clean duplicated equation text from selection
   * KaTeX/MathJax renders equations multiple times (display + accessibility)
   * This finds the clean version in messageText
   */
  cleanEquationDuplicates(text, messageText) {
    if (!text || !messageText) return text;

    // Normalize whitespace for comparison
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    const normalizedMessage = messageText.replace(/\s+/g, ' ');

    // If the text exists exactly in messageText, it's already clean
    if (normalizedMessage.includes(normalizedText)) {
      return normalizedText;
    }

    // Check if text ends with content that should be preserved (words or equation chars)
    // If so, we need to preserve them when cleaning equation duplicates
    const endsWithWords = /[a-zA-Z\u4e00-\u9fff]{2,}\s*$/.test(normalizedText);
    const endsWithEquation = /[=+\-*/^_αβγδεζηθικλμνξπρστυφχψω\d]+\s*$/i.test(normalizedText);
    const hasTrailingContent = endsWithWords || endsWithEquation;

    // Try to find the longest substring from the START that exists in messageText
    // This handles cases where duplicates are appended at the end
    for (let endPos = normalizedText.length; endPos >= 5; endPos--) {
      const sub = normalizedText.slice(0, endPos);
      if (normalizedMessage.includes(sub)) {
        // If there's remaining text that should be preserved, try to include it
        if (hasTrailingContent && endPos < normalizedText.length) {
          const remaining = normalizedText.slice(endPos).trim();
          if (remaining.length >= 2) {
            // Try to find where sub appears and what follows in messageText
            const subPos = normalizedMessage.indexOf(sub);
            if (subPos !== -1) {
              const afterSub = normalizedMessage.slice(subPos + sub.length);

              // Strategy 1: Try to find the last few characters of remaining
              for (let remLen = remaining.length; remLen >= 2; remLen--) {
                const remEnd = remaining.slice(-remLen);
                const remPos = afterSub.indexOf(remEnd);
                if (remPos !== -1 && remPos < 100) {
                  return normalizedMessage.slice(subPos, subPos + sub.length + remPos + remLen);
                }
              }

              // Strategy 2: Find distinctive words in the middle and use as anchor
              const words = remaining.split(/\s+/).filter(w => w.length >= 2 && /[a-zA-Z\u4e00-\u9fff]/.test(w));
              if (words.length > 0) {
                // Try to find the last distinctive word
                for (let wi = words.length - 1; wi >= 0; wi--) {
                  const word = words[wi];
                  const wordPos = afterSub.indexOf(word);
                  if (wordPos !== -1 && wordPos < 150) {
                    // Found a word anchor - now extend to include any trailing equation
                    let endPoint = wordPos + word.length;
                    // Look for more content after this word (could be equation)
                    const afterWord = afterSub.slice(endPoint, endPoint + 50);
                    // Include non-whitespace content that follows
                    const trailingMatch = afterWord.match(/^(\s*\S+)/);
                    if (trailingMatch) {
                      endPoint += trailingMatch[0].length;
                    }
                    return normalizedMessage.slice(subPos, subPos + sub.length + endPoint);
                  }
                }
              }

              // Strategy 3: For equation endings, estimate based on original length
              if (endsWithEquation && remaining.length > 5) {
                const estimatedEnd = Math.min(remaining.length + 20, afterSub.length, 150);
                if (estimatedEnd > 0) {
                  // Find a reasonable break point (space or punctuation)
                  let breakPoint = estimatedEnd;
                  for (let i = estimatedEnd; i > remaining.length / 2; i--) {
                    if (/[\s,.]/.test(afterSub[i])) {
                      breakPoint = i;
                      break;
                    }
                  }
                  return normalizedMessage.slice(subPos, subPos + sub.length + breakPoint);
                }
              }
            }
          }
        }
        return sub;
      }
    }

    // Try to find the longest substring from the END that exists in messageText
    // This handles cases where duplicates are prepended at the start
    for (let startPos = 0; startPos < normalizedText.length - 5; startPos++) {
      const sub = normalizedText.slice(startPos);
      if (normalizedMessage.includes(sub)) {
        return sub;
      }
    }

    // Try to find any longest matching substring
    const len = normalizedText.length;
    for (let subLen = len - 1; subLen >= Math.min(10, len / 2); subLen--) {
      for (let startPos = 0; startPos <= len - subLen; startPos++) {
        const sub = normalizedText.slice(startPos, startPos + subLen);
        if (normalizedMessage.includes(sub)) {
          return sub;
        }
      }
    }

    return normalizedText;
  },

  /**
   * Expand selection to include full words and full equations
   * Uses DOM structure to detect equation boundaries
   * Returns the expanded text
   */
  expandSelection(selection, messageText) {
    if (!selection || selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);

    // Check if selection starts or ends inside an equation element
    const startEquation = this.getEquationAncestor(range.startContainer);
    const endEquation = this.getEquationAncestor(range.endContainer);

    // If either end is in an equation, expand the range to include full equation(s)
    if (startEquation || endEquation) {
      const expandedRange = range.cloneRange();

      if (startEquation) {
        expandedRange.setStartBefore(startEquation);
      }
      if (endEquation) {
        expandedRange.setEndAfter(endEquation);
      }

      // Get text from expanded range and clean it
      let selectedText = expandedRange.toString().trim();
      selectedText = this.cleanEquationDuplicates(selectedText, messageText);
      selectedText = this.expandToFullWords(selectedText, messageText);
      return selectedText.trim();
    }

    // No equations involved - just clean and expand words
    let selectedText = selection.toString().trim();
    selectedText = this.cleanEquationDuplicates(selectedText, messageText);
    selectedText = this.expandToFullWords(selectedText, messageText);

    return selectedText.trim();
  },

  /**
   * Check if a character is CJK (Chinese/Japanese/Korean)
   * CJK languages don't use spaces between words
   */
  isCJK(char) {
    if (!char) return false;
    const code = char.charCodeAt(0);
    // CJK Unified Ideographs and common ranges
    return (code >= 0x4E00 && code <= 0x9FFF) ||  // CJK Unified Ideographs
           (code >= 0x3400 && code <= 0x4DBF) ||  // CJK Extension A
           (code >= 0x3000 && code <= 0x303F) ||  // CJK Punctuation
           (code >= 0x3040 && code <= 0x309F) ||  // Hiragana
           (code >= 0x30A0 && code <= 0x30FF) ||  // Katakana
           (code >= 0xAC00 && code <= 0xD7AF);    // Korean Hangul
  },

  /**
   * Expand text to include full words at boundaries
   * If selection starts/ends mid-word, expand to include the full word
   * Does NOT expand for CJK characters (no spaces between words)
   */
  expandToFullWords(text, messageText) {
    if (!text || !messageText) return text;

    const trimmed = text.trim();
    if (!trimmed) return text;

    // Find where this text appears in the message
    let pos = messageText.indexOf(trimmed);

    // If not found exactly, try to find partial matches
    if (pos === -1) {
      // Try normalizing both and searching
      const normalizedText = trimmed.replace(/\s+/g, ' ');
      const normalizedMessage = messageText.replace(/\s+/g, ' ');
      pos = normalizedMessage.indexOf(normalizedText);

      // Still not found? Try finding by start and end fragments
      if (pos === -1) {
        pos = this.findByFragments(trimmed, messageText);
      }

      if (pos === -1) {
        return trimmed; // Can't find it, return as-is
      }
    }

    let start = pos;
    let end = pos + trimmed.length;

    // Clamp end to messageText length
    if (end > messageText.length) {
      end = messageText.length;
    }

    // Get the first and last characters of selection
    const firstChar = messageText[start];
    const lastChar = messageText[end - 1];

    // Expand start to beginning of word (only for non-CJK characters)
    if (!this.isCJK(firstChar)) {
      while (start > 0) {
        const prevChar = messageText[start - 1];
        // Stop at whitespace
        if (/\s/.test(prevChar)) break;
        // Stop at CJK character
        if (this.isCJK(prevChar)) break;
        start--;
      }
    }

    // Expand end to end of word (only for non-CJK characters)
    if (!this.isCJK(lastChar)) {
      while (end < messageText.length) {
        const nextChar = messageText[end];
        // Stop at whitespace
        if (/\s/.test(nextChar)) break;
        // Stop at CJK character
        if (this.isCJK(nextChar)) break;
        end++;
      }
    }

    const result = messageText.slice(start, end);

    // Safety: for pure CJK text, never expand beyond original selection
    const isPureCJK = [...trimmed].every(c => this.isCJK(c) || /[\s，。！？、；：""''（）【】]/.test(c));
    if (isPureCJK && result.length > trimmed.length) {
      return trimmed;
    }

    return result;
  },

  /**
   * Find position by matching start and end fragments of the selection
   * Useful when selection contains partial words that don't match exactly
   */
  findByFragments(text, messageText) {
    const words = text.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return -1;

    // Get first few and last few characters of first/last words
    const firstWord = words[0];
    const lastWord = words[words.length - 1];

    // Try to find a unique middle portion that definitely exists
    if (words.length >= 3) {
      // Use middle words as anchor
      const middleWords = words.slice(1, -1).join(' ');
      const middlePos = messageText.indexOf(middleWords);
      if (middlePos !== -1) {
        // Found middle, now search backward for start
        const searchStart = Math.max(0, middlePos - 100);
        const beforeMiddle = messageText.slice(searchStart, middlePos);

        // Find where the first word fragment appears before middle
        for (let len = firstWord.length; len >= 2; len--) {
          const fragment = firstWord.slice(-len); // End of first word
          const fragPos = beforeMiddle.lastIndexOf(fragment);
          if (fragPos !== -1) {
            // Found the fragment, now find the start of this word
            let wordStart = searchStart + fragPos;
            while (wordStart > 0 && !/\s/.test(messageText[wordStart - 1])) {
              wordStart--;
            }
            return wordStart;
          }
        }
        // Fallback: just return a position before middle
        return searchStart;
      }
    }

    // Try finding by first word fragment + space + next word
    if (words.length >= 2) {
      const secondWord = words[1];
      // Look for patterns like "art of" -> find " of" and work backward
      const pattern = ' ' + secondWord;
      let searchPos = 0;
      while ((searchPos = messageText.indexOf(pattern, searchPos)) !== -1) {
        // Check if first word fragment is just before this
        const beforeSpace = messageText.slice(Math.max(0, searchPos - 20), searchPos);
        if (beforeSpace.endsWith(firstWord) || beforeSpace.includes(firstWord)) {
          // Find the start of the word containing firstWord
          let start = searchPos - 1;
          while (start > 0 && !/\s/.test(messageText[start - 1])) {
            start--;
          }
          return start;
        }
        searchPos++;
      }
    }

    // Last resort: find the longest fragment that exists
    for (let len = Math.min(text.length, 30); len >= 5; len--) {
      const fragment = text.slice(0, len);
      const pos = messageText.indexOf(fragment);
      if (pos !== -1) {
        return pos;
      }
    }

    return -1;
  },

  /**
   * Create an anchor from a selection within a message
   */
  createAnchor(selection, messageElement, messageText) {
    if (!selection || selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);

    // Expand selection to full words and full equations
    const quoteExact = this.expandSelection(selection, messageText);

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
   * Check if a node should be skipped (same as what getTextContent removes)
   */
  shouldSkipNode(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el) {
      // Skip KaTeX MathML (duplicate)
      if (el.classList?.contains('katex-mathml')) return true;
      // Skip MathJax assistive MML (duplicate)
      if (el.tagName?.toLowerCase() === 'mjx-assistive-mml') return true;
      // Skip aria-hidden elements (but not katex-html which is visible)
      if (el.getAttribute?.('aria-hidden') === 'true' && !el.classList?.contains('katex-html')) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  },

  /**
   * Create a DOM range for highlighting an anchor
   */
  createRangeForAnchor(anchor, messageElement) {
    const messageText = window.JAL.Utils.getTextContent(messageElement);
    const result = this.reanchor(anchor, messageText);

    if (!result.success) return null;

    // Use a filtered TreeWalker that skips the same elements as getTextContent
    const walker = document.createTreeWalker(
      messageElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          return this.shouldSkipNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        }
      }
    );

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

      // Verify range matches expected quote length, adjust if too long (CJK fix)
      const rangeText = range.toString();
      const expectedLen = anchor.quoteExact.length;
      if (rangeText.length > expectedLen && endOffset > 0) {
        const excess = rangeText.length - expectedLen;
        const newEndOffset = Math.max(0, endOffset - excess);
        range.setEnd(endNode, newEndOffset);
      }

      return range;
    } catch (e) {
      console.warn('JAL: Failed to create range', e);
      return null;
    }
  }
};

console.log('JAL Anchoring loaded');
